/**
 * One Redis connection: the commands, plus pub/sub on a second socket.
 *
 * Redis puts a subscribed client into a mode where it accepts nothing but
 * (p)subscribe/(p)unsubscribe — so a connection that both publishes and
 * listens needs two sockets. That second one is opened lazily, on the first
 * subscribe, and never at all for a connection that only runs commands.
 *
 * The ioredis client is reachable as `.client`; every ioredis command is also
 * callable straight on the connection (`connection.get('key')`), so switching
 * between the two costs nothing.
 */

import { Cluster, Redis } from "ioredis";
import {
	type ConnectionConfig,
	isClusterConfig,
	type RedisClient,
} from "./config.js";

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
 * The subscriber socket's lifecycle, re-emitted as `subscriber:<name>` — the
 * names Adonis uses. `message`/`pmessage` are NOT here: those are delivered to
 * the registered handlers, not to listeners.
 */
const SUBSCRIBER_EVENTS = [
	"connect",
	"ready",
	"error",
	"close",
	"reconnecting",
	"end",
] as const;

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

// Merging the ioredis surface in is what makes `connection.get(...)` type-check
// without re-declaring 200 command signatures. The methods exist at runtime —
// #forward routes them to the client — so the merge describes what is really
// there. Same generated-method pattern as ream's ApiResponse.
export interface QuasarConnection
	extends Omit<
		Redis,
		| "subscribe"
		| "unsubscribe"
		| "psubscribe"
		| "punsubscribe"
		| "publish"
		| "quit"
		| "disconnect"
		// Ours widens ioredis': a Cluster also reports "disconnecting", and this
		// class fronts both. Adonis types it the same widened way.
		| "status"
	> {}

export class QuasarConnection {
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
		this.name = name;
		this.#config = config;
		this.#logger = logger;
		this.#client = makeClient(config);
		// Remembered rather than thrown: ioredis reconnects on its own, and a
		// connection that recovered should not keep reporting the old failure.
		this.#client.on("error", (error: unknown) => {
			this.#lastError = error;
			if (this.#logErrors) this.#report(error);
		});
		this.#client.on("ready", () => {
			this.#lastError = undefined;
		});
		this.#forward();
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

	isConnecting(): boolean {
		return this.status === "connecting";
	}

	isReady(): boolean {
		return this.status === "ready";
	}

	isClosed(): boolean {
		return this.status === "end";
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
	 */
	async subscribe(
		channel: string,
		handler: ChannelHandler,
		options?: PubSubOptions,
	): Promise<void> {
		const subscriber = this.#ensureSubscriber();
		let count: number;
		try {
			count = toCount(await subscriber.subscribe(channel));
		} catch (error) {
			options?.onError?.(error);
			this.#client.emit("subscription:error", { connection: this, error });
			if (this.#logErrors) this.#report(error);
			return;
		}
		const handlers = this.#channels.get(channel);
		if (handlers) handlers.add(handler);
		else this.#channels.set(channel, new Set([handler]));
		options?.onSubscription?.(count);
		this.#client.emit("subscription:ready", { connection: this, count });
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

	/** Listen to every channel matching a glob pattern (`user:*`). */
	async psubscribe(
		pattern: string,
		handler: PatternHandler,
		options?: PubSubOptions,
	): Promise<void> {
		const subscriber = this.#ensureSubscriber();
		let count: number;
		try {
			count = toCount(await subscriber.psubscribe(pattern));
		} catch (error) {
			options?.onError?.(error);
			this.#client.emit("psubscription:error", { connection: this, error });
			if (this.#logErrors) this.#report(error);
			return;
		}
		const handlers = this.#patterns.get(pattern);
		if (handlers) handlers.add(handler);
		else this.#patterns.set(pattern, new Set([handler]));
		options?.onSubscription?.(count);
		this.#client.emit("psubscription:ready", { connection: this, count });
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
		await Promise.all(
			[this.#client, this.#subscriber].filter(isPresent).map(quitClient),
		);
		this.#subscriber = undefined;
	}

	/**
	 * Drop both sockets now, without waiting for in-flight commands. Async to
	 * match Adonis, even though ioredis' own `disconnect` is synchronous — a
	 * caller that awaits it must keep working after switching the import.
	 */
	async disconnect(): Promise<void> {
		this.#client.disconnect();
		this.#subscriber?.disconnect();
		this.#subscriber = undefined;
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
		// Re-emit the subscriber socket's lifecycle under Adonis' `subscriber:`
		// names. Without this a pub/sub connection that drops is invisible: the
		// socket is created lazily and internally, so an app cannot attach a
		// listener to it before the first subscribe, and `error` on a socket
		// with no listener crashes the process.
		//
		// They go out on the COMMAND client's emitter because that is what
		// `connection.on(...)` forwards to — one listener surface, not two.
		for (const event of SUBSCRIBER_EVENTS) {
			subscriber.on(event, (...args: unknown[]) => {
				if (event === "error") this.#lastSubscriberError = args[0];
				this.#client.emit(`subscriber:${event}`, ...args);
			});
		}
		// Report it too, the way a command-socket error is reported. The loop
		// above already keeps the process alive — attaching any listener to
		// `error` is what stops an EventEmitter from throwing — so this one is
		// purely about the failure reaching the logger.
		subscriber.on("error", (error: unknown) => {
			if (this.#logErrors) this.#report(error);
		});
		// `end` is ioredis giving up for good, not one failed attempt. The
		// socket is cached, so keeping it means the next subscribe reuses an
		// ended one — every command on it rejects and the application simply
		// stops receiving, with the failure reported through `onError` as if
		// the channel were at fault. Dropping it, and the subscriptions that
		// only existed on it, is what makes the next subscribe open a live
		// socket. Adonis does the same, for the same reason.
		subscriber.on("end", () => {
			if (this.#subscriber !== subscriber) return;
			this.#subscriber = undefined;
			this.#channels.clear();
			this.#patterns.clear();
		});

		this.#subscriber = subscriber;
		return subscriber;
	}

	/**
	 * Bind every ioredis command onto this instance, once, in the constructor.
	 * Binding beats a Proxy here: `connection.get` stays a plain function, so it
	 * can be destructured, passed around, or stubbed like any other method.
	 */
	#forward(): void {
		const client = this.#client;
		const own = new Set(Object.getOwnPropertyNames(QuasarConnection.prototype));
		for (const key of commandNames(client)) {
			if (own.has(key) || key.startsWith("_") || key in this) continue;
			Reflect.set(this, key, Reflect.get(client, key).bind(client));
		}
	}
}

/**
 * ioredis types (p)subscribe's result as `unknown` across the Redis|Cluster
 * union, though it is the subscription count. Narrowed rather than cast.
 */
function toCount(value: unknown): number {
	return typeof value === "number" ? value : 0;
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

function makeClient(config: ConnectionConfig): RedisClient {
	if (isClusterConfig(config)) {
		return new Cluster(config.clusters, config.clusterOptions);
	}
	const { url, ...options } = config;
	return url === undefined ? new Redis(options) : new Redis(url, options);
}

/** Every callable ioredis owns, walking up its prototype chain. */
function commandNames(client: RedisClient): string[] {
	const names = new Set<string>();
	for (
		let target: object | null = client;
		target !== null && target !== Object.prototype;
		target = Object.getPrototypeOf(target)
	) {
		for (const key of Object.getOwnPropertyNames(target)) {
			if (typeof Reflect.get(target, key, client) === "function")
				names.add(key);
		}
	}
	return [...names];
}
