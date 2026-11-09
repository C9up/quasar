/**
 * The connections declared in `config/redis.ts`, opened on demand.
 *
 * `redis.connection()` hands back the default one, `redis.connection('cache')`
 * a named one. Each is built the first time it is asked for and kept, so two
 * call sites share one socket instead of opening a pair each.
 */

import { type InspectOptions, inspect } from "node:util";
import { Redis } from "ioredis";
import type { ConnectionConfig, QuasarConfig } from "./config.js";
import type {
	ChannelHandler,
	PatternHandler,
	PubSubOptions,
	QuasarLogger,
	ScriptDefinition,
} from "./QuasarConnection.js";
import { QuasarConnection, retire } from "./QuasarConnection.js";
import { redactConfig } from "./redact.js";

/**
 * What the service accessor stores: the manager seen structurally.
 *
 * `QuasarManager<C>` is generic over its declared connections, and a class with
 * private fields is invariant — so a manager built from a literal config could
 * not be assigned to `QuasarManager<Record<string, ConnectionConfig>>`. Seating
 * one must not require widening the config type at the call site.
 */
export interface QuasarService {
	readonly defaultConnectionName: string;
	readonly activeConnectionNames: string[];
	readonly activeConnections: Record<string, QuasarConnection>;
	readonly activeConnectionsCount: number;
	connection(name?: string): QuasarConnection;
	subscribe(channel: string, handler: ChannelHandler): void;
	subscribed(channel: string, handler: ChannelHandler): Promise<void>;
	unsubscribe(channel: string, handler?: ChannelHandler): Promise<void>;
	psubscribe(pattern: string, handler: PatternHandler): void;
	psubscribed(pattern: string, handler: PatternHandler): Promise<void>;
	punsubscribe(pattern: string, handler?: PatternHandler): Promise<void>;
	publish(channel: string, message: string): Promise<number>;
	defineCommand(name: string, definition: ScriptDefinition): QuasarService;
	runCommand(command: string, ...args: unknown[]): unknown;
	doNotLogErrors(): QuasarService;
	quit(name?: string): Promise<void>;
	disconnect(name?: string): Promise<void>;
	quitAll(): Promise<void>;
	disconnectAll(): Promise<void>;
}

/**
 * Every ioredis command is callable straight on the manager and runs on the
 * DEFAULT connection (`redis.get('key')`), the way Adonis does it — an app that
 * never names a connection does not have to reach for `.connection()` first.
 * The methods are installed on the prototype below; this merge describes them.
 */
export interface QuasarManager<
	Connections extends Record<string, ConnectionConfig>,
> extends Omit<Redis, ManagerOwnMethod | "status"> {
	/**
	 * The config this manager was built from — Adonis' `managerConfig`.
	 *
	 * NAMED DEVIATION: upstream keeps it as a public field, so serialising or
	 * inspecting the manager prints every password in it. Here it is a
	 * non-enumerable accessor over the private config — readable, but skipped
	 * by `JSON.stringify` and `Object.keys` — and `toJSON` / `util.inspect`
	 * print a redacted view instead.
	 */
	readonly managerConfig: QuasarConfig<Connections>;
}

/** What the manager defines itself, and must not have overwritten by a command. */
type ManagerOwnMethod =
	| "connection"
	| "useLogger"
	| "subscribe"
	| "unsubscribe"
	| "psubscribe"
	| "punsubscribe"
	| "publish"
	| "quit"
	| "disconnect"
	| "defineCommand"
	| "runCommand";

/*
 * The merge below IS the mechanism: the ioredis commands are installed on the
 * prototype at the bottom of this file, and the interface is what tells the
 * type system they are there. `QuasarConnection` does the same, for the same
 * reason. Nothing is promised that is not installed — `managerConfig` is
 * defined in the constructor.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional, see above
export class QuasarManager<
	Connections extends Record<string, ConnectionConfig>,
> {
	readonly #config: QuasarConfig<Connections>;
	readonly #connections = new Map<string, QuasarConnection>();
	/** Scripts to replay onto every connection opened from here on. */
	readonly #scripts = new Map<string, ScriptDefinition>();
	#logErrors = true;
	#logger: QuasarLogger | undefined;

	constructor(config: QuasarConfig<Connections>, logger?: QuasarLogger) {
		this.#config = config;
		this.#logger = logger;
		Object.defineProperty(this, "managerConfig", {
			get: () => this.#config,
			enumerable: false,
		});
	}

	/** What `JSON.stringify` prints: where each connection points, no credential. */
	toJSON(): Record<string, unknown> {
		return {
			connection: this.#config.connection,
			connections: redactConfig(this.#config.connections),
			activeConnectionNames: this.activeConnectionNames,
		};
	}

	/** What `util.inspect` and `console.log` print: the same redacted view. */
	[Symbol.for("nodejs.util.inspect.custom")](
		depth: number,
		options: InspectOptions,
	): string {
		return `QuasarManager ${inspect(this.toJSON(), { ...options, depth })}`;
	}

	/** The name `connection()` resolves to when called without one. */
	get defaultConnectionName(): keyof Connections & string {
		return this.#config.connection;
	}

	/** The connections open right now — not the ones merely declared. */
	get activeConnectionNames(): string[] {
		return [...this.#connections.keys()];
	}

	/** The open connections keyed by name (Adonis' `activeConnections`). */
	get activeConnections(): Record<string, QuasarConnection> {
		return Object.fromEntries(this.#connections);
	}

	/** How many connections are open right now. */
	get activeConnectionsCount(): number {
		return this.#connections.size;
	}

	/**
	 * A declared connection, opened on first use. An undeclared name throws:
	 * a typo would otherwise open a connection to a default localhost and look
	 * like it worked until the first command hit the wrong server.
	 */
	connection(
		name: keyof Connections & string = this.#config.connection,
	): QuasarConnection {
		const existing = this.#connections.get(name);
		if (existing) return existing;

		// Own properties only: the map is a plain object, and a name such as
		// `constructor` or `__proto__` would otherwise read Object.prototype and
		// open an unauthenticated connection to localhost. NAMED DEVIATION:
		// upstream returns the inherited member instead of a connection.
		const config = Object.hasOwn(this.#config.connections, name)
			? this.#config.connections[name]
			: undefined;
		if (typeof config !== "object" || config === null) {
			const declared = Object.keys(this.#config.connections).join(", ");
			throw new Error(
				`[redis] connection "${name}" is not declared — got ${declared}`,
			);
		}

		const connection = new QuasarConnection(name, config, this.#logger);
		if (!this.#logErrors) connection.doNotLogErrors();
		for (const [script, definition] of this.#scripts) {
			connection.defineCommand(script, definition);
		}
		// Stop tracking it once its socket ends for good — ioredis reaches `end`
		// when its retry strategy gives up. Without this the cache above hands
		// the same dead connection back for the rest of the process: every
		// command on it rejects, `activeConnections` still reports it open, and
		// nothing ever opens a live one. Adonis drops it here too.
		//
		// Guarded on identity so a late `end` from a connection already replaced
		// does not evict its successor.
		connection.ioConnection.on("end", () => {
			if (this.#connections.get(name) === connection) {
				this.#connections.delete(name);
				retire(connection);
			}
		});
		this.#connections.set(name, connection);
		return connection;
	}

	/**
	 * Subscribe on the default connection.
	 *
	 * `void`, matching the connection and upstream. Declared `async` it would
	 * be worse than the promise it replaced: delegating to a `void` method and
	 * awaiting `undefined` resolves before the subscription is even attempted,
	 * so `await manager.subscribe(...)` would guarantee less than nothing.
	 * {@link subscribed} is the awaitable form.
	 */
	subscribe(
		channel: string,
		handler: ChannelHandler,
		options?: PubSubOptions,
	): void {
		this.connection().subscribe(channel, handler, options);
	}

	/** {@link subscribe}, awaitable and rejecting — see `QuasarConnection`. */
	subscribed(
		channel: string,
		handler: ChannelHandler,
		options?: PubSubOptions,
	): Promise<void> {
		return this.connection().subscribed(channel, handler, options);
	}

	/** Unsubscribe on the default connection. */
	async unsubscribe(channel: string, handler?: ChannelHandler): Promise<void> {
		return this.connection().unsubscribe(channel, handler);
	}

	/** Pattern-subscribe on the default connection. `void`, see {@link subscribe}. */
	psubscribe(
		pattern: string,
		handler: PatternHandler,
		options?: PubSubOptions,
	): void {
		this.connection().psubscribe(pattern, handler, options);
	}

	/** {@link psubscribe}, awaitable and rejecting. */
	psubscribed(
		pattern: string,
		handler: PatternHandler,
		options?: PubSubOptions,
	): Promise<void> {
		return this.connection().psubscribed(pattern, handler, options);
	}

	/** Pattern-unsubscribe on the default connection. */
	async punsubscribe(pattern: string, handler?: PatternHandler): Promise<void> {
		return this.connection().punsubscribe(pattern, handler);
	}

	/** Publish on the default connection. */
	async publish(channel: string, message: string): Promise<number> {
		return this.connection().publish(channel, message);
	}

	/**
	 * Register a LUA script as a command, callable through {@link runCommand}.
	 *
	 * Applied to every connection open now AND remembered, so a connection
	 * opened later gets it too — otherwise a script defined at boot would be
	 * missing from whichever connection happened to open afterwards.
	 */
	defineCommand(name: string, definition: ScriptDefinition): this {
		for (const connection of this.#connections.values()) {
			connection.defineCommand(name, definition);
		}
		this.#scripts.set(name, definition);
		return this;
	}

	/** Run a command registered with {@link defineCommand}, on the default connection. */
	runCommand(command: string, ...args: unknown[]): unknown {
		return this.connection().runCommand(command, ...args);
	}

	/**
	 * Report connection failures through this logger, now and on every
	 * connection opened later. The provider calls it once the container has
	 * resolved one; until then failures go to the console.
	 */
	useLogger(logger: QuasarLogger): this {
		this.#logger = logger;
		for (const connection of this.#connections.values()) {
			connection.useLogger(logger);
		}
		return this;
	}

	/**
	 * Stop logging connection errors — you take over handling them, or the
	 * process crashes on an unhandled `error` event.
	 */
	doNotLogErrors(): this {
		this.#logErrors = false;
		for (const connection of this.#connections.values()) {
			connection.doNotLogErrors();
		}
		return this;
	}

	/**
	 * QUIT ONE connection — the default one when no name is given, exactly like
	 * Adonis. It does NOT close everything: use {@link quitAll} for that. An app
	 * calling `redis.quit()` expects one socket closed, not all of them.
	 */
	async quit(name?: keyof Connections & string): Promise<void> {
		await this.#close(name ?? this.defaultConnectionName, "quit");
	}

	/**
	 * Drop ONE connection without waiting for in-flight commands — the default
	 * one when no name is given. See {@link disconnectAll} to drop every one.
	 */
	async disconnect(name?: keyof Connections & string): Promise<void> {
		await this.#close(name ?? this.defaultConnectionName, "disconnect");
	}

	/** QUIT every open connection. What a provider wants on shutdown. */
	async quitAll(): Promise<void> {
		await Promise.all(
			this.activeConnectionNames.map((name) => this.#close(name, "quit")),
		);
	}

	/** Drop every open connection without waiting. */
	async disconnectAll(): Promise<void> {
		await Promise.all(
			this.activeConnectionNames.map((name) => this.#close(name, "disconnect")),
		);
	}

	/**
	 * Close one tracked connection and stop tracking it. Takes a plain string:
	 * the names it is handed come from the map itself, and narrowing them back
	 * to the declared keys would take an assertion.
	 */
	async #close(name: string, how: "quit" | "disconnect"): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;
		await connection[how]();
		// Unless a newer connection took the name while this one was closing.
		if (this.#connections.get(name) === connection) {
			this.#connections.delete(name);
		}
	}
}

/**
 * Install every ioredis command on the prototype, each resolving the default
 * connection at CALL time — not at construction, when no connection is open yet
 * and the default one may since have been quit and reopened.
 */
for (const method of ioredisCommandNames()) {
	if (method in QuasarManager.prototype) continue;
	Reflect.set(
		QuasarManager.prototype,
		method,
		function forwardToDefaultConnection(
			this: QuasarManager<Record<string, ConnectionConfig>>,
			...args: unknown[]
		): unknown {
			const connection = this.connection();
			const command = Reflect.get(connection, method);
			if (typeof command !== "function") {
				throw new Error(`[redis] connection has no command "${method}"`);
			}
			return Reflect.apply(command, connection, args);
		},
	);
}

/**
 * Every command ioredis defines, walking the prototype chain: the commands live
 * on `Commander.prototype`, the PARENT of `Redis.prototype`, so looking only at
 * Redis' own properties finds none of them.
 *
 * Read as descriptors, never with `Reflect.get`: the chain carries accessors
 * (`autoPipelineQueueSize`) that read `this`, and getting one off a bare
 * prototype runs it against no instance and throws.
 */
function ioredisCommandNames(): string[] {
	const names = new Set<string>();
	for (
		let target: object | null = Redis.prototype;
		target !== null && target !== Object.prototype;
		target = Object.getPrototypeOf(target)
	) {
		for (const key of Object.getOwnPropertyNames(target)) {
			if (key === "constructor" || key.startsWith("_")) continue;
			const descriptor = Object.getOwnPropertyDescriptor(target, key);
			if (typeof descriptor?.value === "function") names.add(key);
		}
	}
	return [...names];
}
