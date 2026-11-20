/**
 * The manager is the `redis` container binding: it is what ends up in a log
 * line, an error payload or an admin dump. Its config carries credentials, and
 * none of them may come out of JSON or `util.inspect`.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config.js";
import { QuasarManager } from "../src/QuasarManager.js";

const PASSWORD = "s3cret-pw";

function managerWith() {
	return new QuasarManager(
		defineConfig({
			connection: "main",
			connections: {
				main: {
					host: "127.0.0.1",
					port: 6399,
					username: "app-user",
					password: PASSWORD,
					sentinelPassword: "sentinel-pw",
					lazyConnect: true,
				},
				byUrl: { url: "rediss://url-user:url-pw@cache.internal:6380/2" },
				cluster: {
					clusters: [{ host: "node-1", port: 7000 }],
					clusterOptions: {
						redisOptions: { password: "cluster-pw" },
					},
				},
			},
		}),
	);
}

const SECRETS = [
	PASSWORD,
	"app-user",
	"sentinel-pw",
	"url-user",
	"url-pw",
	"cluster-pw",
];

describe("quasar > the manager never prints a credential", () => {
	it("keeps them out of JSON.stringify", () => {
		const json = JSON.stringify(managerWith());

		for (const secret of SECRETS) expect(json).not.toContain(secret);
		// What is left is still useful for a dump: where each connection points.
		expect(json).toContain("cache.internal");
		expect(json).toContain("6399");
	});

	it("keeps them out of util.inspect, at any depth", () => {
		const printed = inspect(managerWith(), { depth: 10 });

		for (const secret of SECRETS) expect(printed).not.toContain(secret);
		expect(printed).toContain("127.0.0.1");
	});

	it("keeps them out of a template string or a console.log of the config", () => {
		const manager = managerWith();

		expect(`${inspect({ manager }, { depth: 10 })}`).not.toContain(PASSWORD);
		expect(Object.keys(manager)).not.toContain("managerConfig");
	});

	// ioredis reads every query parameter of a connection URL as a client
	// option, so `?password=` authenticates exactly like userinfo does.
	it.each([
		["a redis:// URL", "redis://redis.internal:6379/0?password=hunter2"],
		[
			"a rediss:// URL with userinfo too",
			"rediss://u:pw@host:6380/0?password=hunter2&username=admin",
		],
		["a unix socket path", "/var/run/redis.sock?password=hunter2"],
		["a scheme-less host:port", "redis.internal:6379?password=hunter2"],
		["a protocol-relative URL", "//redis.internal:6379?password=hunter2"],
		[
			"a key spelled in another case",
			"redis://redis.internal:6379?PassWord=hunter2",
		],
		[
			"a sentinel credential",
			"redis://redis.internal:6379?sentinelPassword=hunter2",
		],
		["a percent-encoded key", "redis://redis.internal?pass%77ord=hunter2"],
	])(
		"keeps a credential in the query of %s out of the printed view",
		(_, url) => {
			const manager = new QuasarManager(
				defineConfig({ connection: "main", connections: { main: { url } } }),
			);

			for (const printed of [
				JSON.stringify(manager),
				inspect(manager, { depth: 10 }),
			]) {
				expect(printed).not.toContain("hunter2");
				expect(printed).not.toContain("admin");
				expect(printed).not.toContain(":pw@");
				expect(printed).toContain("[redacted]");
			}
		},
	);

	it("keeps the rest of the URL readable", () => {
		const manager = new QuasarManager(
			defineConfig({
				connection: "main",
				connections: {
					main: { url: "redis://cache.internal:6379/2?password=x&db=3" },
					plain: { url: "redis://cache.internal:6379/2?family=6" },
					socket: { url: "/var/run/redis.sock?db=2" },
				},
			}),
		);

		const json = JSON.stringify(manager);
		expect(json).toContain(
			"redis://cache.internal:6379/2?password=[redacted]&db=3",
		);
		expect(json).toContain("redis://cache.internal:6379/2?family=6");
		expect(json).toContain("/var/run/redis.sock?db=2");
	});

	it("redacts userinfo on a scheme-less or protocol-relative URL", () => {
		const manager = new QuasarManager(
			defineConfig({
				connection: "main",
				connections: {
					main: { url: "u:hunter2@cache.internal:6379" },
					relative: { url: "//u:hunter2@cache.internal:6379/1" },
				},
			}),
		);

		const json = JSON.stringify(manager);
		expect(json).not.toContain("hunter2");
		expect(json).toContain("[redacted]@cache.internal:6379");
	});

	it("still hands the real config to code that reads managerConfig", () => {
		const manager = managerWith();

		expect(manager.managerConfig.connections.main.password).toBe(PASSWORD);
		expect(manager.managerConfig.connection).toBe("main");
	});
});
