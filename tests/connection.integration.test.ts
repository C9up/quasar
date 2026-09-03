/**
 * Driven against a real server — a mock would prove nothing about the part
 * that actually bites: Redis refuses ordinary commands on a subscribed
 * socket, which is the whole reason this class opens a second one.
 *
 * Skipped, not failed, when no server answers on REDIS_TEST_URL (default
 * 127.0.0.1:6379): a contributor without Redis still gets a green suite.
 */

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";

const url = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";

async function serverAnswers(): Promise<boolean> {
	const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
	try {
		await probe.connect();
		await probe.ping();
		return true;
	} catch {
		return false;
	} finally {
		probe.disconnect();
	}
}

const live = await serverAnswers();
const connections: QuasarConnection[] = [];

function open(): QuasarConnection {
	const connection = new QuasarConnection("test", { url, db: 15 });
	connections.push(connection);
	return connection;
}

afterAll(() => {
	for (const connection of connections) connection.disconnect();
});

describe.skipIf(!live)("QuasarConnection against a live server", () => {
	it("runs ioredis commands straight off the connection", async () => {
		const connection = open();
		const key = `redis-test:${process.pid}:command`;

		await connection.set(key, "value", "EX", 30);
		expect(await connection.get(key)).toBe("value");
		expect(await connection.del(key)).toBe(1);
	});

	it("opens the subscriber socket only when something subscribes", async () => {
		const connection = open();
		expect(connection.ioSubscriberConnection).toBeUndefined();

		await connection.subscribe(`redis-test:${process.pid}:lazy`, () => {});
		expect(connection.ioSubscriberConnection).toBeDefined();
	});

	it("delivers a published message to the channel handler", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:channel`;
		const received: string[] = [];

		await connection.subscribe(channel, (message) => {
			received.push(message);
		});
		await connection.publish(channel, "hello");

		await expect.poll(() => received, { timeout: 5_000 }).toEqual(["hello"]);
	});

	it("keeps running commands while subscribed — the point of the second socket", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:mixed`;
		const key = `redis-test:${process.pid}:mixed-key`;

		await connection.subscribe(channel, () => {});
		// On a single socket Redis answers this with "only (P)SUBSCRIBE ... allowed".
		await connection.set(key, "still-works", "EX", 30);
		expect(await connection.get(key)).toBe("still-works");
		await connection.del(key);
	});

	it("routes pattern subscriptions with the channel that matched", async () => {
		const connection = open();
		const prefix = `redis-test:${process.pid}:pattern`;
		const seen: Array<[string, string, string]> = [];

		await connection.psubscribe(`${prefix}:*`, (channel, message, pattern) => {
			seen.push([channel, message, pattern]);
		});
		await connection.publish(`${prefix}:one`, "first");

		await expect
			.poll(() => seen, { timeout: 5_000 })
			.toEqual([[`${prefix}:one`, "first", `${prefix}:*`]]);
	});

	it("delivers to EVERY handler subscribed to a channel", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:stack`;
		const calls: string[] = [];

		// Two modules listening to one channel both get the message (Adonis
		// semantics). Replacing would make the second subscribe silently stop
		// the first.
		await connection.subscribe(channel, () => {
			calls.push("first");
		});
		await connection.subscribe(channel, () => {
			calls.push("second");
		});
		await connection.publish(channel, "once");

		await expect
			.poll(() => [...calls].sort(), { timeout: 5_000 })
			.toEqual(["first", "second"]);
	});

	it("unsubscribing ONE handler leaves the others receiving", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:partial`;
		const calls: string[] = [];
		const first = (): void => {
			calls.push("first");
		};

		await connection.subscribe(channel, first);
		await connection.subscribe(channel, () => {
			calls.push("second");
		});
		await connection.unsubscribe(channel, first);
		await connection.publish(channel, "once");

		// Only the remaining handler fires — and the socket stays subscribed,
		// which is the point of passing a handler to unsubscribe.
		await expect.poll(() => calls, { timeout: 5_000 }).toEqual(["second"]);
	});

	it("stops delivering after unsubscribe", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:unsub`;
		const calls: string[] = [];

		await connection.subscribe(channel, (message) => {
			calls.push(message);
		});
		await connection.publish(channel, "before");
		await expect.poll(() => calls, { timeout: 5_000 }).toEqual(["before"]);

		await connection.unsubscribe(channel);
		await connection.publish(channel, "after");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls).toEqual(["before"]);
	});

	it("closes both sockets on quit", async () => {
		const connection = new QuasarConnection("quit", { url, db: 15 });
		await connection.subscribe(`redis-test:${process.pid}:quit`, () => {});
		expect(connection.ioSubscriberConnection).toBeDefined();

		await connection.quit();
		expect(connection.ioSubscriberConnection).toBeUndefined();
		// QUIT resolves when the server acknowledges; the socket settles from
		// 'close' to 'end' a tick later, so poll rather than snapshot the race.
		await expect
			.poll(() => connection.ioConnection.status, { timeout: 5_000 })
			.toBe("end");
	});
});
