import { describe, expect, it } from "vitest";
import type { ConnectionConfig, QuasarConfig } from "../src/config.js";
import { defineConfig, isClusterConfig } from "../src/config.js";

/** Widely typed, so a deliberately invalid config reaches the runtime guard
 *  instead of being caught by the compiler — the guard is what is tested. */
type AnyConfig = QuasarConfig<Record<string, ConnectionConfig>>;

describe("defineConfig", () => {
	it("refuses a default that is not declared", () => {
		const invalid: AnyConfig = {
			connection: "cache",
			connections: { main: { host: "127.0.0.1" } },
		};
		expect(() => defineConfig(invalid)).toThrow(/"cache" is not declared/);
	});

	it("refuses an empty connection list", () => {
		const empty: AnyConfig = { connection: "main", connections: {} };
		expect(() => defineConfig(empty)).toThrow(/declares no connection/);
	});

	it("returns the config it was given when the default is declared", () => {
		const config = defineConfig({
			connection: "main",
			connections: {
				main: { host: "127.0.0.1" },
				cache: { host: "127.0.0.1", db: 1 },
			},
		});
		expect(config.connection).toBe("main");
		expect(Object.keys(config.connections)).toEqual(["main", "cache"]);
	});

	it("tells a cluster from a standalone server", () => {
		expect(
			isClusterConfig({ clusters: [{ host: "127.0.0.1", port: 7000 }] }),
		).toBe(true);
		expect(isClusterConfig({ host: "127.0.0.1" })).toBe(false);
	});
});
