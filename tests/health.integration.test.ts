/**
 * A health check must never reopen a connection the application closed.
 *
 * Checks are built once, at boot, around a connection. A readiness probe that
 * lands during a graceful drain — the normal case behind an orchestrator —
 * found that connection closed and dialled it again. The manager no longer
 * tracked it, so the next `quitAll()` left it open and the process hung
 * instead of exiting.
 */
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { QuasarCheck, QuasarMemoryUsageCheck } from "../src/health.js";
import { QuasarConnection } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";
import { redisTestUrl } from "./_support/redisTestUrl.js";

const url = redisTestUrl();
const admin = new Redis(url, { lazyConnect: true });

afterAll(() => {
	admin.disconnect();
});

/** How many sockets the server holds under this client name. */
async function clientsNamed(name: string): Promise<number> {
	const list = String(await admin.client("LIST"));
	return list.split("\n").filter((line) => line.includes(` name=${name} `))
		.length;
}

function managerNamed(name: string, retryStrategy?: () => null) {
	return new QuasarManager({
		connection: "main",
		connections: { main: { url, connectionName: name, retryStrategy } },
	}).doNotLogErrors();
}

describe("quasar > a health check after the connection was given up", () => {
	it("reports error after quitAll and opens nothing", async () => {
		const name = `quasar-health-quit-${process.pid}`;
		const manager = managerNamed(name);
		const connection = manager.connection();
		const check = new QuasarCheck(connection);
		expect((await check.run()).status).toBe("ok");

		await manager.quitAll();
		await vi.waitFor(() => expect(connection.status).toBe("end"));

		const result = await check.run();
		expect(result.status).toBe("error");
		expect(connection.status).toBe("end");
		expect((await new QuasarMemoryUsageCheck(connection).run()).status).toBe(
			"error",
		);

		await manager.quitAll();
		expect(await clientsNamed(name)).toBe(0);
	});

	it("reports error once the manager evicted it, and leaves no extra client", async () => {
		const name = `quasar-health-evict-${process.pid}`;
		const manager = managerNamed(name, () => null);
		const connection = manager.connection();
		const check = new QuasarCheck(connection);
		expect((await check.run()).status).toBe("ok");

		const id = await connection.ioConnection.client("ID");
		await admin.client("KILL", "ID", String(id));
		await vi.waitFor(() => expect(manager.activeConnectionNames).toEqual([]));

		expect((await check.run()).status).toBe("error");
		expect(connection.status).toBe("end");
		expect(await clientsNamed(name)).toBe(0);
	});

	it("still dials once a closed connection that nothing manages", async () => {
		const name = `quasar-health-standalone-${process.pid}`;
		const connection = new QuasarConnection("main", {
			url,
			connectionName: name,
		}).doNotLogErrors();
		const check = new QuasarCheck(connection);
		expect((await check.run()).status).toBe("ok");

		// Closed under quasar, not through it: nobody retired it, so this is
		// upstream's case and the check reconnects it once.
		connection.ioConnection.disconnect();
		await vi.waitFor(() => expect(connection.status).toBe("end"));

		expect((await check.run()).status).toBe("ok");
		await connection.quit();
		await vi.waitFor(() => expect(connection.status).toBe("end"));
		expect(await clientsNamed(name)).toBe(0);
	});
});
