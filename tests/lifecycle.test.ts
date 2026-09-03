/**
 * What happens to a connection after it stops working.
 *
 * Everything here is about the second half of a socket's life — the half no
 * test reached before, because reaching it needs a server to go away rather
 * than never answer. The failures it covers are quiet ones: a shutdown that
 * throws, a manager handing back a corpse, a subscriber that stops delivering
 * with nothing reporting it.
 */

import { describe, expect, it, vi } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";

/** Never reaches a server, on any machine, and gives up rather than retrying. */
const OFFLINE = {
	host: "127.0.0.1",
	port: 6399,
	lazyConnect: true,
	enableOfflineQueue: false,
	retryStrategy: () => null,
} as const;

const connection = (name = "main") =>
	new QuasarConnection(name, { ...OFFLINE }).doNotLogErrors();

/** Let ioredis' own `end` listeners run before asserting on what they did. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("quasar > closing a connection that is already gone", () => {
	/**
	 * ioredis rejects every command issued on an ended connection, and QUIT is
	 * a command. The rejection travelled through `Promise.all` and out of the
	 * provider's `shutdown`, so one socket that had died on its own aborted the
	 * shutdown of every other one.
	 */
	it("quits a socket that already ended without rejecting", async () => {
		const c = connection();
		c.ioConnection.disconnect();
		expect(c.status).toBe("end");

		await expect(c.quit()).resolves.toBeUndefined();
	});

	/**
	 * A `wait` socket has never dialled. QUIT being a command, sending it would
	 * open a connection for the sole purpose of closing it — against a server
	 * that, on a shutdown path, may already be gone.
	 */
	it("closes a socket that never dialled without dialling it", async () => {
		const c = connection();
		expect(c.status).toBe("wait");

		await c.quit();

		expect(c.status).toBe("end");
	});
});

describe("quasar > a connection whose socket ended is not handed back again", () => {
	/**
	 * `connection()` caches, so without this the manager returns the same dead
	 * object for the rest of the process: every command on it rejects, and
	 * nothing ever opens a live one.
	 */
	it("stops tracking it, so the next call opens a new one", async () => {
		const manager = new QuasarManager({
			connection: "main",
			connections: { main: { ...OFFLINE } },
		}).doNotLogErrors();
		const first = manager.connection();

		first.ioConnection.disconnect();
		await settled();

		expect(manager.activeConnectionNames).toEqual([]);
		expect(manager.connection()).not.toBe(first);
	});

	it("leaves a live connection alone", () => {
		const manager = new QuasarManager({
			connection: "main",
			connections: { main: { ...OFFLINE } },
		}).doNotLogErrors();

		expect(manager.connection()).toBe(manager.connection());
		expect(manager.activeConnectionNames).toEqual(["main"]);
	});
});

describe("quasar > a subscriber socket that ended is replaced", () => {
	/**
	 * The socket is cached too. Reusing an ended one makes every later
	 * subscribe reject — reported through `onError` as if the channel were at
	 * fault — and the application silently stops receiving.
	 */
	it("opens a fresh one on the next subscribe", async () => {
		const c = connection();
		await c.subscribe("chan", () => {});
		const dead = c.ioSubscriberConnection;
		expect(dead).toBeDefined();

		dead?.disconnect();
		await settled();

		expect(c.ioSubscriberConnection).toBeUndefined();

		await c.subscribe("other", () => {});
		expect(c.ioSubscriberConnection).toBeDefined();
		expect(c.ioSubscriberConnection).not.toBe(dead);
	});

	/**
	 * The subscriptions only ever existed on that socket. Keeping them would
	 * have the connection report channels it is no longer subscribed to, and
	 * deliver nothing to their handlers.
	 */
	it("forgets the subscriptions that lived on it", async () => {
		const c = connection();
		const handler = vi.fn();
		await c.subscribe("chan", handler);
		const dead = c.ioSubscriberConnection;

		dead?.disconnect();
		await settled();
		await c.subscribe("other", () => {});

		// The dead socket cannot deliver, and the live one never joined "chan".
		c.ioSubscriberConnection?.emit("message", "chan", "payload");
		expect(handler).not.toHaveBeenCalled();
	});
});
