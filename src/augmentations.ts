/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens quasar binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Nothing filled
 * these in, so resolving by the string token answered `unknown` and every call
 * site had to assert a type it could not prove.
 *
 * Loaded from the package barrel, so importing Quasar anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";

import type { ConnectionConfig } from "./config.js";
import type { QuasarManager } from "./QuasarManager.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/**
		 * The Redis connection manager, bound by the provider.
		 *
		 * The general connection map, not an application's own: the names come
		 * from `config/redis.ts` and this package cannot know them. An
		 * application that wants its own names narrowed reaches for the manager
		 * it built rather than the container token.
		 */
		redis: QuasarManager<Record<string, ConnectionConfig>>;
	}
}
