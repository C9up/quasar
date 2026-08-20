/**
 * Connection configuration — the shape `config/redis.ts` returns.
 *
 * A connection is either standalone (host/port or a URL) or a cluster (a list
 * of nodes). Both forms hand their options straight to ioredis: this module
 * owns the lifecycle, not the tuning knobs, so anything ioredis accepts stays
 * available without being re-declared here.
 */

import type {
	Cluster,
	ClusterNode,
	ClusterOptions,
	Redis,
	RedisOptions,
} from "ioredis";

/** A single server, addressed by options or by URL. */
export interface StandaloneConnectionConfig extends RedisOptions {
	/** `redis://` / `rediss://` URL. Takes precedence over host/port when set. */
	url?: string;
}

/** A cluster, addressed by its seed nodes. */
export interface ClusterConnectionConfig {
	clusters: ClusterNode[];
	clusterOptions?: ClusterOptions;
}

export type ConnectionConfig =
	| StandaloneConnectionConfig
	| ClusterConnectionConfig;

export interface QuasarConfig<
	Connections extends Record<string, ConnectionConfig>,
> {
	/** The connection `redis.connection()` returns with no argument. */
	connection: keyof Connections & string;
	connections: Connections;
}

/** True when the config describes a cluster rather than a single server. */
export function isClusterConfig(
	config: ConnectionConfig,
): config is ClusterConnectionConfig {
	return "clusters" in config;
}

/**
 * Type helper for `config/redis.ts`, so `redis.connection('cache')` only
 * accepts a name that was actually declared.
 *
 *   export default defineConfig({
 *     connection: 'main',
 *     connections: { main: { url: env.get('REDIS_URL') } },
 *   })
 */
export function defineConfig<
	Connections extends Record<string, ConnectionConfig>,
>(config: QuasarConfig<Connections>): QuasarConfig<Connections> {
	const names = Object.keys(config.connections);
	if (names.length === 0) {
		throw new Error("[redis] config declares no connection");
	}
	if (!names.includes(config.connection)) {
		throw new Error(
			`[redis] default connection "${config.connection}" is not declared — got ${names.join(", ")}`,
		);
	}
	return config;
}

/** What a connection hands back: ioredis' standalone or cluster client. */
export type RedisClient = Redis | Cluster;
