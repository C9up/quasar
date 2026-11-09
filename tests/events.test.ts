/**
 * Events with upstream's payloads, on an emitter quasar owns.
 *
 * `connection.on(...)` used to be ioredis' own EventEmitter, forwarded: a
 * listener written as upstream documents it (`({ error, connection }) => …`)
 * received a bare Error and read `undefined` twice. And because every ioredis
 * function was forwarded, `removeAllListeners()` reached the client and tore
 * off the listeners quasar itself depends on.
 */
import { describe, expect, it, vi } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";
import { QuasarManager } from "../src/QuasarManager.js";

const OFFLINE = {
	host: "127.0.0.1",
	port: 6379,
	lazyConnect: true,
	enableOfflineQueue: false,
	retryStrategy: () => null,
} as const;

function connection(logger = { error: vi.fn() }) {
	return new QuasarConnection("main", { ...OFFLINE }, logger);
}

describe("quasar > connection events carry upstream's payloads", () => {
	it("error → { error, connection }", () => {
		const c = connection();
		const listener = vi.fn();
		c.on("error", listener);
		const failure = new Error("ECONNREFUSED");

		c.ioConnection.emit("error", failure);

		expect(listener).toHaveBeenCalledWith({ error: failure, connection: c });
	});

	it("reconnecting → { connection, waitTime }", () => {
		const c = connection();
		const listener = vi.fn();
		c.on("reconnecting", listener);

		c.ioConnection.emit("reconnecting", 250);

		expect(listener).toHaveBeenCalledWith({ connection: c, waitTime: 250 });
	});

	for (const event of ["connect", "wait", "ready", "close", "end"] as const) {
		it(`${event} → { connection }`, () => {
			const c = connection();
			const listener = vi.fn();
			c.on(event, listener);

			c.ioConnection.emit(event);

			expect(listener).toHaveBeenCalledWith({ connection: c });
		});
	}

	it("node:error → { error, address, connection }", () => {
		const c = connection();
		const listener = vi.fn();
		c.on("node:error", listener);
		const failure = new Error("MOVED");

		c.ioConnection.emit("node error", failure, "10.0.0.1:7000");

		expect(listener).toHaveBeenCalledWith({
			error: failure,
			address: "10.0.0.1:7000",
			connection: c,
		});
	});

	it("subscriber:error → { error, connection }, and the error is recorded", async () => {
		const c = connection();
		await c.subscribed("warm-up", () => {}).catch(() => undefined);
		const subscriber = c.ioSubscriberConnection;
		if (!subscriber) throw new Error("the subscribe should have opened one");
		const listener = vi.fn();
		c.on("subscriber:error", listener);
		const failure = new Error("subscriber down");

		subscriber.emit("error", failure);

		expect(listener).toHaveBeenCalledWith({ error: failure, connection: c });
		expect(c.lastSubscriberError).toBe(failure);
	});

	it("subscriber:reconnecting → { connection, waitTime }", async () => {
		const c = connection();
		await c.subscribed("warm-up", () => {}).catch(() => undefined);
		const listener = vi.fn();
		c.on("subscriber:reconnecting", listener);

		c.ioSubscriberConnection?.emit("reconnecting", 100);

		expect(listener).toHaveBeenCalledWith({ connection: c, waitTime: 100 });
	});

	it("once() answers the next payload, and on() hands back its own off switch", async () => {
		const c = connection();
		const listener = vi.fn();
		const stop = c.on("ready", listener);
		const next = c.once("ready");

		c.ioConnection.emit("ready");
		stop();
		c.ioConnection.emit("ready");

		expect(await next).toEqual({ connection: c });
		expect(listener).toHaveBeenCalledOnce();
	});

	it("reports a listener that throws instead of letting it escape", async () => {
		const logger = { error: vi.fn() };
		const c = connection(logger);
		c.doNotLogErrors();
		c.on("ready", () => {
			throw new Error("listener blew up");
		});

		expect(() => c.ioConnection.emit("ready")).not.toThrow();
		await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
	});

	it("does not throw for an error nobody listens to", () => {
		const c = connection();

		expect(() => c.ioConnection.emit("error", new Error("x"))).not.toThrow();
	});
});

describe("quasar > the manager announces each connection it opens", () => {
	const config = {
		connection: "main" as const,
		connections: {
			main: { ...OFFLINE },
			cache: { ...OFFLINE, db: 1 },
		},
	};

	it("emits connection once per new connection, never on a cache hit", async () => {
		const manager = new QuasarManager(config);
		const opened: QuasarConnection[] = [];
		manager.on("connection", (connection) => {
			opened.push(connection);
		});

		const main = manager.connection("main");
		manager.connection("main");
		const cache = manager.connection("cache");
		await vi.waitFor(() => expect(opened).toHaveLength(2));

		expect(opened).toEqual([main, cache]);
		await manager.disconnectAll();
	});
});

describe("quasar > only Redis commands are forwarded", () => {
	it("leaves out sharded pub/sub, which would poison the command socket", () => {
		const c = connection();
		const manager = new QuasarManager({
			connection: "main",
			connections: { main: { ...OFFLINE } },
		});

		for (const command of ["ssubscribe", "sunsubscribe"]) {
			expect(command in c).toBe(false);
			expect(command in manager).toBe(false);
		}
		// Publishing is a plain command and stays.
		expect(typeof c.spublish).toBe("function");
	});

	it("does not hand out ioredis' EventEmitter", () => {
		const c = connection();
		const manager = new QuasarManager({
			connection: "main",
			connections: { main: { ...OFFLINE } },
		});

		for (const method of [
			"removeAllListeners",
			"removeListener",
			"addListener",
		]) {
			expect(method in c).toBe(false);
			expect(method in manager).toBe(false);
		}
		expect(c.on).not.toBe(c.ioConnection.on);
	});

	it("keeps the error recorder and the eviction after a public teardown", () => {
		const logger = { error: vi.fn() };
		const manager = new QuasarManager(
			{ connection: "main", connections: { main: { ...OFFLINE } } },
			logger,
		);
		const c = manager.connection();
		c.on("error", () => {});

		c.clearListeners();
		manager.clearListeners();
		const failure = new Error("ECONNREFUSED");
		c.ioConnection.emit("error", failure);
		c.ioConnection.emit("end");

		expect(c.lastError).toBe(failure);
		expect(logger.error).toHaveBeenCalledOnce();
		expect(manager.activeConnectionNames).toEqual([]);
	});
});
