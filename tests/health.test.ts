import { describe, expect, it } from "vitest";
import { QuasarCheck, QuasarMemoryUsageCheck } from "../src/health.js";
import type { QuasarConnection } from "../src/QuasarConnection.js";

/** A connection stand-in carrying only what the checks read. */
function connectionWith(io: {
	ping?: () => Promise<string>;
	info?: () => Promise<string>;
}) {
	const connection = { name: "main", ioConnection: io };
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

describe("QuasarMemoryUsageCheck", () => {
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
