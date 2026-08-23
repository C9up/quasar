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
