/**
 * The default `QuasarManager`, reachable without threading it through every
 * call site — mirroring `@c9up/echo/services/main`.
 *
 *   import redis from '@c9up/quasar/services/main'
 *
 *   await redis.connection().set('user:42', payload)
 *
 * Importing this module opens nothing: the manager is resolved on the first
 * method call, so a unit test that pulls it in transitively without ever
 * issuing a command needs no booted provider.
 */

import type { ConnectionConfig } from "../config.js";
import type { QuasarManager } from "../QuasarManager.js";

type AnyManager = QuasarManager<Record<string, ConnectionConfig>>;

let instance: AnyManager | undefined;

/** Seat the manager — called by QuasarProvider, or by an app wiring its own. */
export function setQuasar(manager: AnyManager): void {
	instance = manager;
}

/** The seated manager, if there is one. */
export function getQuasar(): AnyManager | undefined {
	return instance;
}

/** Drop the manager IF it is still the one passed in (ownership guard). */
export function clearQuasar(manager: AnyManager): void {
	if (instance === manager) instance = undefined;
}

const redis: AnyManager = new Proxy(Object.create(null), {
	get(_target, property) {
		if (!instance) {
			throw new Error(
				"[redis] accessed before initialization — register QuasarProvider, or call setQuasar() yourself.",
			);
		}
		const value = Reflect.get(instance, property, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default redis;
