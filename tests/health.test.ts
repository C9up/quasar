import { describe, expect, it, vi } from "vitest";
import { QuasarCheck, QuasarMemoryUsageCheck } from "../src/health.js";
import type { QuasarConnection } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";

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
		info?: () => Promise<string>;
	},
	state?: { status?: string; lastError?: unknown },
) {
	const status = state?.status ?? "ready";
	const connection = {
		name: "main",
		ioConnection: io,
		status,
		lastError: state?.lastError,
		isConnecting: () => status === "connecting",
		isReady: () => status === "ready",
		isClosed: () => status === "end",
	};
	return connection as unknown as QuasarConnection;
}

describe("QuasarCheck", () => {
	it("reports ok when the server answers PONG", async () => {
		const result = await new QuasarCheck(
			connectionWith({ ping: async () => "PONG" }),
		).run();
		expect(result.status).toBe("ok");
	});

	it("reports the reply verbatim when it is not PONG", async () => {
		const result = await new QuasarCheck(
			connectionWith({ ping: async () => "LOADING" }),
		).run();
		expect(result.status).toBe("error");
		expect(result.message).toContain("LOADING");
	});

	it("reports unreachable rather than throwing — a health endpoint answers", async () => {
		const result = await new QuasarCheck(
			connectionWith({
				ping: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		).run();
		expect(result.status).toBe("error");
		expect(result.message).toContain("ECONNREFUSED");
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
		const result = await new QuasarCheck(
			connectionWith(
				{ ping },
				{ status: "connecting", lastError: new Error("ECONNREFUSED") },
			),
		).run();

		expect(ping).not.toHaveBeenCalled();
		expect(result.status).toBe("error");
		expect(result.message).toContain("ECONNREFUSED");
	});

	it("says which connection, and what state it was in", async () => {
		const result = await new QuasarCheck(
			connectionWith({}, { status: "reconnecting" }),
		).run();

		expect(result.status).toBe("error");
		expect(result.meta).toEqual({ connection: "main", status: "reconnecting" });
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
	});

	it("warns at Adonis' warning default", async () => {
		const betweenTheTwo = 110 * 1024 * 1024;
		const result = await new QuasarMemoryUsageCheck(
			connectionWith({ info: async () => `used_memory:${betweenTheTwo}\r\n` }),
		).run();

		expect(result.status).toBe("warning");
	});

	const info = (used: number) => async () =>
		`# Memory\r\nused_memory:${used}\r\nmaxmemory:0\r\n`;

	it("stays ok below the warning threshold", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: info(100) }),
		)
			.warnWhenExceeds(400)
			.failWhenExceeds(800);
		const result = await check.run();
		expect(result.status).toBe("ok");
		expect(result.meta?.usedMemory).toBe(100);
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

	it("says so when INFO carries no used_memory", async () => {
		const check = new QuasarMemoryUsageCheck(
			connectionWith({ info: async () => "# Memory\r\n" }),
		);
		const result = await check.run();
		expect(result.status).toBe("error");
		expect(result.message).toContain("used_memory");
	});
});
