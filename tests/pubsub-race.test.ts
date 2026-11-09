/**
 * A message the server sends right behind the SUBSCRIBE ack must reach the
 * handler.
 *
 * ioredis resolves the subscribe promise while it parses a reply chunk and
 * emits whatever follows in that same chunk synchronously; the code after an
 * `await` runs a microtask later. Registering the handler only once the ack
 * was awaited dropped every message Redis batched into the ack's TCP read —
 * which is what a PUBLISH processed in the same event-loop tick produces.
 *
 * A fake server makes it deterministic: it answers the subscribe with the ack
 * and a message in ONE write.
 */
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuasarConnection } from "../src/QuasarConnection.js";

function bulk(value: string): string {
	return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
const connections: QuasarConnection[] = [];

afterEach(async () => {
	for (const connection of connections.splice(0)) await connection.disconnect();
	for (const socket of sockets.splice(0)) socket.destroy();
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise((resolve) => server.close(resolve))),
	);
});

/** A server that answers the first (p)subscribe with `reply`, in one write. */
async function fakeServer(reply: string): Promise<number> {
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("data", (chunk) => {
			if (/subscribe/i.test(chunk.toString())) socket.write(reply);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the fake server has no port");
	}
	return address.port;
}

function connect(port: number): QuasarConnection {
	const connection = new QuasarConnection("main", {
		host: "127.0.0.1",
		port,
		protocol: 2,
		lazyConnect: true,
		enableReadyCheck: false,
		disableClientInfo: true,
		retryStrategy: () => null,
	});
	connections.push(connection);
	return connection;
}

describe("quasar > a message sharing a chunk with the subscribe ack", () => {
	it("reaches the channel handler", async () => {
		const port = await fakeServer(
			`*3\r\n${bulk("subscribe")}${bulk("orders")}:1\r\n` +
				`*3\r\n${bulk("message")}${bulk("orders")}${bulk("order-42")}`,
		);
		const received: string[] = [];

		await connect(port).subscribed("orders", (message) => {
			received.push(message);
		});

		await vi.waitFor(() => expect(received).toEqual(["order-42"]));
	});

	it("reaches the pattern handler", async () => {
		const port = await fakeServer(
			`*3\r\n${bulk("psubscribe")}${bulk("orders:*")}:1\r\n` +
				`*4\r\n${bulk("pmessage")}${bulk("orders:*")}${bulk("orders:7")}${bulk("order-42")}`,
		);
		const received: string[] = [];

		await connect(port).psubscribed("orders:*", (channel, message) => {
			received.push(`${channel}=${message}`);
		});

		await vi.waitFor(() => expect(received).toEqual(["orders:7=order-42"]));
	});
});

describe("quasar > a subscribe that fails leaves no handler behind", () => {
	/** A connection whose subscriber socket exists but rejects (p)subscribe. */
	async function refusing() {
		const connection = new QuasarConnection("main", {
			host: "127.0.0.1",
			port: 6379,
			lazyConnect: true,
			enableOfflineQueue: false,
			retryStrategy: () => null,
		});
		connections.push(connection);
		await connection.subscribed("warm-up", () => {}).catch(() => undefined);
		const subscriber = connection.ioSubscriberConnection;
		if (!subscriber) throw new Error("the subscribe should have opened one");
		vi.spyOn(subscriber, "subscribe").mockRejectedValue(new Error("NOAUTH"));
		vi.spyOn(subscriber, "psubscribe").mockRejectedValue(new Error("NOAUTH"));
		return { connection, subscriber };
	}

	it("drops the channel handler it registered up front", async () => {
		const { connection, subscriber } = await refusing();
		const handler = vi.fn();

		await expect(connection.subscribed("orders", handler)).rejects.toThrow(
			"NOAUTH",
		);
		subscriber.emit("message", "orders", "late");

		expect(handler).not.toHaveBeenCalled();
	});

	it("drops the pattern handler it registered up front", async () => {
		const { connection, subscriber } = await refusing();
		const handler = vi.fn();

		await expect(connection.psubscribed("orders:*", handler)).rejects.toThrow(
			"NOAUTH",
		);
		subscriber.emit("pmessage", "orders:*", "orders:1", "late");

		expect(handler).not.toHaveBeenCalled();
	});

	it("keeps a handler that was already subscribed before the failed attempt", async () => {
		const { connection, subscriber } = await refusing();
		const handler = vi.fn();
		vi.spyOn(subscriber, "subscribe").mockResolvedValueOnce(1);
		await connection.subscribed("orders", handler);

		// The same handler again, and this time the server refuses: rolling
		// back must not undo the subscription that did succeed.
		await expect(connection.subscribed("orders", handler)).rejects.toThrow(
			"NOAUTH",
		);
		subscriber.emit("message", "orders", "still-here");

		expect(handler).toHaveBeenCalledWith("still-here", "orders");
	});
});
