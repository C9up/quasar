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
import type { QuasarLogger } from "./QuasarConnection.js";
import { QuasarManager } from "./QuasarManager.js";
import { clearQuasar, setQuasar } from "./services/main.js";

interface QuasarContainer {
	bindValue?(token: unknown, value: unknown): void;
	singleton(token: unknown, factory: () => unknown): void;
	/** Both optional: a host that offers neither simply gets console reporting. */
	has?(token: unknown): boolean;
	resolve?<T>(token: unknown): Promise<T> | T;
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
	 * Hand the manager the application logger, so a connection failure reaches
	 * the log the rest of the application writes to instead of the console.
	 *
	 * Adonis resolves it when it builds the manager. Here that cannot happen in
	 * `register`: the container resolves asynchronously and `register` does not,
	 * and whichever provider binds `'logger'` may not have registered yet.
	 * Connections are lazy, so the first one still opens well after this.
	 */
	async boot(): Promise<void> {
		const manager = this.#manager;
		if (!manager) return;
		const logger = await resolveLogger(this.#app.container);
		if (logger) manager.useLogger(logger);
	}

	/**
	 * QUIT every open connection. Without this a stopped process keeps its
	 * sockets, and ioredis' reconnection timer keeps the event loop alive — the
	 * server looks hung instead of exiting.
	 */
	async shutdown(): Promise<void> {
		const manager = this.#manager;
		if (!manager) return;
		// quitAll, not quit: `quit()` closes only the DEFAULT connection (Adonis
		// semantics). Shutdown has to close every one of them.
		await manager.quitAll();
		clearQuasar(manager);
		this.#manager = undefined;
	}
}

/**
 * The host's logger, if it has one bound and it looks like a logger.
 *
 * Absent is a normal state — ream itself binds none, an implementation package
 * does — and a logger this package cannot recognise is not worth crashing a
 * boot over: reporting falls back to the console either way.
 */
async function resolveLogger(
	container: QuasarContainer,
): Promise<QuasarLogger | undefined> {
	if (!container.resolve || (container.has && !container.has("logger"))) {
		return undefined;
	}
	try {
		const resolved: unknown = await container.resolve("logger");
		if (isLogger(resolved)) return resolved;
	} catch {
		// A container that has no logger, or fails building one, is not this
		// package's failure to report.
	}
	return undefined;
}

/** Anything that can report an error the way {@link QuasarLogger} asks. */
function isLogger(value: unknown): value is QuasarLogger {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "error") === "function"
	);
}
