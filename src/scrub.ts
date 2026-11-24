/**
 * The arguments of a failed command, kept out of every error quasar hands out.
 *
 * ioredis attaches the command a reply error answers to the error itself:
 * `err.command = { name, args }`. Those arguments are what the application
 * sent — the password of the `AUTH` / `HELLO 3 AUTH <user> <password>`
 * handshake, the value a cache stored, the token a lock holds. The error then
 * travels everywhere an error goes: the log line (a serializer copies its own
 * properties), the `error` event payload, `lastError`, a health report served
 * to anyone.
 *
 * NAMED DEVIATION from `@adonisjs/redis`, which hands the ioredis error on
 * as it is: the command's name stays, its arguments go. The same rule as the
 * `quasar.redis.command` tracing channel, which carries no arguments either.
 */

/** How deep `cause` / `previousErrors` / `lastNodeError` are followed. */
const MAX_DEPTH = 8;

/** Properties through which an error points at other errors. */
const NESTED_ERROR_KEYS = ["cause", "lastNodeError"] as const;
const NESTED_ERROR_LISTS = ["previousErrors", "errors"] as const;

/**
 * Replace the `command` an error carries by its name alone, on the error and
 * on every error it nests. The error is changed in place, so the value the
 * caller already holds is the safe one; it is returned for convenience.
 */
export function scrubError<T>(error: T): T {
	scrub(error, new WeakSet(), 0);
	return error;
}

function scrub(value: unknown, seen: WeakSet<object>, depth: number): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value) || depth > MAX_DEPTH) return;
	seen.add(value);
	try {
		const command: unknown = Reflect.get(value, "command");
		if (typeof command === "object" && command !== null) {
			const name: unknown = Reflect.get(command, "name");
			Object.defineProperty(value, "command", {
				value: typeof name === "string" ? { name } : {},
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		for (const key of NESTED_ERROR_KEYS) {
			scrub(Reflect.get(value, key), seen, depth + 1);
		}
		for (const key of NESTED_ERROR_LISTS) {
			const list: unknown = Reflect.get(value, key);
			if (!Array.isArray(list)) continue;
			for (const item of list) scrub(item, seen, depth + 1);
		}
	} catch {
		// A frozen error or a throwing getter: nothing more can be done to it
		// here, and an error path must not throw a second error.
	}
}

/** `reject` functions already routed through {@link scrubError}. */
const scrubbingRejects = new WeakSet<object>();

/**
 * Route an ioredis `Command`'s rejection through {@link scrubError}, so the
 * promise the caller awaits rejects with an error that no longer carries the
 * command's arguments. The command itself is untouched: a retried command is
 * sent again with every argument.
 */
export function scrubRejections(command: unknown): void {
	if (typeof command !== "object" || command === null) return;
	const reject: unknown = Reflect.get(command, "reject");
	if (typeof reject !== "function" || scrubbingRejects.has(reject)) return;
	const scrubbing = function scrubbingReject(
		this: unknown,
		error: unknown,
	): unknown {
		return Reflect.apply(reject, this, [scrubError(error)]);
	};
	scrubbingRejects.add(scrubbing);
	Reflect.set(command, "reject", scrubbing);
}
