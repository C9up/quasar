# @c9up/quasar

Redis connections for the [Ream](https://github.com/C9up/ream) framework — named connections, pub/sub, health checks, clean shutdown.

A quasar is powered by a black hole feeding on the matter around it: this one feeds the app its data. Like every package in the cohort it is named for what it is, not for the technology it speaks — which is Redis.

This package owns **the connection, and nothing else**. The packages that store things in Redis — `@c9up/echo` (cache), `@c9up/bay` (queue), `@c9up/warden` (token blacklist) — keep taking a client through a structural contract, so they stay agnostic and this package stays optional.

## Install

```sh
pnpm add @c9up/quasar
```

## Configure

```ts
// config/redis.ts
import { defineConfig } from '@c9up/quasar'
import env from '#start/env'

export default defineConfig({
  connection: 'main',
  connections: {
    main: { url: env.get('REDIS_URL') },
    cache: { host: env.get('REDIS_HOST'), port: 6379, db: 1 },
    cluster: { clusters: [{ host: 'node-1', port: 7000 }, { host: 'node-2', port: 7001 }] },
  },
})
```

`defineConfig` refuses a default connection that is not declared, and an empty connection list — a typo there would otherwise surface as a connection to some default localhost.

The config key and the container token stay `redis` — the **role**, matching `@c9up/echo` binding `cache` and `@c9up/bay` binding `queue`.

The config key and the container token stay `redis` — the **role**, the same way `@c9up/echo` binds `cache` and `@c9up/bay` binds `queue`.

Register the provider in `start/providers.ts` (or your app's provider list):

```ts
import QuasarProvider from '@c9up/quasar/provider'
```

It binds the manager as `'redis'` in the container and seats it on the service accessor. `register` opens **no socket**: connections are built on first use.

## Use

```ts
import redis from '@c9up/quasar/services/main'

await redis.connection().set('user:42', payload, 'EX', 60)
await redis.connection('cache').get('user:42')
```

Every ioredis command is callable straight on a connection. The raw client stays reachable as `connection.ioConnection` for anything not wrapped here.

## Pub/sub

```ts
await redis.subscribe('orders', (message, channel) => { /* … */ })
await redis.psubscribe('user:*', (message, channel, pattern) => { /* … */ })
await redis.publish('orders', JSON.stringify(order))
```

Redis puts a subscribed client into a mode where it accepts nothing but subscribe/unsubscribe, so a connection that both publishes and listens needs two sockets. The second one opens **lazily**, on the first subscribe, and never at all for a connection that only runs commands — meanwhile ordinary commands keep working on the first.

Re-subscribing to a channel replaces its handler instead of stacking a second one: a reload must not double-deliver.

## Health

```ts
import { QuasarCheck, QuasarMemoryUsageCheck } from '@c9up/quasar'

const ping = await new QuasarCheck(redis.connection()).run()
const memory = await new QuasarMemoryUsageCheck(redis.connection())
  .warnWhenExceeds(400_000_000)
  .failWhenExceeds(800_000_000)
  .run()
```

Both return `{ status: 'ok' | 'warning' | 'error', message }` rather than throwing — a health endpoint reports, it does not crash.

## Shutdown

`QuasarProvider.shutdown()` QUITs every open connection. Without it a stopped process keeps its sockets and ioredis' reconnection timer keeps the event loop alive, so the server looks hung instead of exiting.

## Tests

The suite runs against a real server on `REDIS_TEST_URL` (default `redis://127.0.0.1:6379`, db 15) — a mock would prove nothing about the part that actually bites. With no server answering, the live tests **skip** rather than fail.
