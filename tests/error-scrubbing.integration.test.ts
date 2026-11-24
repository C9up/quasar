/**
 * A rejected command must not hand its arguments to whoever reads the error.
 *
 * ioredis attaches the failed command to a reply error, arguments included —
 * for a rejected handshake that is `HELLO 3 AUTH <user> <password>`. Quasar
 * keeps that error as `lastError`, logs it, emits it and its health check
 * reports on it, so the configured credentials ended up in a log line and in
 * an unauthenticated health report. Driven against a real server: the shape
 * of the error is ioredis', and only a real rejection produces it.
 *
 * Needs REDIS_TEST_URL (see _support/redisTestUrl.ts).
 */
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QuasarCheck } from "../src/health.js";
import type { QuasarLogger } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";
import { redisTestUrl } from "./_support/redisTestUrl.js";

const url = redisTestUrl();
const admin = new Redis(url, { lazyConnect: true });
const target = new URL(url);

const USER = `quasar-scrub-${process.pid}`;
const RIGHT = `right-${process.pid}-pw`;
const WRONG = `Configured-${process.pid}-Passw0rd`;

beforeAll(async () => {
	await admin.acl("SETUSER", USER, "reset", "on", `>${RIGHT}`, "~*", "+@all");
});

afterAll(async () => {
	await admin.acl("DELUSER", USER);
	admin.disconnect();
});

/**
 * Every log call, written as a JSON log line writes it: an error's own
 * enumerable properties, as a structured logger's `err` serializer copies
 * them, plus its message.
 */
function capturingLogger(): { logger: QuasarLogger; lines: string[] } {
	const lines: string[] = [];
	const asLine = (value: unknown): string =>
		JSON.stringify(value, (_key, field: unknown) =>
			field instanceof Error ? { ...field, message: field.message } : field,
		);
	const record = (message: string, data?: Record<string, unknown>): void =>
		void lines.push(asLine({ message, ...data }));
	return { lines, logger: { error: record } };
}

function manager(
	password: string,
	options: { logger?: QuasarLogger; protocol?: 2 | 3 } = {},
) {
	return new QuasarManager(
		{
			connection: "main",
			connections: {
				main: {
					host: target.hostname,
					port: Number(target.port || 6379),
					username: USER,
					password,
					protocol: options.protocol,
					retryStrategy: (times: number) => (times > 10 ? null : times * 50),
				},
			},
		},
		options.logger,
	);
}

describe("quasar > a rejected handshake keeps the credentials out of every error", () => {
	for (const protocol of [3, 2] as const) {
		it(`log line, error event, lastError and health report (RESP${protocol})`, async () => {
			const { logger, lines } = capturingLogger();
			const redis = manager(WRONG, { logger, protocol });
			const connection = redis.connection();
			const seen: unknown[] = [];
			connection.on("error", (payload: { error: unknown }) => {
				seen.push(payload.error);
			});

			const report = await new QuasarCheck(connection).run();
			await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

			const everything = JSON.stringify({
				report,
				lines,
				seen,
				lastError: connection.lastError,
			});
			expect(lines.length).toBeGreaterThan(0);
			expect(everything).not.toContain(WRONG);
			expect(everything).not.toContain(USER);
			expect(report.message).toBe("Unable to connect to the redis server");
			expect(report.meta?.error).toEqual({
				name: expect.any(String),
				code: "WRONGPASS",
			});
			// The command is still named: that much helps an operator.
			expect(connection.lastError).toMatchObject({
				command: { name: protocol === 3 ? "hello" : "auth" },
			});
			await redis.disconnectAll();
		}, 20_000);
	}

	it("the right credentials still connect", async () => {
		const redis = manager(RIGHT);
		const report = await new QuasarCheck(redis.connection()).run();
		expect(report.status).toBe("ok");
		await redis.disconnectAll();
	});
});

describe("quasar > a rejected command does not carry the values it sent", () => {
	const key = `quasar-scrub-key-${process.pid}`;

	afterAll(async () => {
		await admin.del(key);
	});

	it("a direct command, a pipeline and a transaction", async () => {
		const redis = manager(RIGHT);
		const connection = redis.connection();
		await connection.set(key, "a string");

		// HSET on a string key: WRONGTYPE, with the field value in the command.
		const direct = await connection
			.hset(key, "token", "direct-secret")
			.catch((error: unknown) => error);
		expect(direct).toBeInstanceOf(Error);
		expect(direct).toMatchObject({ command: { name: "hset" } });
		expect(JSON.stringify(direct)).not.toContain("direct-secret");

		const piped = await connection
			.pipeline()
			.hset(key, "token", "pipeline-secret")
			.exec();
		expect(JSON.stringify(piped?.[0]?.[0])).not.toContain("pipeline-secret");
		expect(piped?.[0]?.[0]).toMatchObject({ command: { name: "hset" } });

		const multi = await connection
			.multi()
			.hset(key, "token", "multi-secret")
			.exec()
			.catch((error: unknown) => error);
		expect(JSON.stringify(multi)).not.toContain("multi-secret");

		// The command itself is untouched: the value really went out.
		expect(await connection.get(key)).toBe("a string");
		await redis.disconnectAll();
	});
});
