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
 */
export interface QuasarLogger {
	error(payload: { err: unknown; connection: string }, message: string): void;
}

/**
 * Callbacks accepted by `subscribe` / `psubscribe`, for Adonis parity.
 *
 * Named deviation: Adonis' `subscribe` returns void and reports failure ONLY
 * through `onError`, so a caller that passes no options never learns the
 * subscription failed. Ours also rejects, so `await connection.subscribe(...)`
 * surfaces the error on its own — an app that never opts into `onError` cannot
 * end up silently unsubscribed. `onError` still fires, so Adonis code keeps
 * working unchanged.
 */
export interface PubSubOptions {
	onError?(error: unknown): void;
	onSubscription?(count: number): void;
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
/** Called with each message matching a subscribed pattern. */
export type PatternHandler = (
	message: string,
	channel: string,
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
	#logErrors = true;
	readonly #logger: QuasarLogger | undefined;

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

	/** Adonis names it `connectionName`; both spellings work. */
	get connectionName(): string {
		return this.name;
	}

	/** The last error ioredis reported, cleared once the connection is ready. */
	get lastError(): unknown {
		return this.#lastError;
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
			throw error;
		}
		const handlers = this.#channels.get(channel);
		if (handlers) handlers.add(handler);
		else this.#channels.set(channel, new Set([handler]));
		options?.onSubscription?.(count);
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
			throw error;
		}
		const handlers = this.#patterns.get(pattern);
		if (handlers) handlers.add(handler);
		else this.#patterns.set(pattern, new Set([handler]));
		options?.onSubscription?.(count);
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
			[this.#client, this.#subscriber]
				.filter(isPresent)
				.map((client) => client.quit()),
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
		if (this.#logger) this.#logger.error(payload, "Redis connection failure");
		else console.error("[redis] connection failure", payload);
	}

	#ensureSubscriber(): RedisClient {
		if (this.#subscriber) return this.#subscriber;

		const subscriber = makeClient(this.#config);
		subscriber.on("message", (channel: string, message: string) => {
			for (const handler of this.#channels.get(channel) ?? []) {
				void handler(message, channel);
			}
		});
		subscriber.on(
			"pmessage",
			(pattern: string, channel: string, message: string) => {
				for (const handler of this.#patterns.get(pattern) ?? []) {
					void handler(message, channel, pattern);
				}
			},
		);
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
