/**
 * Driven against a real server — a mock would prove nothing about the part
 * that actually bites: Redis refuses ordinary commands on a subscribed
 * socket, which is the whole reason this class opens a second one.
 *
 * Skipped, not failed, when no server answers on REDIS_TEST_URL (default
 * 127.0.0.1:6379): a contributor without Redis still gets a green suite.
 */

import { Secret } from "@c9up/ream";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";
import { redisTestUrl } from "./_support/redisTestUrl.js";

const url = redisTestUrl();

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

		await connection.subscribed(`redis-test:${process.pid}:lazy`, () => {});
		expect(connection.ioSubscriberConnection).toBeDefined();
	});

	it("delivers a published message to the channel handler", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:channel`;
		const received: string[] = [];

		await connection.subscribed(channel, (message) => {
			received.push(message);
		});
		await connection.publish(channel, "hello");

		await expect.poll(() => received, { timeout: 5_000 }).toEqual(["hello"]);
	});

	it("keeps running commands while subscribed — the point of the second socket", async () => {
		const connection = open();
		const channel = `redis-test:${process.pid}:mixed`;
		const key = `redis-test:${process.pid}:mixed-key`;

		await connection.subscribed(channel, () => {});
		// On a single socket Redis answers this with "only (P)SUBSCRIBE ... allowed".
		await connection.set(key, "still-works", "EX", 30);
		expect(await connection.get(key)).toBe("still-works");
		await connection.del(key);
	});

	it("routes pattern subscriptions with the channel that matched", async () => {
		const connection = open();
		const prefix = `redis-test:${process.pid}:pattern`;
		const seen: Array<[string, string, string]> = [];

		await connection.psubscribed(`${prefix}:*`, (channel, message, pattern) => {
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
		await connection.subscribed(channel, () => {
			calls.push("first");
		});
		await connection.subscribed(channel, () => {
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

		await connection.subscribed(channel, first);
		await connection.subscribed(channel, () => {
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

		await connection.subscribed(channel, (message) => {
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
		await connection.subscribed(`redis-test:${process.pid}:quit`, () => {});
		expect(connection.ioSubscriberConnection).toBeDefined();

		await connection.quit();
		expect(connection.ioSubscriberConnection).toBeUndefined();
		// QUIT resolves when the server acknowledges; the socket settles from
		// 'close' to 'end' a tick later, so poll rather than snapshot the race.
		await expect
			.poll(() => connection.ioConnection.status, { timeout: 5_000 })
			.toBe("end");
	});

	/**
	 * Closing a connection drops its subscriptions. The handlers used to
	 * survive in the registry, so a later subscribe on the same connection
	 * revived them next to the new one: a listener torn down with a tenant or
	 * a client went on receiving its successor's messages.
	 */
	for (const close of ["quit", "disconnect"] as const) {
		it(`forgets every handler on ${close}(), so a later subscribe starts clean`, async () => {
			const connection = new QuasarConnection(close, { url, db: 15 });
			connections.push(connection);
			const publisher = open();
			const channel = `redis-test:${process.pid}:${close}-stale`;
			const prefix = `redis-test:${process.pid}:${close}-pstale`;
			const calls: string[] = [];

			await connection.subscribed(channel, (message) => {
				calls.push(`old:${message}`);
			});
			await connection.psubscribed(`${prefix}:*`, (matched, message) => {
				calls.push(`old-pattern:${matched}=${message}`);
			});
			await connection[close]();

			await connection.subscribed(channel, (message) => {
				calls.push(`new:${message}`);
			});
			await connection.psubscribed(`${prefix}:*`, (matched, message) => {
				calls.push(`new-pattern:${matched}=${message}`);
			});
			await publisher.publish(channel, "o1");
			await publisher.publish(`${prefix}:1`, "p1");

			await expect
				.poll(() => [...calls].sort(), { timeout: 3_000 })
				.toEqual([`new-pattern:${prefix}:1=p1`, "new:o1"]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect([...calls].sort()).toEqual([
				`new-pattern:${prefix}:1=p1`,
				"new:o1",
			]);
		});
	}
});

/**
 * Against a server that requires a password: a Secret must authenticate both
 * sockets, not send AUTH '[redacted]'.
 */
describe.skipIf(!live)("QuasarConnection with a Secret password", () => {
	const user = `quasar-secret-${process.pid}`;
	const admin = new Redis(url, { lazyConnect: true });

	afterAll(async () => {
		await admin.acl("DELUSER", user);
		admin.disconnect();
	});

	it("authenticates the command and the subscriber socket", async () => {
		await admin.acl("SETUSER", user, "on", ">s3cret", "~*", "&*", "+@all");
		const connection = new QuasarConnection("secret", {
			url,
			username: user,
			password: new Secret("s3cret"),
		});
		connections.push(connection);
		const channel = `redis-test:${process.pid}:secret`;
		const received: string[] = [];

		expect(await connection.ping()).toBe("PONG");
		await connection.subscribed(channel, (message) => {
			received.push(message);
		});
		await connection.publish(channel, "authenticated");

		await expect
			.poll(() => received, { timeout: 3_000 })
			.toEqual(["authenticated"]);
	});
});
