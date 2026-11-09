/**
 * Every command quasar sends is published on `quasar.redis.command`, the
 * framework-owned counterpart of upstream's `adonisjs.redis.command`, so an
 * APM or a metrics package can time Redis without the app wiring anything.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tracingChannels } from "../src/index.js";
import { QuasarConnection } from "../src/QuasarConnection.js";
import type { RedisCommandTracingData } from "../src/tracing.js";
import { redisTestUrl } from "./_support/redisTestUrl.js";

const url = redisTestUrl();
const { redisCommand } = tracingChannels;
const connection = new QuasarConnection("traced", { url, db: 15 });

type Seen = { phase: string; context: RedisCommandTracingData };
let seen: Seen[] = [];
const record = (phase: string) => (context: RedisCommandTracingData) => {
	seen.push({ phase, context });
};
const handlers = {
	start: record("start"),
	end: record("end"),
	asyncStart: record("asyncStart"),
	asyncEnd: record("asyncEnd"),
	error: record("error"),
};

afterEach(() => {
	redisCommand.unsubscribe(handlers);
	seen = [];
});

afterAll(async () => {
	await connection.quit();
});

const key = `redis-test:${process.pid}:traced`;

describe("quasar > the command tracing channel", () => {
	it("is named for the framework", () => {
		expect(redisCommand.start.name).toBe("tracing:quasar.redis.command:start");
	});

	it("traces a command from start to its reply, by name only", async () => {
		await connection.set(key, "private-value", "EX", 30);
		redisCommand.subscribe(handlers);

		expect(await connection.get(key)).toBe("private-value");

		const phases = seen
			.filter((entry) => entry.context.command === "get")
			.map((entry) => entry.phase);
		expect(phases).toEqual(["start", "end", "asyncStart", "asyncEnd"]);
		const context = seen[0]?.context;
		expect(context?.connection).toBe("traced");
		// The arguments carry keys and values — PII, secrets — and are not
		// part of the payload.
		expect(JSON.stringify(context)).not.toContain(key);
	});

	it("reports a command the server rejects", async () => {
		await connection.set(key, "not-a-number", "EX", 30);
		redisCommand.subscribe(handlers);

		await expect(connection.incr(key)).rejects.toThrow(/not an integer/);

		const failure = seen.find((entry) => entry.phase === "error");
		expect(failure?.context.command).toBe("incr");
	});

	it("traces the subscriber socket too", async () => {
		redisCommand.subscribe(handlers);

		await connection.subscribed(`${key}:channel`, () => {});

		expect(
			seen.some(
				(entry) =>
					entry.phase === "start" && entry.context.command === "subscribe",
			),
		).toBe(true);
	});

	it("leaves commands untouched when nobody listens", async () => {
		await connection.set(key, "plain", "EX", 30);

		expect(await connection.get(key)).toBe("plain");
		expect(seen).toEqual([]);
	});
});
