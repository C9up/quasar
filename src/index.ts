/**
 * `@c9up/quasar` — Redis connections for the Ream framework.
 *
 * Owns the connection and nothing else: named connections, pub/sub on its own
 * socket, health checks, and a clean shutdown. The packages that store things
 * in Redis — @c9up/echo (cache), @c9up/bay (queue), @c9up/warden (token
 * blacklist) — keep taking a client by structural contract, so they stay
 * agnostic and this package stays optional.
 *
 *   // config/redis.ts
 *   export default defineConfig({
 *     connection: 'main',
 *     connections: { main: { url: env.get('REDIS_URL') } },
 *   })
 *
 *   // anywhere
 *   import redis from '@c9up/quasar/services/main'
 *   await redis.connection().set('key', 'value')
 */

export type {
	ClusterConnectionConfig,
	ConnectionConfig,
	QuasarConfig,
	RedisClient,
	StandaloneConnectionConfig,
} from "./config.js";
export { defineConfig, isClusterConfig } from "./config.js";
export type { HealthResult, HealthStatus } from "./health.js";
export { QuasarCheck, QuasarMemoryUsageCheck } from "./health.js";
export type { ChannelHandler, PatternHandler } from "./QuasarConnection.js";
export { QuasarConnection } from "./QuasarConnection.js";
export { QuasarManager } from "./QuasarManager.js";
