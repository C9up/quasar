import { type HealthCheckContract, HealthChecks } from "@c9up/ream/health";
import { describe, expect, it, vi } from "vitest";
import {
	type CheckedConnection,
	errors,
	QuasarCheck,
	QuasarMemoryUsageCheck,
} from "../src/health.js";
import { QuasarManager } from "../src/QuasarManager.js";

const unexpected = async (): Promise<never> => {
	throw new Error("not expected to be called");
};

/**
 * A connection stand-in carrying only what the checks read.
 *
 * The status readers are part of that: a check refuses to send a command to a
 * connection that is not ready, because ioredis would queue it rather than fail
 * it. `ready` is what a reachable server looks like.
 */
function connectionWith(
	io: {
		ping?: () => Promise<string>;
		info?: (section: string) => Promise<string>;
		connect?: () => Promise<void>;
	},
	state?: { status?: string; lastError?: unknown; name?: string },
): CheckedConnection {
	const status = state?.status ?? "ready";
	return {
		connectionName: state?.name ?? "main",
		status,
		lastError: state?.lastError,
		isConnecting: () => status === "connecting" || status === "reconnecting",
		isReady: () => status === "ready" || status === "connect",
		isClosed: () => status === "end" || status === "close",
		ioConnection: {
			ping: io.ping ?? unexpected,
			info: io.info ?? unexpected,
			connect: io.connect ?? unexpected,
		},
	};
}

describe("QuasarCheck", () => {
	it("reports ok when the server answers PONG", async () => {
		const result = await new QuasarCheck(
			connectionWith({ ping: async () => "PONG" }),
		).run();

		expect(result.status).toBe("ok");
		expect(result.message).toBe("Successfully connected to the redis server");
		expect(result.finishedAt).toBeInstanceOf(Date);
		expect(result.meta).toEqual({
			connection: { name: "main", status: "ready" },
		});
	});

	it("reports the reply verbatim when it is not PONG", async () => {
		const result = await new QuasarCheck(
			connectionWith({ ping: async () => "LOADING" }),
		).run();
		expect(result.status).toBe("error");
		expect(result.message).toContain("LOADING");
	});

	it("reports unreachable rather than throwing — a health endpoint answers", async () => {
		const failure = new Error("ECONNREFUSED");
		const result = await new QuasarCheck(
			connectionWith({
				ping: async () => {
					throw failure;
				},
			}),
		).run();

		expect(result.status).toBe("error");
		expect(result.message).toBe("ECONNREFUSED");
		expect(result.meta?.error).toBe(failure);
		expect(result.finishedAt).toBeInstanceOf(Date);
	});
});

/**
 * A check must not issue a command against a connection that is not ready.
 *
 * ioredis does not fail such a command, it QUEUES it: measured at 73 seconds
 * before it gave up with the ioredis defaults, and never with
 * `maxRetriesPerRequest: null` — the setting a queue needs. A readiness probe
 * that hangs for a minute is the outage it exists to report.
 */
describe("a check does not wait on a connection that is not ready", () => {
	it("refuses to ping one that already recorded a failure", async () => {
		const ping = vi.fn(async () => "PONG");
		const failure = new Error("ECONNREFUSED");
		const result = await new QuasarCheck(
			connectionWith({ ping }, { status: "connecting", lastError: failure }),
		).run();

		expect(ping).not.toHaveBeenCalled();
		expect(result.status).toBe("error");
		expect(result.message).toBe("Unable to connect to the redis server");
		expect(result.meta?.error).toBe(failure);
	});

	it("says which connection, and what state it was in", async () => {
		const result = await new QuasarCheck(
			connectionWith({}, { status: "close" }),
		).run();

		expect(result.status).toBe("error");
		expect(result.meta).toEqual({
			connection: { name: "main", status: "close" },
		});
	});

	/**
	 * `close` counts as closed (upstream's isClosed), but ioredis is about to
	 * reconnect on its own from there: dialling it too would race the retry
	 * timer with a second socket. Only `end` is dialled.
	 */
	it("does not dial a connection ioredis is about to reconnect", async () => {
		const connect = vi.fn(async () => {});
		const result = await new QuasarCheck(
			connectionWith(
				{ connect },
				{ status: "close", lastError: new Error("ECONNRESET") },
			),
		).run();

		expect(connect).not.toHaveBeenCalled();
		expect(result.status).toBe("error");
	});

	it("does the same before reading INFO memory", async () => {
		const info = vi.fn(async () => "used_memory:1\r\n");
		const result = await new QuasarMemoryUsageCheck(
			connectionWith(
				{ info },
				{ status: "connecting", lastError: new Error("ECONNREFUSED") },
			),
		).run();

		expect(info).not.toHaveBeenCalled();
		expect(result.status).toBe("error");
	});

	/**
	 * Against a real dead port, with ioredis' own defaults — the offline queue
	 * on, which is what made the old check wait out the whole retry budget.
	 */
	it("answers about an unreachable server in seconds, not minutes", async () => {
		const manager = new QuasarManager({
			connection: "main",
			connections: { main: { host: "127.0.0.1", port: 6399 } },
		}).doNotLogErrors();
		const started = Date.now();

		const result = await new QuasarCheck(manager.connection()).run();

		expect(result.status).toBe("error");
		expect(Date.now() - started).toBeLessThan(10_000);
		await manager.disconnectAll();
	}, 20_000);
});

describe("QuasarMemoryUsageCheck", () => {
	/**
	 * Adonis' defaults. Without them a check added and left unconfigured could
	 * never fail — which reads as a monitored server and is worse than no check.
	 */
	it("can fail with no thresholds configured", async () => {
		const overBoth = 200 * 1024 * 1024;
		const result = await new QuasarMemoryUsageCheck(
			connectionWith({ info: async () => `used_memory:${overBoth}\r\n` }),
		).run();

		expect(result.status).toBe("error");
		expect(result.message).toBe(
			"Redis memory usage is 200MB, which is above the threshold of 120MB",
		);
	});

	it("warns at Adonis' warning default", async () => {
		const betweenTheTwo = 110 * 1024 * 1024;
		const result = await new QuasarMemoryUsageCheck(
			connectionWith({ info: async () => `used_memory:${betweenTheTwo}\r\n` }),
		).run();

		expect(result.status).toBe("warning");
	});

	const info = (used: number) => async () =>
		`# Memory\r\nused_memory:${used}\r\nused_memory_rss:999999999\r\n`;

	it("stays ok below the warning threshold, and says by how much", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: info(100) }),
		)
			.warnWhenExceeds(400)
			.failWhenExceeds(800);
		const result = await check.run();

		expect(result.status).toBe("ok");
		expect(result.meta).toEqual({
			memoryInBytes: {
				used: 100,
				warningThreshold: 400,
				failureThreshold: 800,
			},
			connection: { name: "main", status: "ready" },
		});
	});

	it("warns between the two thresholds", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: info(500) }),
		)
			.warnWhenExceeds(400)
			.failWhenExceeds(800);
		expect((await check.run()).status).toBe("warning");
	});

	it("fails past the failure threshold", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: info(900) }),
		)
			.warnWhenExceeds(400)
			.failWhenExceeds(800);
		expect((await check.run()).status).toBe("error");
	});

	it("reads thresholds written as sizes, as upstream does", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: info(150 * 1024 * 1024) }),
		)
			.warnWhenExceeds("100 mb")
			.failWhenExceeds("1gb");
		const result = await check.run();

		expect(result.status).toBe("warning");
		expect(result.meta?.memoryInBytes).toEqual({
			used: 150 * 1024 * 1024,
			warningThreshold: 100 * 1024 * 1024,
			failureThreshold: 1024 ** 3,
		});
	});

	it("refuses a threshold it cannot read, with upstream's code", () => {
		const check = new QuasarMemoryUsageCheck(connectionWith({}));

		expect(() => check.warnWhenExceeds("lots")).toThrow(
			errors.E_INVALID_BYTES_VALUE,
		);
		expect(() => check.failWhenExceeds("ten mb")).toThrow(
			expect.objectContaining({ code: "E_INVALID_BYTES_VALUE" }),
		);
	});

	it("says so when INFO carries no used_memory", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: async () => "# Memory\r\n" }),
		);
		const result = await check.run();
		expect(result.status).toBe("error");
		expect(result.message).toBe(
			"Check failed. Unable to get redis memory info",
		);
	});

	it("measures through compute() when one is given", async () => {
		const info = vi.fn(async () => "used_memory:1\r\n");
		const check = new QuasarMemoryUsageCheck(connectionWith({ info }))
			.warnWhenExceeds(10)
			.compute(async () => 50);

		expect((await check.run()).status).toBe("warning");
		expect(info).not.toHaveBeenCalled();
	});
});

describe("quasar checks in ream's HealthChecks", () => {
	it("are health check contracts as they are", () => {
		const checks: HealthCheckContract[] = [
			new QuasarCheck(connectionWith({})),
			new QuasarMemoryUsageCheck(connectionWith({})),
		];

		expect(checks).toHaveLength(2);
	});

	it("name each connection apart, in upstream's words", () => {
		const main = connectionWith({}, { name: "main" });
		const cache = connectionWith({}, { name: "cache" });

		expect(new QuasarCheck(main).name).toBe("Redis health check (main)");
		expect(new QuasarCheck(cache).name).toBe("Redis health check (cache)");
		expect(new QuasarMemoryUsageCheck(cache).name).toBe(
			"Redis memory consumption health check (cache)",
		);
		expect(new QuasarCheck(main).as("primary").name).toBe("primary");
	});

	it("report two connections as two entries", async () => {
		const report = await new HealthChecks()
			.register([
				new QuasarCheck(
					connectionWith({ ping: async () => "PONG" }, { name: "main" }),
				),
				new QuasarCheck(
					connectionWith({ ping: async () => "PONG" }, { name: "cache" }),
				),
			])
			.run();

		expect(report.checks.map((check) => check.name)).toEqual([
			"Redis health check (main)",
			"Redis health check (cache)",
		]);
		expect(report.isHealthy).toBe(true);
	});

	it("serve a cached result for as long as cacheFor() says", async () => {
		const ping = vi.fn(async () => "PONG");
		const check = new QuasarCheck(connectionWith({ ping })).cacheFor(
			"1 minute",
		);
		const checks = new HealthChecks().register([check]);

		await checks.run();
		const second = await checks.run();

		expect(check.cacheDuration).toBe(60);
		expect(ping).toHaveBeenCalledOnce();
		expect(second.checks[0]?.isCached).toBe(true);
	});

	it("refuse a cache duration they cannot read", () => {
		expect(() => new QuasarCheck(connectionWith({})).cacheFor("soon")).toThrow(
			/cannot read "soon" as a duration/,
		);
	});
});
