/**
 * TLS reaches the client, or the connection is plaintext without a word.
 *
 * Every case builds with `lazyConnect`: what is pinned is the options the
 * client will dial with, not a handshake.
 */
import { inspect } from "node:util";
import { Cluster, Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/config.js";
import { QuasarConnection } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";

const opened: QuasarConnection[] = [];

afterEach(async () => {
	for (const connection of opened.splice(0)) await connection.disconnect();
});

function standalone(
	...args: ConstructorParameters<typeof QuasarConnection>
): Redis {
	const connection = new QuasarConnection(...args);
	opened.push(connection);
	const client = connection.ioConnection;
	if (!(client instanceof Redis))
		throw new Error("expected a standalone client");
	return client;
}

describe("quasar > TLS", () => {
	it("dials TLS for a rediss:// URL, with certificate verification left on", () => {
		const client = standalone("main", {
			url: "rediss://cache.internal:6380/2",
			lazyConnect: true,
		});

		expect(client.options.tls).toBeTruthy();
		expect(client.options.host).toBe("cache.internal");
		expect(client.options.port).toBe(6380);
		const tls: unknown = client.options.tls;
		expect(
			typeof tls === "object" && tls !== null
				? Reflect.get(tls, "rejectUnauthorized")
				: undefined,
		).not.toBe(false);
	});

	it("dials TLS for a rediss:// URL whatever the scheme's case", () => {
		// URL schemes are case-insensitive; the client only recognises the
		// lowercase one and would dial REDISS:// in plaintext.
		for (const url of [
			"REDISS://cache.internal:6380",
			"Rediss://cache.internal",
		]) {
			const client = standalone("main", { url, lazyConnect: true });
			expect(client.options.tls, url).toBeTruthy();
			expect(client.options.host, url).toBe("cache.internal");
		}
	});

	it("forwards a tls block as given", () => {
		const client = standalone("main", {
			host: "127.0.0.1",
			port: 6399,
			tls: { rejectUnauthorized: true, ca: "test-ca", servername: "cache" },
			lazyConnect: true,
		});

		expect(client.options.tls).toEqual({
			rejectUnauthorized: true,
			ca: "test-ca",
			servername: "cache",
		});
	});

	it("keeps a tls block beside a rediss:// URL", () => {
		const client = standalone("main", {
			url: "rediss://cache.internal:6380",
			tls: { ca: "test-ca" },
			lazyConnect: true,
		});

		expect(client.options.tls).toEqual({ ca: "test-ca" });
	});

	it("forwards a cluster's per-node tls block", () => {
		const connection = new QuasarConnection("cluster", {
			clusters: [{ host: "127.0.0.1", port: 7000 }],
			clusterOptions: {
				lazyConnect: true,
				redisOptions: { tls: { ca: "test-ca" } },
			},
		});
		opened.push(connection);
		const client = connection.ioConnection;

		expect(client).toBeInstanceOf(Cluster);
		if (client instanceof Cluster) {
			expect(client.options.redisOptions?.tls).toEqual({ ca: "test-ca" });
		}
	});

	it("still redacts the userinfo of a rediss:// URL", () => {
		const manager = new QuasarManager(
			defineConfig({
				connection: "main",
				connections: {
					main: { url: "rediss://tls-user:tls-pw@cache.internal:6380/2" },
					upper: { url: "REDISS://up-user:up-pw@cache.internal:6380" },
				},
			}),
		);

		for (const printed of [
			JSON.stringify(manager),
			inspect(manager, { depth: 10 }),
		]) {
			for (const secret of ["tls-user", "tls-pw", "up-user", "up-pw"]) {
				expect(printed).not.toContain(secret);
			}
			expect(printed).toContain("rediss://[redacted]@cache.internal:6380/2");
		}
	});
});
