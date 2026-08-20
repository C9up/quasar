import { beforeEach, describe, expect, it } from "vitest";
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
