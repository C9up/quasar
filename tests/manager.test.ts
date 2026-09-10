import { describe, expect, it } from "vitest";
import type { ConnectionConfig, QuasarConfig } from "../src/config.js";
import { QuasarManager } from "../src/QuasarManager.js";

const config: QuasarConfig<Record<string, ConnectionConfig>> = {
	connection: "main",
	connections: {
		main: { host: "127.0.0.1", port: 6379, lazyConnect: true },
		cache: { host: "127.0.0.1", port: 6379, db: 1, lazyConnect: true },
	},
};

describe("QuasarManager", () => {
	it("refuses an undeclared connection instead of dialling a default", () => {
		const manager = new QuasarManager(config);
		// A typo must not open a connection that looks alive until the first
		// command reaches the wrong server.
		expect(() => manager.connection("cahce" as "cache")).toThrow(
			/"cahce" is not declared/,
		);
		expect(manager.activeConnectionNames).toEqual([]);
	});

	it("hands the same connection back rather than opening a second socket", async () => {
		const manager = new QuasarManager(config);
		const first = manager.connection("cache");
		expect(manager.connection("cache")).toBe(first);
		expect(manager.activeConnectionNames).toEqual(["cache"]);
		// disconnect() targets the DEFAULT connection, which is not "cache" —
		// closing everything takes disconnectAll().
		await manager.disconnectAll();
	});

	it("resolves the declared default with no argument", async () => {
		const manager = new QuasarManager(config);
		expect(manager.defaultConnectionName).toBe("main");
		expect(manager.connection().name).toBe("main");
		await manager.disconnect();
	});

	it("only counts connections that were actually opened", async () => {
		const manager = new QuasarManager(config);
		expect(manager.activeConnectionNames).toEqual([]);
		expect(manager.activeConnectionsCount).toBe(0);
		manager.connection("main");
		expect(manager.activeConnectionNames).toEqual(["main"]);
		expect(manager.activeConnectionsCount).toBe(1);
		expect(Object.keys(manager.activeConnections)).toEqual(["main"]);
		await manager.disconnect();
		expect(manager.activeConnectionNames).toEqual([]);
	});
});

describe("QuasarManager > the façade must not promise more than the connection", () => {
	/**
	 * The manager is what an application calls. Declaring `subscribe` `async`
	 * while it delegates to a `void` method is worse than the promise it
	 * replaced: awaiting `undefined` resolves before the subscription has even
	 * been attempted, so `await manager.subscribe(...)` would guarantee less
	 * than nothing. Only the connection was aligned at first; this is the half
	 * that is actually reached from an app.
	 */
	/** Fails fast instead of retrying, so a failure is a failure. */
	const OFFLINE = {
		host: "127.0.0.1",
		port: 6379,
		lazyConnect: true,
		enableOfflineQueue: false,
		retryStrategy: () => null,
	} as const;

	const offlineConfig: QuasarConfig<Record<string, ConnectionConfig>> = {
		connection: "main",
		connections: { main: { ...OFFLINE } },
	};

	function manager(): QuasarManager<Record<string, ConnectionConfig>> {
		return new QuasarManager(offlineConfig);
	}

	it("subscribe answers void, not a promise", () => {
		const m = manager();
		expect(m.subscribe("orders", () => {})).toBeUndefined();
		expect(m.psubscribe("user:*", () => {})).toBeUndefined();
	});

	it("subscribed rejects when the channel cannot be subscribed", async () => {
		// Nothing is listening on the configured port, so the subscribe fails.
		// The awaitable form has to say so — that is its whole reason to exist.
		const m = manager();
		await expect(m.subscribed("orders", () => {})).rejects.toThrow();
		await expect(m.psubscribed("user:*", () => {})).rejects.toThrow();
	});

	it("reaches the DEFAULT connection", async () => {
		const m = manager();
		const calls: string[] = [];
		const connection = m.connection();
		connection.subscribed = (channel: string) => {
			calls.push(channel);
			return Promise.resolve();
		};
		await m.subscribed("orders", () => {});
		expect(calls).toEqual(["orders"]);
	});
});
