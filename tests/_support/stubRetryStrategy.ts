/**
 * The `retryStrategy` the configure stub writes, as a function.
 *
 * Read off the real stub rather than copied, so a test of the reconnect
 * budget breaks the day the stub stops carrying it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stubsRoot } from "../../src/stubs.js";

export function stubRetryStrategy(): (times: number) => number | null {
	const stub = readFileSync(join(stubsRoot, "config/redis.stub"), "utf8");
	const body = /retryStrategy\(times\) \{\n([^}]*)\n\s*\}/.exec(stub)?.[1];
	if (body === undefined) {
		throw new Error("config/redis.stub writes no retryStrategy(times)");
	}
	const strategy = new Function("times", body);
	return (times) => {
		const delay: unknown = Reflect.apply(strategy, undefined, [times]);
		if (delay === null || typeof delay === "number") return delay;
		throw new Error(`retryStrategy answered ${String(delay)}`);
	};
}
