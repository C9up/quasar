/**
 * A password declared `Env.schema.secret()` reaches the config as a Secret.
 *
 * It used to be handed to ioredis as is, so the server received
 * AUTH '[redacted]' — the Secret's string form — and refused it. The only
 * workaround, `.release()` in config/redis.ts, left the plaintext in the
 * manager's config for the next log line to print.
 */
import { Secret } from "@c9up/ream";
import { Cluster, Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";

const opened: QuasarConnection[] = [];

afterEach(async () => {
	for (const connection of opened.splice(0)) await connection.disconnect();
});

function open(...args: ConstructorParameters<typeof QuasarConnection>) {
	const connection = new QuasarConnection(...args);
	opened.push(connection);
	return connection;
}

describe("quasar > a Secret password", () => {
	it("is released for the client, and only for it", () => {
		const config = {
			host: "127.0.0.1",
			port: 6399,
			password: new Secret("pw"),
			sentinelPassword: new Secret("sentinel-pw"),
			lazyConnect: true,
		};
		const client = open("main", config).ioConnection;

		expect(client).toBeInstanceOf(Redis);
		if (client instanceof Redis) {
			expect(client.options.password).toBe("pw");
			expect(client.options.sentinelPassword).toBe("sentinel-pw");
		}
		// The config keeps the Secret: it is what the manager prints.
		expect(config.password).toBeInstanceOf(Secret);
	});

	it("is released under a cluster's redisOptions too", () => {
		const client = open("cluster", {
			clusters: [{ host: "127.0.0.1", port: 7000 }],
			clusterOptions: {
				lazyConnect: true,
				redisOptions: { password: new Secret("cluster-pw") },
			},
		}).ioConnection;

		expect(client).toBeInstanceOf(Cluster);
		if (client instanceof Cluster) {
			expect(client.options.redisOptions?.password).toBe("cluster-pw");
		}
	});

	it("stays redacted when the manager is printed", () => {
		const manager = new QuasarManager({
			connection: "main",
			connections: {
				main: {
					host: "127.0.0.1",
					password: new Secret("pw"),
					lazyConnect: true,
				},
			},
		});

		expect(JSON.stringify(manager)).toContain('"password":"[redacted]"');
		expect(JSON.stringify(manager)).not.toContain('"pw"');
	});
});

describe("quasar > a port read from the environment", () => {
	it("accepts the string an env file holds", () => {
		const client = open("main", {
			host: "127.0.0.1",
			port: "6399",
			lazyConnect: true,
		}).ioConnection;

		expect(client).toBeInstanceOf(Redis);
		if (client instanceof Redis) expect(client.options.port).toBe(6399);
	});

	// ioredis takes NaN and quietly dials its default port instead.
	for (const port of ["63 79", "redis", "", "70000", "-1", "6379.5"]) {
		it(`refuses "${port}" rather than falling back to a default`, () => {
			expect(
				() => new QuasarConnection("main", { port, lazyConnect: true }),
			).toThrow(/is not a port number/);
		});
	}
});
