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

/**
 * A value handed over only through `release()` — ream's `Secret`, read
 * structurally so this package does not import the framework. What
 * `env.get()` returns for a variable declared `Env.schema.secret()`.
 */
export interface SecretValue {
	release(): string;
}

/** A credential as the config may carry it: plain, or still wrapped. */
export type Credential = string | SecretValue;

/**
 * A single server, addressed by options or by URL.
 *
 * As upstream types it: the port may be the string an env file holds, and the
 * passwords may stay wrapped. They are unwrapped on a copy as the client is
 * built, so the config — and anything that prints it — keeps the Secret.
 */
export interface StandaloneConnectionConfig
	extends Omit<RedisOptions, "port" | "password" | "sentinelPassword"> {
	/** `redis://` / `rediss://` URL. Takes precedence over host/port when set. */
	url?: string;
	port?: string | number;
	password?: Credential;
	sentinelPassword?: Credential;
}

type ClusterRedisOptions = NonNullable<ClusterOptions["redisOptions"]>;

/**
 * ioredis' cluster options, with the per-node passwords accepting a Secret
 * like a standalone connection's do. Upstream leaves these plain; a cluster
 * configured from the same env file deserves the same treatment.
 */
export interface QuasarClusterOptions
	extends Omit<ClusterOptions, "redisOptions"> {
	redisOptions?: Omit<ClusterRedisOptions, "password" | "sentinelPassword"> & {
		password?: Credential;
		sentinelPassword?: Credential;
	};
}

/** A cluster, addressed by its seed nodes. */
export interface ClusterConnectionConfig {
	clusters: ClusterNode[];
	clusterOptions?: QuasarClusterOptions;
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
