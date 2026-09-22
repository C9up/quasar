/**
 * The Redis server the integration suites talk to.
 *
 * Deliberately without a default. `redis://127.0.0.1:6379` is whichever Redis
 * the machine happens to be running, which on a developer's box is a live
 * application's server — these suites would write to it, and did, without
 * anyone having asked for that.
 *
 * A missing variable is a configuration error and is raised as one, following
 * `@adonisjs/env`, which answers `E_INVALID_ENV_VARIABLES` with
 * "Missing environment variable <name>" for the same situation. Skipping
 * instead would be the other way to get this wrong: a suite that quietly tests
 * nothing is how a broken test sits unnoticed, which is exactly how the
 * `subscribe` parity assertion in this package survived.
 */
export function redisTestUrl(): string {
	const url = process.env.REDIS_TEST_URL;
	if (url === undefined || url.trim() === "") {
		throw new Error(
			"E_INVALID_ENV_VARIABLES: Missing environment variable REDIS_TEST_URL. " +
				"The Redis integration suites need a server of their own — start one " +
				"and export its URL. Do not point them at a Redis an application is " +
				"using.",
		);
	}
	return url;
}
