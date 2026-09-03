import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QuasarConfig } from "../src/config.js";
import QuasarProvider, { type QuasarAppContext } from "../src/provider.js";
import { QuasarManager } from "../src/QuasarManager.js";
import redis, { clearQuasar, getQuasar } from "../src/services/main.js";

const config: QuasarConfig<Record<string, ConnectionConfig>> = {
	connection: "main",
	connections: { main: { host: "127.0.0.1", port: 6379, lazyConnect: true } },
};

function appWith(
	stored: Record<string, unknown>,
	resolvable: Record<string, unknown> = {},
): QuasarAppContext & { bound: Map<unknown, unknown> } {
	const bound = new Map<unknown, unknown>();
	return {
		bound,
		container: {
			bindValue(token: unknown, value: unknown) {
				bound.set(token, value);
			},
			singleton(token: unknown, factory: () => unknown) {
				bound.set(token, factory());
			},
			has: (token: unknown) => typeof token === "string" && token in resolvable,
			resolve: <T>(token: unknown) => resolvable[String(token)] as T,
		},
		config: { get: <T>(key: string) => stored[key] as T | undefined },
	};
}

beforeEach(() => {
	const seated = getQuasar();
	if (seated) clearQuasar(seated);
});

describe("QuasarProvider", () => {
	it("refuses to boot without config/redis.ts instead of dialling localhost", () => {
		const provider = new QuasarProvider(appWith({}));
		expect(() => provider.register()).toThrow(/missing config\/redis\.ts/);
	});

	it('binds the manager as "redis" and seats the service accessor', () => {
		const app = appWith({ redis: config });
		new QuasarProvider(app).register();

		expect(app.bound.get("redis")).toBeInstanceOf(QuasarManager);
		expect(getQuasar()).toBe(app.bound.get("redis"));
	});

	it("opens no socket at register — connections stay lazy", () => {
		const app = appWith({ redis: config });
		new QuasarProvider(app).register();

		const manager = app.bound.get("redis");
		expect(manager).toBeInstanceOf(QuasarManager);
		if (manager instanceof QuasarManager)
			expect(manager.activeConnectionNames).toEqual([]);
	});

	it("releases the accessor on shutdown, so a second app is not torn down by the first", async () => {
		const provider = new QuasarProvider(appWith({ redis: config }));
		provider.register();
		expect(getQuasar()).toBeDefined();

		await provider.shutdown();
		expect(getQuasar()).toBeUndefined();
	});
});

/**
 * A connection failure has to reach the log the rest of the application writes
 * to. The manager has always accepted a logger; nothing passed it one, so every
 * failure went to the console — and the interface it asked for was pino's,
 * which nothing in this framework is.
 */
describe("QuasarProvider > reporting through the application logger", () => {
	it("hands the manager the one the container has", async () => {
		const logger = { error: vi.fn() };
		const provider = new QuasarProvider(appWith({ redis: config }, { logger }));
		provider.register();
		await provider.boot();

		const manager = getQuasar();
		if (!manager) throw new Error("the provider seated nothing");
		manager.connection().ioConnection.emit("error", new Error("ECONNREFUSED"));

		expect(logger.error).toHaveBeenCalledWith("Redis connection failure", {
			err: expect.any(Error),
			connection: "main",
		});
		await provider.shutdown();
	});

	// Absent is a normal state: ream declares the logger contract and binds
	// none — an implementation package does.
	it("boots without one", async () => {
		const provider = new QuasarProvider(appWith({ redis: config }));
		provider.register();

		await expect(provider.boot()).resolves.toBeUndefined();
		await provider.shutdown();
	});

	it("ignores something bound under that name that cannot report", async () => {
		const provider = new QuasarProvider(
			appWith({ redis: config }, { logger: "not a logger" }),
		);
		provider.register();

		await expect(provider.boot()).resolves.toBeUndefined();
		await provider.shutdown();
	});
});

describe("services/main", () => {
	it("throws a named error when used before a provider seated it", () => {
		expect(() => redis.connection()).toThrow(/accessed before initialization/);
	});

	it("proxies through to the seated manager once there is one", () => {
		const manager = new QuasarManager(config);
		new QuasarProvider(appWith({ redis: config })).register();
		expect(redis.defaultConnectionName).toBe("main");
		manager.disconnect();
	});
});

describe("the accessor before initialization", () => {
	it("answers undefined for `then`, so importing it is not a crash", () => {
		// A loader reads `then` on what it imports to decide whether the module
		// namespace is thenable. Throwing there made `import { setQuasar }` fail
		// at import time — echo's CI caught it.
		const seated = getQuasar();
		if (seated) clearQuasar(seated);
		expect(Reflect.get(redis, "then")).toBeUndefined();
	});

	it("answers undefined for symbols rather than throwing", () => {
		const seated = getQuasar();
		if (seated) clearQuasar(seated);
		expect(Reflect.get(redis, Symbol.toStringTag)).toBeUndefined();
		expect(Reflect.get(redis, Symbol.iterator)).toBeUndefined();
	});

	it("still reports a real access made too early", () => {
		const seated = getQuasar();
		if (seated) clearQuasar(seated);
		expect(() => redis.connection()).toThrow(/accessed before initialization/);
	});
});
