/**
 * Parity with `@adonisjs/redis`'s manager, against a live server. An Adonis app
 * must keep working after swapping the import alone, so the shapes asserted
 * here were read off the published `@adonisjs/redis` build, not recalled.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QuasarManager } from "../src/QuasarManager.js";

const url = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";
const config = {
	connection: "main" as const,
	connections: { main: { url }, cache: { url } },
};

describe("QuasarManager > @adonisjs/redis parity (live server)", () => {
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
