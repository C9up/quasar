/**
 * Parity with `@adonisjs/redis`'s manager, against a live server. An Adonis app
 * must keep working after swapping the import alone, so the shapes asserted
 * here were read off the published `@adonisjs/redis` build, not recalled.
 */
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { QuasarManager } from "../src/QuasarManager.js";

const url = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";
const config = {
	connection: "main" as const,
	connections: { main: { url }, cache: { url } },
};

/**
 * Skipped, not failed, when no server answers — same probe as
 * `connection.integration.test.ts`. CI has no Redis service, and a contributor
 * without one still gets a green suite.
 */
async function serverAnswers(): Promise<boolean> {
	const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
	try {
		await probe.connect();
		await probe.ping();
		return true;
	} catch {
		return false;
	} finally {
		probe.disconnect();
	}
}

const live = await serverAnswers();
const describeLive = live ? describe : describe.skip;

describeLive("QuasarManager > @adonisjs/redis parity (live server)", () => {
	let manager: QuasarManager<typeof config.connections> | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		manager = undefined;
	});

	it("quit() closes ONLY the default connection", async () => {
		manager = new QuasarManager(config);
		manager.connection("main");
		manager.connection("cache");
		expect(manager.activeConnectionsCount).toBe(2);

		await manager.quit();

		// The whole point: an app calling redis.quit() must not lose "cache".
		expect(manager.activeConnectionNames).toEqual(["cache"]);
	});

	it("quitAll() closes every connection", async () => {
		manager = new QuasarManager(config);
		manager.connection("main");
		manager.connection("cache");

		await manager.quitAll();

		expect(manager.activeConnectionsCount).toBe(0);
	});

	it("runs ioredis commands straight on the manager", async () => {
		manager = new QuasarManager(config);
		const key = `quasar-parity:${process.pid}:direct`;

		// `redis.set(...)` with no `.connection()` — the Adonis idiom.
		await manager.set(key, "value");
		expect(await manager.get(key)).toBe("value");
		await manager.del(key);
	});

	it("defineCommand reaches connections opened AFTER it was defined", async () => {
		manager = new QuasarManager(config);
		manager.defineCommand("echoFirstKey", {
			lua: "return KEYS[1]",
			numberOfKeys: 1,
		});

		// Opened after the definition: Adonis replays remembered scripts onto it.
		const late = manager.connection("cache");
		expect(await late.runCommand("echoFirstKey", "hello")).toBe("hello");
	});

	it("reports connection status the way Adonis does", async () => {
		manager = new QuasarManager(config);
		const connection = manager.connection("main");
		await connection.ping();

		expect(connection.isReady()).toBe(true);
		expect(connection.isClosed()).toBe(false);
		expect(connection.status).toBe("ready");
		// Adonis spells the name `connectionName`.
		expect(connection.connectionName).toBe("main");
	});
});

describeLive("QuasarConnection > subscriber lifecycle (live server)", () => {
	let manager: QuasarManager<typeof config.connections> | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		manager = undefined;
	});

	it("re-emits the pub/sub socket's lifecycle as subscriber:*", async () => {
		manager = new QuasarManager(config);
		const connection = manager.connection();
		const seen: string[] = [];
		connection.on("subscriber:ready", () => seen.push("ready"));

		// The socket is opened lazily by the first subscribe — before that there
		// is nothing an app could have attached a listener to, which is the whole
		// reason these are re-emitted on the command connection.
		await connection.subscribe(`quasar-sub:${process.pid}`, () => {});

		await expect.poll(() => seen, { timeout: 5_000 }).toEqual(["ready"]);
	});

	it("survives a subscriber error instead of crashing the process", async () => {
		manager = new QuasarManager(config);
		const connection = manager.connection();
		connection.doNotLogErrors();
		await connection.subscribe(`quasar-err:${process.pid}`, () => {});

		const subscriber = connection.ioSubscriberConnection;
		expect(subscriber).toBeDefined();
		// The socket is internal and created lazily, so the class must attach the
		// listeners itself — an 'error' with none throws on an EventEmitter, and
		// nothing outside could have subscribed before the first subscribe().
		subscriber?.emit("error", new Error("boom"));

		// Captured rather than swallowed: an app that opted out of logging can
		// still ask what went wrong.
		expect(connection.lastSubscriberError).toBeInstanceOf(Error);
	});
});

describeLive("QuasarConnection > subscription events (live server)", () => {
	let manager: QuasarManager<typeof config.connections> | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		manager = undefined;
	});

	it("emits subscription:ready with the channel count", async () => {
		manager = new QuasarManager(config);
		const connection = manager.connection();
		const seen: number[] = [];
		connection.on("subscription:ready", (payload: { count: number }) => {
			seen.push(payload.count);
		});

		await connection.subscribe(`quasar-ev:${process.pid}`, () => {});

		// Adonis reports the subscription through this event; an app can rely on
		// it without awaiting the call.
		await expect.poll(() => seen, { timeout: 5_000 }).toEqual([1]);
	});

	it("emits psubscription:ready for a pattern subscription", async () => {
		manager = new QuasarManager(config);
		const connection = manager.connection();
		const seen: number[] = [];
		connection.on("psubscription:ready", (payload: { count: number }) => {
			seen.push(payload.count);
		});

		await connection.psubscribe(`quasar-pev:${process.pid}:*`, () => {});

		await expect.poll(() => seen, { timeout: 5_000 }).toEqual([1]);
	});

	it("reports a failed subscription WITHOUT rejecting", async () => {
		manager = new QuasarManager(config);
		const connection = manager.connection();
		connection.doNotLogErrors();
		const errors: unknown[] = [];
		connection.on("subscription:error", (payload: { error: unknown }) => {
			errors.push(payload.error);
		});
		const viaCallback: unknown[] = [];

		// Close the socket the subscribe would use, so the command fails.
		await connection.subscribe(`quasar-warm:${process.pid}`, () => {});
		await connection.ioSubscriberConnection?.quit();

		// Adonis' subscribe returns void, so migrated code never awaits it — a
		// rejection nobody handles would take the process down.
		await expect(
			connection.subscribe(`quasar-dead:${process.pid}`, () => {}, {
				onError: (error) => viaCallback.push(error),
			}),
		).resolves.toBeUndefined();

		expect(viaCallback).toHaveLength(1);
		expect(errors).toHaveLength(1);
	});
});
