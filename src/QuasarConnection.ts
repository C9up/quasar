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
	> {}

export class QuasarConnection {
	readonly name: string;
	readonly #config: ConnectionConfig;
	readonly #client: RedisClient;
	#subscriber: RedisClient | undefined;
	readonly #channels = new Map<string, ChannelHandler>();
	readonly #patterns = new Map<string, PatternHandler>();

	constructor(name: string, config: ConnectionConfig) {
		this.name = name;
		this.#config = config;
		this.#client = makeClient(config);
		this.#forward();
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
	 * calls reuse it. Re-subscribing to a channel replaces its handler rather
	 * than stacking a second one — a reload should not double-deliver.
	 */
	async subscribe(channel: string, handler: ChannelHandler): Promise<void> {
		const subscriber = this.#ensureSubscriber();
		this.#channels.set(channel, handler);
		await subscriber.subscribe(channel);
	}

	/** Stop listening to a channel and drop its handler. */
	async unsubscribe(channel: string): Promise<void> {
		this.#channels.delete(channel);
		if (this.#subscriber) await this.#subscriber.unsubscribe(channel);
	}

	/** Listen to every channel matching a glob pattern (`user:*`). */
	async psubscribe(pattern: string, handler: PatternHandler): Promise<void> {
		const subscriber = this.#ensureSubscriber();
		this.#patterns.set(pattern, handler);
		await subscriber.psubscribe(pattern);
	}

	/** Stop listening to a pattern and drop its handler. */
	async punsubscribe(pattern: string): Promise<void> {
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

	/** Drop both sockets now, without waiting for in-flight commands. */
	disconnect(): void {
		this.#client.disconnect();
		this.#subscriber?.disconnect();
		this.#subscriber = undefined;
	}

	#ensureSubscriber(): RedisClient {
		if (this.#subscriber) return this.#subscriber;

		const subscriber = makeClient(this.#config);
		subscriber.on("message", (channel: string, message: string) => {
			void this.#channels.get(channel)?.(message, channel);
		});
		subscriber.on(
			"pmessage",
			(pattern: string, channel: string, message: string) => {
				void this.#patterns.get(pattern)?.(message, channel, pattern);
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
