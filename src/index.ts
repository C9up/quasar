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

import "./augmentations.js";

export type {
	ClusterConnectionConfig,
	ConnectionConfig,
	Credential,
	QuasarClusterOptions,
	QuasarConfig,
	RedisClient,
	SecretValue,
	StandaloneConnectionConfig,
} from "./config.js";
export { defineConfig, isClusterConfig } from "./config.js";
export type {
	CheckedConnection,
	HealthResult,
	HealthStatus,
} from "./health.js";
export {
	errors,
	InvalidBytesValueError,
	QuasarCheck,
	QuasarMemoryUsageCheck,
} from "./health.js";
export type {
	ChannelHandler,
	PatternHandler,
	PubSubOptions,
	QuasarConnectionEvents,
	QuasarLogger,
	ScriptDefinition,
} from "./QuasarConnection.js";
export { QuasarConnection } from "./QuasarConnection.js";
export type { QuasarManagerEvents, QuasarService } from "./QuasarManager.js";
export { QuasarManager } from "./QuasarManager.js";
export type { RedisCommandTracingData } from "./tracing.js";
export * as tracingChannels from "./tracing.js";
