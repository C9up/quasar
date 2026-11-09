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

	it("still hands the real config to code that reads managerConfig", () => {
		const manager = managerWith();

		expect(manager.managerConfig.connections.main.password).toBe(PASSWORD);
		expect(manager.managerConfig.connection).toBe("main");
	});
});
