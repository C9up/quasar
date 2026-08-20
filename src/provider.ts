/**
 * Wires `config/redis.ts` into the container as `'redis'`, and seats the
 * manager on `@c9up/quasar/services/main`.
 *
 * The host is duck-typed — this package stays publishable without importing
 * `@c9up/ream`. Any framework exposing a container plus a config store
 * satisfies it.
 *
 * The manager is built in `register` (opening nothing: connections are lazy),
 * so anything reaching for `'redis'` during another provider's `boot` — a JWT
 * blacklist, a cache store — finds it already seated.
 */

import type { ConnectionConfig, QuasarConfig } from "./config.js";
import { QuasarManager } from "./QuasarManager.js";
import { clearQuasar, setQuasar } from "./services/main.js";

interface QuasarContainer {
	bindValue?(token: unknown, value: unknown): void;
	singleton(token: unknown, factory: () => unknown): void;
}
interface QuasarConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface QuasarAppContext {
	container: QuasarContainer;
	config: QuasarConfigStore;
}

type AnyConfig = QuasarConfig<Record<string, ConnectionConfig>>;

export default class QuasarProvider {
	readonly #app: QuasarAppContext;
	#manager: QuasarManager<Record<string, ConnectionConfig>> | undefined;

	constructor(app: QuasarAppContext) {
		this.#app = app;
	}

	register(): void {
		const config = this.#app.config.get<AnyConfig>("redis");
		if (config === undefined) {
			throw new Error("[redis] missing config/redis.ts");
		}

		const manager = new QuasarManager(config);
		this.#manager = manager;
		setQuasar(manager);

		if (this.#app.container.bindValue) {
			this.#app.container.bindValue("redis", manager);
		} else {
			this.#app.container.singleton("redis", () => manager);
		}
	}

	/**
	 * QUIT every open connection. Without this a stopped process keeps its
	 * sockets, and ioredis' reconnection timer keeps the event loop alive — the
	 * server looks hung instead of exiting.
	 */
	async shutdown(): Promise<void> {
		const manager = this.#manager;
		if (!manager) return;
		await manager.quit();
		clearQuasar(manager);
		this.#manager = undefined;
	}
}
