/**
 * What a connection does before it ever reaches a server.
 *
 * The integration suites skip when nothing answers on 6379, which left the
 * whole non-network half of the connection unexercised: the status readers, the
 * command dispatcher, and the error wiring — the part whose whole job is to
 * keep an `error` event from taking the process down.
 */
import { describe, expect, it, vi } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";

/**
 * A connection that never reaches a server, on any machine.
 *
 * `lazyConnect` builds the ioredis client without dialling, and
 * `enableOfflineQueue: false` makes a command issued before the socket is up
 * reject at once instead of waiting in the offline queue.
 *
 * Both matter. Without the second, the outcome depended on whether the
 * developer happened to have Redis on 6379: locally it answered and the
 * warm-up subscribe succeeded, so these tests passed for the wrong reason,
 * while CI has nothing listening and ioredis retried until the 5s timeout —
 * twelve failures that could not be reproduced on the machine that wrote them.
 * `retryStrategy` returning null stops the reconnect loop leaving a timer
 * behind after the run.
 */
const OFFLINE = {
	host: "127.0.0.1",
	port: 6379,
	lazyConnect: true,
	enableOfflineQueue: false,
	retryStrategy: () => null,
} as const;

const connection = (name = "main") =>
	new QuasarConnection(name, { ...OFFLINE });

describe("quasar > what a connection reports about itself", () => {
	it("answers to the Adonis spelling of its name too", () => {
		const c = connection("cache");

		expect(c.name).toBe("cache");
		expect(c.connectionName).toBe("cache");
	});

	it("reports ioredis' own status, and the questions built on it", () => {
		const c = connection();

		expect(c.status).toBe("wait");
		expect(c.isReady()).toBe(false);
		expect(c.isConnecting()).toBe(false);
		expect(c.isClosed()).toBe(false);
	});

	it("has no subscriber socket until a subscribe opens one", () => {
		const c = connection();

		expect(c.subscriberStatus).toBeUndefined();
		expect(c.ioSubscriberConnection).toBeUndefined();
	});

	it("exposes the underlying client for what it does not wrap", () => {
		const c = connection();

		expect(c.ioConnection).toBeDefined();
		expect(typeof c.autoPipelineQueueSize).toBe("number");
	});

	it("forwards the redis commands onto itself, bound", async () => {
		const c = connection();

		// The command surface is copied so `const { get } = connection` works.
		expect(typeof c.get).toBe("function");
		expect(typeof c.set).toBe("function");
		// Never over a method of its own.
		expect(c.subscribe).toBe(QuasarConnection.prototype.subscribe);
	});
});

describe("quasar > an error does not take the process down", () => {
	it("remembers the last error instead of throwing it", () => {
		const c = connection();
		const failure = new Error("ECONNREFUSED");

		// An `error` event with no listener is an uncaught exception in Node.
		expect(() => c.ioConnection.emit("error", failure)).not.toThrow();
		expect(c.lastError).toBe(failure);
	});

	it("forgets it once the connection comes back", () => {
		const c = connection();
		c.ioConnection.emit("error", new Error("ECONNREFUSED"));

		c.ioConnection.emit("ready");

		// ioredis reconnects on its own; a recovered connection must not keep
		// reporting the failure it already survived.
		expect(c.lastError).toBeUndefined();
	});

	it("reports through the logger it was given", () => {
		const logger = { error: vi.fn() };
		const c = new QuasarConnection("main", { ...OFFLINE }, logger);
		const failure = new Error("ECONNREFUSED");

		c.ioConnection.emit("error", failure);

		expect(logger.error).toHaveBeenCalledWith(
			{ err: failure, connection: "main" },
			"Redis connection failure",
		);
	});

	it("stops reporting, but keeps recording, after doNotLogErrors()", () => {
		const logger = { error: vi.fn() };
		const c = new QuasarConnection("main", { ...OFFLINE }, logger);

		expect(c.doNotLogErrors()).toBe(c);
		const failure = new Error("ECONNREFUSED");
		c.ioConnection.emit("error", failure);

		// Silencing the log must not detach the listener — that is the thing
		// keeping the process alive.
		expect(logger.error).not.toHaveBeenCalled();
		expect(c.lastError).toBe(failure);
	});

	it("falls back to the console when no logger was given", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const c = connection();

		c.ioConnection.emit("error", new Error("ECONNREFUSED"));

		expect(spy).toHaveBeenCalledWith(
			"[redis] connection failure",
			expect.objectContaining({ connection: "main" }),
		);
		spy.mockRestore();
	});
});

describe("quasar > scripts registered as commands", () => {
	it("says the command was never defined, rather than failing obscurely", () => {
		const c = connection("cache");

		expect(() => c.runCommand("release")).toThrow(
			/no command "release" on connection "cache"/,
		);
	});

	it("calls a script once it has been defined", async () => {
		const c = connection();
		c.defineCommand("release", {
			numberOfKeys: 1,
			lua: "return redis.call('del', KEYS[1])",
		});

		// The script is registered on the client; running it for real is the
		// integration suite's job. What matters here is that the dispatcher
		// found it rather than refusing.
		//
		// The call is awaited and its failure swallowed: with no socket the
		// command rejects at once, and an unawaited rejection is reported as an
		// unhandled error for the whole run.
		await expect(c.runCommand("release", "lock:1")).rejects.toThrow(
			/isn't writeable/,
		);
	});

	it("hands defineCommand back for chaining", () => {
		const c = connection();

		expect(c.defineCommand("noop", { numberOfKeys: 0, lua: "return 1" })).toBe(
			c,
		);
	});
});

describe("quasar > pub/sub without a server answering", () => {
	/**
	 * The first subscribe fails (nothing is listening) but opens the socket,
	 * which is then stubbed so the success path can run. This is the only way
	 * to reach the dispatch logic without a live server.
	 */
	const withSubscriber = async (c: QuasarConnection) => {
		await c.subscribe("warm-up", () => {});
		const subscriber = c.ioSubscriberConnection;
		if (!subscriber) throw new Error("the subscribe should have opened one");
		vi.spyOn(subscriber, "subscribe").mockResolvedValue(1);
		vi.spyOn(subscriber, "psubscribe").mockResolvedValue(1);
		vi.spyOn(subscriber, "unsubscribe").mockResolvedValue("OK");
		vi.spyOn(subscriber, "punsubscribe").mockResolvedValue("OK");
		return subscriber;
	};

	it("reports a handler that rejects instead of letting it escape", async () => {
		const errors: unknown[] = [];
		const c = new QuasarConnection(
			"main",
			{ ...OFFLINE },
			{ error: (payload: unknown) => errors.push(payload) },
		);
		const subscriber = await withSubscriber(c);
		await c.subscribe("orders", () =>
			Promise.reject(new Error("handler blew up")),
		);

		subscriber.emit("message", "orders", "{}");
		await new Promise((resolve) => setTimeout(resolve, 10));

		// A message handler is an event callback — nobody awaits it — so a
		// rejection had nowhere to go and surfaced as an unhandledRejection,
		// which some runtimes turn into an exit.
		expect(errors.length).toBeGreaterThan(0);
	});

	it("reports a handler that throws synchronously, and still runs the rest", async () => {
		const errors: unknown[] = [];
		const c = new QuasarConnection(
			"main",
			{ ...OFFLINE },
			{ error: (payload: unknown) => errors.push(payload) },
		);
		const subscriber = await withSubscriber(c);
		const reached: string[] = [];

		// `Promise.resolve(handler(...))` CALLS the handler before the promise
		// exists, so a synchronous throw never reached the `.catch`: it unwound
		// the dispatch loop and escaped into the Redis client's own callback,
		// taking every later handler on the channel with it.
		await c.subscribe("orders", () => {
			reached.push("first");
			throw new Error("sync boom");
		});
		await c.subscribe("orders", () => {
			reached.push("second");
		});

		subscriber.emit("message", "orders", "{}");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(reached).toEqual(["first", "second"]);
		expect(errors.length).toBeGreaterThan(0);
	});

	it("hands a failed subscribe to the caller instead of throwing", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const failure = new Error("NOAUTH");
		vi.spyOn(subscriber, "subscribe").mockRejectedValue(failure);
		const onError = vi.fn();
		const emitted: Array<{ error: unknown }> = [];
		c.ioConnection.on("subscription:error", (e: { error: unknown }) =>
			emitted.push(e),
		);

		// A subscribe that throws inside a boot sequence takes the app down.
		await expect(
			c.subscribe("orders", () => {}, { onError }),
		).resolves.toBeUndefined();

		expect(onError).toHaveBeenCalledWith(failure);
		expect(emitted[0].error).toBe(failure);
	});

	it("does the same for a pattern subscribe", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const failure = new Error("NOAUTH");
		vi.spyOn(subscriber, "psubscribe").mockRejectedValue(failure);
		const onError = vi.fn();
		const emitted: Array<{ error: unknown }> = [];
		c.ioConnection.on("psubscription:error", (e: { error: unknown }) =>
			emitted.push(e),
		);

		await expect(
			c.psubscribe("user:*", () => {}, { onError }),
		).resolves.toBeUndefined();

		expect(onError).toHaveBeenCalledWith(failure);
		expect(emitted[0].error).toBe(failure);
	});

	it("logs a failed subscribe as well as reporting it", async () => {
		const logger = { error: vi.fn() };
		const c = new QuasarConnection("main", { ...OFFLINE }, logger);
		const subscriber = await withSubscriber(c);
		vi.spyOn(subscriber, "subscribe").mockRejectedValue(new Error("NOAUTH"));
		logger.error.mockClear();

		await c.subscribe("orders", () => {});

		expect(logger.error).toHaveBeenCalledOnce();
	});

	it("announces the subscription count once it is established", async () => {
		const c = connection();
		await withSubscriber(c);
		const onSubscription = vi.fn();
		const ready: Array<{ count: number }> = [];
		c.ioConnection.on("subscription:ready", (e: { count: number }) =>
			ready.push(e),
		);

		await c.subscribe("orders", () => {}, { onSubscription });

		expect(onSubscription).toHaveBeenCalledWith(1);
		expect(ready[0].count).toBe(1);
	});

	it("delivers a message to every handler on the channel", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const first = vi.fn();
		const second = vi.fn();
		await c.subscribe("orders", first);
		await c.subscribe("orders", second);

		subscriber.emit("message", "orders", "payload");

		expect(first).toHaveBeenCalledWith("payload", "orders");
		expect(second).toHaveBeenCalledWith("payload", "orders");
	});

	it("delivers a pattern message with the pattern that matched", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const handler = vi.fn();
		await c.psubscribe("user:*", handler);

		subscriber.emit("pmessage", "user:*", "user:7", "payload");

		expect(handler).toHaveBeenCalledWith("payload", "user:7", "user:*");
	});

	it("drops nothing on a channel nobody is listening to", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);

		expect(() =>
			subscriber.emit("message", "unknown", "payload"),
		).not.toThrow();
		expect(() =>
			subscriber.emit("pmessage", "unknown:*", "unknown:1", "payload"),
		).not.toThrow();
	});

	it("keeps the socket subscribed while another handler still wants it", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const first = vi.fn();
		const second = vi.fn();
		await c.subscribe("orders", first);
		await c.subscribe("orders", second);

		await c.unsubscribe("orders", first);
		subscriber.emit("message", "orders", "payload");

		// Dropping one listener must not cut the other one off.
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
		expect(subscriber.unsubscribe).not.toHaveBeenCalledWith("orders");
	});

	it("leaves the channel once the last handler is gone", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const handler = vi.fn();
		await c.subscribe("orders", handler);

		await c.unsubscribe("orders", handler);

		expect(subscriber.unsubscribe).toHaveBeenCalledWith("orders");
	});

	it("leaves the channel outright when no handler is named", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		await c.subscribe("orders", () => {});
		await c.subscribe("orders", () => {});

		await c.unsubscribe("orders");

		expect(subscriber.unsubscribe).toHaveBeenCalledWith("orders");
	});

	it("does the same for patterns", async () => {
		const c = connection();
		const subscriber = await withSubscriber(c);
		const first = vi.fn();
		const second = vi.fn();
		await c.psubscribe("user:*", first);
		await c.psubscribe("user:*", second);

		await c.punsubscribe("user:*", first);
		expect(subscriber.punsubscribe).not.toHaveBeenCalledWith("user:*");

		await c.punsubscribe("user:*", second);
		expect(subscriber.punsubscribe).toHaveBeenCalledWith("user:*");
	});

	it("unsubscribes from a channel it never joined without opening a socket", async () => {
		const c = connection();

		await c.unsubscribe("never");
		await c.punsubscribe("never:*");

		expect(c.ioSubscriberConnection).toBeUndefined();
	});

	it("reports an error on the subscriber socket too", async () => {
		const logger = { error: vi.fn() };
		const c = new QuasarConnection("main", { ...OFFLINE }, logger);
		const subscriber = await withSubscriber(c);
		logger.error.mockClear();

		subscriber.emit("error", new Error("subscriber down"));

		expect(logger.error).toHaveBeenCalledOnce();
	});
});
