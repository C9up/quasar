/**
 * One Redis connection: the commands, plus pub/sub on a second socket.
 *
 * Redis puts a subscribed client into a mode where it accepts nothing but
 * (p)subscribe/(p)unsubscribe — so a connection that both publishes and
 * listens needs two sockets. That second one is opened lazily, on the first
 * subscribe, and never at all for a connection that only runs commands.
 *
 * The ioredis client is reachable as `.ioConnection`; the Redis commands are
 * also callable straight on the connection (`connection.get('key')`), so
 * switching between the two costs nothing.
 */

import { Cluster, Redis, type RedisOptions } from "ioredis";
import {
	type ConnectionConfig,
	type Credential,
	isClusterConfig,
	type RedisClient,
} from "./config.js";
import { Emitter } from "./emitter.js";
import { REDIS_METHODS } from "./methods.js";

/**
 * Where connection errors are reported. Structural on purpose: quasar is a leaf
 * and must not import a framework logger. Adonis takes a required `Logger`; here
 * it is optional and falls back to the console, so the package stands alone.
 *
 * NAMED DEVIATION from Adonis' signature: Adonis' logger is pino, so it takes
 * `error(payload, message)`. Ream's takes `error(message, data)`, and that is
 * the shape a ream app can actually satisfy — declared the other way round,
 * this was a parameter no logger in this universe fit, and the provider passed
 * none at all.
 */
export interface QuasarLogger {
	error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Callbacks accepted by `subscribe` / `psubscribe`, exactly as Adonis takes
 * them.
 *
 * A failed subscription does NOT reject: Adonis' `subscribe` returns void, so
 * code written against it never awaits the call, and a rejection nobody
 * handles takes the process down — the opposite of what a resilience feature
 * should do. Failure is reported the way Adonis reports it (`onError`, then
 * the `subscription:error` event) and, unlike Adonis, also through the
 * connection logger, so an app that wires neither still sees it.
 */
export interface PubSubOptions {
	onError?(error: unknown): void;
	onSubscription?(count: number): void;
}

/**
 * What a connection emits, with upstream's payloads: always the connection,
 * plus what the event is about. The `subscriber:` events are the pub/sub
 * socket's lifecycle — that socket is internal and opened lazily, so nothing
 * outside could listen to it otherwise. `message`/`pmessage` are not here:
 * those are delivered to the registered handlers.
 */
export interface QuasarConnectionEvents {
	connect: { connection: QuasarConnection };
	wait: { connection: QuasarConnection };
	ready: { connection: QuasarConnection };
	error: { error: unknown; connection: QuasarConnection };
	close: { connection: QuasarConnection };
	reconnecting: { connection: QuasarConnection; waitTime: number };
	end: { connection: QuasarConnection };
	"subscriber:connect": { connection: QuasarConnection };
	"subscriber:ready": { connection: QuasarConnection };
	"subscriber:error": { error: unknown; connection: QuasarConnection };
	"subscriber:close": { connection: QuasarConnection };
	"subscriber:reconnecting": {
		connection: QuasarConnection;
		waitTime: number;
	};
	"subscriber:end": { connection: QuasarConnection };
	"node:added": { connection: QuasarConnection; node: Redis };
	"node:removed": { connection: QuasarConnection; node: Redis };
	"node:error": {
		error: unknown;
		address: string;
		connection: QuasarConnection;
	};
	"subscription:ready": { connection: QuasarConnection; count: number };
	"subscription:error": { connection: QuasarConnection; error: unknown };
	"psubscription:ready": { connection: QuasarConnection; count: number };
	"psubscription:error": { connection: QuasarConnection; error: unknown };
}

/** A LUA script registered as a command through `defineCommand`. */
export interface ScriptDefinition {
	lua: string;
	numberOfKeys?: number;
	readOnly?: boolean;
}

/** Called with each message published to a subscribed channel. */
export type ChannelHandler = (
	message: string,
	channel: string,
) => void | Promise<void>;
/**
 * Called with each message matching a subscribed pattern.
 *
 * `(channel, message)` is Adonis' order, and it is deliberately NOT the
 * `(message, channel)` of a plain channel handler: a pattern handler is called
 * for channels it never named, so which one arrived is the first thing it
 * needs. Getting the two the wrong way round is silent — both are strings —
 * which is why this follows upstream rather than local symmetry.
 *
 * The pattern is passed third, a superset of Adonis, which stops at two: a
 * handler registered for several patterns cannot otherwise tell them apart.
 */
export type PatternHandler = (
	channel: string,
	message: string,
	pattern: string,
) => void | Promise<void>;

/** The commands forwarded onto a connection that ioredis' types know. */
type ConnectionCommand = Extract<(typeof REDIS_METHODS)[number], keyof Redis>;

// Merging the ioredis commands in is what makes `connection.get(...)`
// type-check without re-declaring 300 command signatures. The methods exist at
// runtime — #forward binds them from the client — so the merge describes what
// is really there. Same generated-method pattern as ream's ApiResponse.
export interface QuasarConnection extends Pick<Redis, ConnectionCommand> {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface above describes the commands #forward installs
export class QuasarConnection extends Emitter<QuasarConnectionEvents> {
	readonly name: string;
	readonly #config: ConnectionConfig;
	readonly #client: RedisClient;
	#subscriber: RedisClient | undefined;
	// A SET of handlers per channel, not one: Adonis lets two modules listen to
	// the same channel and delivers to both. Keeping one would make the second
	// subscribe silently stop the first — the worst kind of migration bug.
	readonly #channels = new Map<string, Set<ChannelHandler>>();
	readonly #patterns = new Map<string, Set<PatternHandler>>();
	#lastError: unknown;
	#lastSubscriberError: unknown;
	#logErrors = true;
	#logger: QuasarLogger | undefined;

	constructor(name: string, config: ConnectionConfig, logger?: QuasarLogger) {
		super();
		this.name = name;
		this.#config = config;
		this.#logger = logger;
		this.#client = makeClient(config);
		this.#monitor();
		this.#forward();
	}

	/**
	 * Re-emit the client's lifecycle with upstream's payloads.
	 *
	 * Quasar's own bookkeeping listens on the ioredis client directly, and
	 * applications listen here: nothing reachable from this class can detach
	 * the error recorder, whose absence would let one `error` event crash the
	 * process.
	 */
	#monitor(): void {
		const client = this.#client;
		// Remembered rather than thrown: ioredis reconnects on its own, and a
		// connection that recovered should not keep reporting the old failure.
		client.on("error", (error: unknown) => {
			this.#lastError = error;
			if (this.#logErrors) this.#report(error);
			this.notify("error", { error, connection: this });
		});
		client.on("ready", () => {
			this.#lastError = undefined;
			this.notify("ready", { connection: this });
		});
		client.on("connect", () => this.notify("connect", { connection: this }));
		client.on("wait", () => this.notify("wait", { connection: this }));
		client.on("close", () => this.notify("close", { connection: this }));
		client.on("end", () => this.notify("end", { connection: this }));
		client.on("reconnecting", (waitTime: number) =>
			this.notify("reconnecting", { connection: this, waitTime }),
		);
		// Cluster only.
		client.on("+node", (node: Redis) =>
			this.notify("node:added", { connection: this, node }),
		);
		client.on("-node", (node: Redis) =>
			this.notify("node:removed", { connection: this, node }),
		);
		client.on("node error", (error: unknown, address: string) =>
			this.notify("node:error", { error, address, connection: this }),
		);
	}

	/** A listener of this connection's events failed: report it like an error. */
	protected override listenerFailed(error: unknown): void {
		this.#report(error);
	}

	/**
	 * Report through this logger from now on.
	 *
	 * Connections open lazily and a framework logger is resolved from a
	 * container asynchronously, so the two cannot always be ordered — the
	 * provider hands one over once it has it.
	 */
	useLogger(logger: QuasarLogger): this {
		this.#logger = logger;
		return this;
	}

	/** Adonis names it `connectionName`; both spellings work. */
	get connectionName(): string {
		return this.name;
	}

	/** The last error ioredis reported, cleared once the connection is ready. */
	get lastError(): unknown {
		return this.#lastError;
	}

	/** The last error the pub/sub socket reported, if one was ever opened. */
	get lastSubscriberError(): unknown {
		return this.#lastSubscriberError;
	}

	/** ioredis' own connection status. */
	get status(): RedisClient["status"] {
		return this.#client.status;
	}

	/** The subscriber socket's status, `undefined` until one is opened. */
	get subscriberStatus(): RedisClient["status"] | undefined {
		return this.#subscriber?.status;
	}

	/** How many commands are queued by ioredis' auto-pipelining. */
	get autoPipelineQueueSize(): number {
		return this.#client.autoPipelineQueueSize;
	}

	/** Dialling, or waiting between two reconnect attempts. */
	isConnecting(): boolean {
		return this.status === "connecting" || this.status === "reconnecting";
	}

	/** Connected — `connect` is the moment before the ready check answers. */
	isReady(): boolean {
		return this.status === "ready" || this.status === "connect";
	}

	/** Closed: for now (`close`, a reconnect may follow) or for good (`end`). */
	isClosed(): boolean {
		return this.status === "end" || this.status === "close";
	}

	/** Register a LUA script as a command, callable through {@link runCommand}. */
	defineCommand(name: string, definition: ScriptDefinition): this {
		this.#client.defineCommand(name, definition);
		return this;
	}

	/**
	 * Run a command registered with {@link defineCommand}. Untyped by nature —
	 * the command is named at runtime and its result is whatever the script
	 * returns.
	 */
	runCommand(command: string, ...args: unknown[]): unknown {
		const run = Reflect.get(this.#client, command);
		if (typeof run !== "function") {
			throw new Error(
				`[redis] no command "${command}" on connection "${this.name}" — define it with defineCommand() first`,
			);
		}
		return Reflect.apply(run, this.#client, args);
	}

	/**
	 * Stop reporting connection errors through the logger. ioredis emits `error`
	 * whatever we do, and an `error` event with no listener crashes the process,
	 * so the recorder below stays attached — only the reporting stops.
	 */
	doNotLogErrors(): this {
		this.#logErrors = false;
		return this;
	}

	/**
	 * The ioredis client, for anything this class does not wrap. Named after
	 * Adonis' `ioConnection` rather than `client`, because CLIENT is itself a
	 * Redis command and the merged surface already carries it.
	 */
	get ioConnection(): RedisClient {
		return this.#client;
	}

	/** The pub/sub socket, once a subscribe has opened it. */
	get ioSubscriberConnection(): RedisClient | undefined {
		return this.#subscriber;
	}

	/**
	 * Listen to a channel. The first call opens the subscriber socket; later
	 * calls reuse it. Subscribing twice STACKS the handlers — both are called,
	 * matching Adonis.
	 *
	 * Answers `void`, as upstream does. It used to answer `Promise<void>`, and
	 * that promise was worse than none: the catch below RESOLVES it, so
	 * `await subscribe(...)` completed just the same when the subscription had
	 * failed. It looked like a guarantee and was not one.
	 *
	 * Failure arrives through `onError`, the `subscription:error` event and the
	 * connection logger. When you need to know the subscription is live before
	 * the next line runs, use {@link subscribed}.
	 */
	subscribe(
		channel: string,
		handler: ChannelHandler,
		options?: PubSubOptions,
	): void {
		void this.#subscribeChannel(channel, handler, options);
	}

	/**
	 * `subscribe`, awaitable — a named Ream addition, not upstream's shape.
	 *
	 * Resolves once the channel is live and REJECTS if it could not be
	 * subscribed, so awaiting it means what awaiting should mean. `onError`
	 * still fires, so a caller can have both.
	 */
	async subscribed(
		channel: string,
		handler: ChannelHandler,
		options?: PubSubOptions,
	): Promise<void> {
		await this.#subscribeChannel(channel, handler, options, true);
	}

	/**
	 * The subscription itself. `rethrow` is what separates the two entry
	 * points: reporting is identical, only the caller's ability to see the
	 * failure differs.
	 */
	async #subscribeChannel(
		channel: string,
		handler: ChannelHandler,
		options: PubSubOptions | undefined,
		rethrow = false,
	): Promise<void> {
		const subscriber = this.#ensureSubscriber();
		// Registered BEFORE the ack is awaited. ioredis resolves the SUBSCRIBE
		// while parsing a reply chunk and emits the messages that follow in
		// that chunk synchronously, so a handler added after the `await` misses
		// them. NAMED DEVIATION: upstream registers after the ack and drops them.
		const added = register(this.#channels, channel, handler);
		let count: number;
		try {
			count = toCount(await subscriber.subscribe(channel));
		} catch (error) {
			if (added) unregister(this.#channels, channel, handler);
			options?.onError?.(error);
			this.notify("subscription:error", { connection: this, error });
			if (this.#logErrors) this.#report(error);
			if (rethrow) throw error;
			return;
		}
		options?.onSubscription?.(count);
		this.notify("subscription:ready", { connection: this, count });
	}

	/**
	 * Listen to every channel matching a glob pattern (`user:*`). Answers
	 * `void`, as upstream does — see {@link subscribe}; {@link psubscribed} is
	 * the awaitable form.
	 */
	psubscribe(
		pattern: string,
		handler: PatternHandler,
		options?: PubSubOptions,
	): void {
		void this.#subscribePattern(pattern, handler, options);
	}

	/** `psubscribe`, awaitable and rejecting — see {@link subscribed}. */
	async psubscribed(
		pattern: string,
		handler: PatternHandler,
		options?: PubSubOptions,
	): Promise<void> {
		await this.#subscribePattern(pattern, handler, options, true);
	}

	async #subscribePattern(
		pattern: string,
		handler: PatternHandler,
		options: PubSubOptions | undefined,
		rethrow = false,
	): Promise<void> {
		const subscriber = this.#ensureSubscriber();
		// Before the ack, for the reason given in #subscribeChannel.
		const added = register(this.#patterns, pattern, handler);
		let count: number;
		try {
			count = toCount(await subscriber.psubscribe(pattern));
		} catch (error) {
			if (added) unregister(this.#patterns, pattern, handler);
			options?.onError?.(error);
			this.notify("psubscription:error", { connection: this, error });
			if (this.#logErrors) this.#report(error);
			if (rethrow) throw error;
			return;
		}
		options?.onSubscription?.(count);
		this.notify("psubscription:ready", { connection: this, count });
	}

	/**
	 * Stop listening to a channel. With a handler, only that one is dropped and
	 * the socket stays subscribed while others remain — leaving it subscribed is
	 * the point: another listener still wants the messages.
	 */
	async unsubscribe(channel: string, handler?: ChannelHandler): Promise<void> {
		if (handler) {
			const handlers = this.#channels.get(channel);
			handlers?.delete(handler);
			if (handlers && handlers.size > 0) return;
		}
		this.#channels.delete(channel);
		if (this.#subscriber) await this.#subscriber.unsubscribe(channel);
	}

	/** Stop listening to a pattern; with a handler, only that one is dropped. */
	async punsubscribe(pattern: string, handler?: PatternHandler): Promise<void> {
		if (handler) {
			const handlers = this.#patterns.get(pattern);
			handlers?.delete(handler);
			if (handlers && handlers.size > 0) return;
		}
		this.#patterns.delete(pattern);
		if (this.#subscriber) await this.#subscriber.punsubscribe(pattern);
	}

	/** Publish on the command socket — publishing never needs the subscriber. */
	async publish(channel: string, message: string): Promise<number> {
		return this.#client.publish(channel, message);
	}

	/** Close both sockets with QUIT, letting in-flight commands finish. */
	async quit(): Promise<void> {
		retire(this);
		const sockets = [this.#client, this.#subscriber].filter(isPresent);
		this.#dropSubscriptions();
		await Promise.all(sockets.map(quitClient));
	}

	/**
	 * Drop both sockets now, without waiting for in-flight commands. Async to
	 * match Adonis, even though ioredis' own `disconnect` is synchronous — a
	 * caller that awaits it must keep working after switching the import.
	 */
	async disconnect(): Promise<void> {
		retire(this);
		this.#client.disconnect();
		this.#subscriber?.disconnect();
		this.#dropSubscriptions();
	}

	/**
	 * Forget the subscriber socket and every handler that lived on it.
	 *
	 * Done here and not only in the socket's `end` listener: that listener
	 * ignores a socket that is no longer the current one — which, once this
	 * method has run, it is not — so the handlers outlived the close and a
	 * later subscribe on a fresh socket revived them. Upstream clears them on
	 * `end` unconditionally.
	 */
	#dropSubscriptions(): void {
		this.#subscriber = undefined;
		this.#channels.clear();
		this.#patterns.clear();
	}

	/**
	 * Where a connection error goes when nothing else handles it. Kept as one
	 * place so `doNotLogErrors()` has a single thing to switch off.
	 */
	#report(error: unknown): void {
		const payload = { err: error, connection: this.name };
		if (this.#logger) this.#logger.error("Redis connection failure", payload);
		else console.error("[redis] connection failure", payload);
	}

	/**
	 * Run one subscriber handler with nothing able to escape it.
	 *
	 * A handler that rejects has nobody to reject to — this is an event
	 * callback, not an awaited call — so an unhandled rejection took the
	 * process down on some runtimes and vanished on others. It is reported the
	 * way a connection failure is, and the other handlers still run.
	 *
	 * `Promise.resolve(handler(...))` was not enough: the handler is CALLED
	 * before the promise exists, so a synchronous `throw` never reached the
	 * `.catch` — it unwound the `for` loop and escaped into the Redis client's
	 * own callback, and every handler after it on that channel was skipped.
	 * Invoking inside the async function is what puts both failures on the
	 * same path.
	 */
	#dispatch(run: () => unknown): void {
		void (async () => run())().catch((error: unknown) => this.#report(error));
	}

	#ensureSubscriber(): RedisClient {
		if (this.#subscriber) return this.#subscriber;

		const subscriber = makeClient(this.#config);
		subscriber.on("message", (channel: string, message: string) => {
			for (const handler of this.#channels.get(channel) ?? []) {
				this.#dispatch(() => handler(message, channel));
			}
		});
		subscriber.on(
			"pmessage",
			(pattern: string, channel: string, message: string) => {
				for (const handler of this.#patterns.get(pattern) ?? []) {
					this.#dispatch(() => handler(channel, message, pattern));
				}
			},
		);
		// Re-emit the subscriber socket's lifecycle under Adonis' names, with
		// its payloads. Without this a pub/sub connection that drops is
		// invisible: the socket is created lazily and internally, so an app
		// cannot attach a listener to it before the first subscribe.
		subscriber.on("connect", () =>
			this.notify("subscriber:connect", { connection: this }),
		);
		subscriber.on("ready", () =>
			this.notify("subscriber:ready", { connection: this }),
		);
		subscriber.on("close", () =>
			this.notify("subscriber:close", { connection: this }),
		);
		subscriber.on("end", () =>
			this.notify("subscriber:end", { connection: this }),
		);
		subscriber.on("reconnecting", (waitTime: number) =>
			this.notify("subscriber:reconnecting", { connection: this, waitTime }),
		);
		// Recorded and reported like a command-socket error. Attaching it is
		// also what stops ioredis' emitter from throwing on an `error` with no
		// listener.
		subscriber.on("error", (error: unknown) => {
			this.#lastSubscriberError = error;
			if (this.#logErrors) this.#report(error);
			this.notify("subscriber:error", { error, connection: this });
		});
		// `end` is ioredis giving up for good, not one failed attempt. The
		// socket is cached, so keeping it means the next subscribe reuses an
		// ended one — every command on it rejects and the application simply
		// stops receiving, with the failure reported through `onError` as if
		// the channel were at fault. Dropping it, and the subscriptions that
		// only existed on it, is what makes the next subscribe open a live
		// socket. Adonis does the same, for the same reason.
		subscriber.on("end", () => {
			// A late `end` from a socket already replaced must not wipe the
			// handlers its successor holds.
			if (this.#subscriber !== subscriber) return;
			this.#dropSubscriptions();
		});

		this.#subscriber = subscriber;
		return subscriber;
	}

	/**
	 * Bind the Redis commands onto this instance, once, in the constructor.
	 * Binding beats a Proxy here: `connection.get` stays a plain function, so it
	 * can be destructured, passed around, or stubbed like any other method.
	 *
	 * An explicit list, upstream's: see `methods.ts` for what walking the
	 * prototype chain used to let through. A command the client does not have
	 * (a cluster has no `monitor`) is simply not installed.
	 */
	#forward(): void {
		const client = this.#client;
		for (const key of REDIS_METHODS) {
			if (key in this) continue;
			const command: unknown = Reflect.get(client, key);
			if (typeof command !== "function") continue;
			Reflect.set(this, key, command.bind(client));
		}
	}
}

/**
 * Connections that were closed on purpose — through `quit()`/`disconnect()`,
 * or dropped by the manager once their socket ended. A health check must not
 * dial one again: nothing tracks it any more, so the socket it opened would
 * outlive the next `quitAll()` and hold the process open. Module-private so
 * it stays off the public surface; the manager and the checks reach it
 * through the two functions below.
 */
const retired = new WeakSet<object>();

export function retire(connection: QuasarConnection): void {
	retired.add(connection);
}

export function isRetired(connection: object): boolean {
	return retired.has(connection);
}

/**
 * ioredis types (p)subscribe's result as `unknown` across the Redis|Cluster
 * union, though it is the subscription count. Narrowed rather than cast.
 */
function toCount(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/**
 * Add a handler under a key; true when it was not there yet. A failed
 * subscribe rolls back only what it added itself, so retrying a handler that
 * is already live does not unsubscribe it.
 */
function register<Handler>(
	registry: Map<string, Set<Handler>>,
	key: string,
	handler: Handler,
): boolean {
	const handlers = registry.get(key);
	if (handlers === undefined) {
		registry.set(key, new Set([handler]));
		return true;
	}
	if (handlers.has(handler)) return false;
	handlers.add(handler);
	return true;
}

function unregister<Handler>(
	registry: Map<string, Set<Handler>>,
	key: string,
	handler: Handler,
): void {
	const handlers = registry.get(key);
	if (handlers === undefined) return;
	handlers.delete(handler);
	if (handlers.size === 0) registry.delete(key);
}

function isPresent(client: RedisClient | undefined): client is RedisClient {
	return client !== undefined;
}

/**
 * QUIT one socket, or the nearest thing its status allows. Both guards are
 * Adonis', and both matter on the path that always runs: shutdown.
 *
 * `wait` has never dialled — a lazily configured connection nothing ever used.
 * QUIT is a command, so sending it would open a connection for the sole purpose
 * of closing it, against a server that on a shutdown path may already be gone.
 *
 * `end` is already closed, and ioredis REJECTS every command issued on one
 * ("Connection is closed."). That rejection travelled up through `Promise.all`
 * and out of the provider's `shutdown`, so one socket that had died on its own
 * aborted the shutdown of every other.
 */
async function quitClient(client: RedisClient): Promise<void> {
	if (client.status === "wait") {
		client.disconnect();
		return;
	}
	if (client.status === "end") return;
	await client.quit();
}

/**
 * Build an ioredis client from a config, on a copy: the port read from an env
 * file becomes a number and Secret passwords are released here, at the last
 * moment, so the config itself keeps them wrapped. Upstream does the same
 * normalisation, but in place.
 */
function makeClient(config: ConnectionConfig): RedisClient {
	if (isClusterConfig(config)) {
		const { redisOptions, ...clusterOptions } = config.clusterOptions ?? {};
		if (redisOptions === undefined) {
			return new Cluster(config.clusters, clusterOptions);
		}
		const { password, sentinelPassword, ...nodeOptions } = redisOptions;
		return new Cluster(config.clusters, {
			...clusterOptions,
			redisOptions: {
				...nodeOptions,
				...credentials(password, sentinelPassword),
			},
		});
	}
	const { url, port, password, sentinelPassword, ...rest } = config;
	const options: RedisOptions = {
		...rest,
		...(port === undefined ? {} : { port: toPort(port) }),
		...credentials(password, sentinelPassword),
	};
	return url === undefined ? new Redis(options) : new Redis(url, options);
}

/** The released passwords, each present only when it was configured. */
function credentials(
	password: Credential | undefined,
	sentinelPassword: Credential | undefined,
): { password?: string; sentinelPassword?: string } {
	return {
		...(password === undefined ? {} : { password: release(password) }),
		...(sentinelPassword === undefined
			? {}
			: { sentinelPassword: release(sentinelPassword) }),
	};
}

function release(credential: Credential): string {
	return typeof credential === "string" ? credential : credential.release();
}

/**
 * A port, from a number or the string an env file holds.
 *
 * NAMED DEVIATION: upstream runs `Number(port)` and stops there, and ioredis
 * quietly dials its default port when handed NaN — a typo in REDIS_PORT then
 * reaches whatever listens on 6379. Anything that is not a whole port number
 * is refused instead.
 */
function toPort(port: string | number): number {
	const value =
		typeof port === "string" && port.trim() !== "" ? Number(port) : port;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 65_535
	) {
		throw new Error(`[redis] port "${String(port)}" is not a port number`);
	}
	return value;
}
