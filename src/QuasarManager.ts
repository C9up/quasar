/**
 * The connections declared in `config/redis.ts`, opened on demand.
 *
 * `redis.connection()` hands back the default one, `redis.connection('cache')`
 * a named one. Each is built the first time it is asked for and kept, so two
 * call sites share one socket instead of opening a pair each.
 */

import type { ConnectionConfig, QuasarConfig } from "./config.js";
import type { ChannelHandler, PatternHandler } from "./QuasarConnection.js";
import { QuasarConnection } from "./QuasarConnection.js";

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
	connection(name?: string): QuasarConnection;
	subscribe(channel: string, handler: ChannelHandler): Promise<void>;
	unsubscribe(channel: string): Promise<void>;
	psubscribe(pattern: string, handler: PatternHandler): Promise<void>;
	punsubscribe(pattern: string): Promise<void>;
	publish(channel: string, message: string): Promise<number>;
	quit(name?: string): Promise<void>;
	disconnect(name?: string): void;
}

export class QuasarManager<
	Connections extends Record<string, ConnectionConfig>,
> {
	readonly #config: QuasarConfig<Connections>;
	readonly #connections = new Map<string, QuasarConnection>();

	constructor(config: QuasarConfig<Connections>) {
		this.#config = config;
	}

	/** The name `connection()` resolves to when called without one. */
	get defaultConnectionName(): keyof Connections & string {
		return this.#config.connection;
	}

	/** The connections open right now — not the ones merely declared. */
	get activeConnectionNames(): string[] {
		return [...this.#connections.keys()];
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

		const config = this.#config.connections[name];
		if (config === undefined) {
			const declared = Object.keys(this.#config.connections).join(", ");
			throw new Error(
				`[redis] connection "${name}" is not declared — got ${declared}`,
			);
		}

		const connection = new QuasarConnection(name, config);
		this.#connections.set(name, connection);
		return connection;
	}

	/** Subscribe on the default connection. */
	async subscribe(channel: string, handler: ChannelHandler): Promise<void> {
		return this.connection().subscribe(channel, handler);
	}

	/** Unsubscribe on the default connection. */
	async unsubscribe(channel: string): Promise<void> {
		return this.connection().unsubscribe(channel);
	}

	/** Pattern-subscribe on the default connection. */
	async psubscribe(pattern: string, handler: PatternHandler): Promise<void> {
		return this.connection().psubscribe(pattern, handler);
	}

	/** Pattern-unsubscribe on the default connection. */
	async punsubscribe(pattern: string): Promise<void> {
		return this.connection().punsubscribe(pattern);
	}

	/** Publish on the default connection. */
	async publish(channel: string, message: string): Promise<number> {
		return this.connection().publish(channel, message);
	}

	/**
	 * QUIT one connection, or every open one. Called by the provider on
	 * shutdown, so a process that stops does not leave sockets behind.
	 */
	async quit(name?: keyof Connections & string): Promise<void> {
		const names = name === undefined ? this.activeConnectionNames : [name];
		await Promise.all(
			names.map(async (target) => {
				const connection = this.#connections.get(target);
				if (!connection) return;
				await connection.quit();
				this.#connections.delete(target);
			}),
		);
	}

	/** Drop one connection, or every open one, without waiting. */
	disconnect(name?: keyof Connections & string): void {
		const names = name === undefined ? this.activeConnectionNames : [name];
		for (const target of names) {
			const connection = this.#connections.get(target);
			if (!connection) continue;
			connection.disconnect();
			this.#connections.delete(target);
		}
	}
}
