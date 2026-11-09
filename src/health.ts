/**
 * Health checks, so a readiness endpoint can answer for Redis too.
 *
 * Shaped like upstream's `RedisCheck` / `RedisMemoryUsageCheck`, which extend
 * the framework's `BaseCheck`: a per-connection name, `as()`, `cacheFor()`,
 * and a result carrying `finishedAt`. Quasar is a leaf and does not import
 * ream, so the base is carried here and the contract is met structurally —
 * both checks register with ream's `HealthChecks` as they are.
 *
 * Both return a result rather than throwing: a health endpoint reports, it
 * does not crash.
 */

import { isRetired, type QuasarConnection } from "./QuasarConnection.js";
import { durationToSeconds, formatBytes, parseBytes } from "./units.js";

export type HealthStatus = "ok" | "warning" | "error";

/** What a check answers: ream's (and Adonis') `HealthCheckResult`. */
export interface HealthResult {
	message: string;
	status: HealthStatus;
	finishedAt: Date;
	meta?: Record<string, unknown>;
}

/**
 * What a check reads off a connection. A `QuasarConnection` is one; the type
 * is structural so a check can be exercised without a socket.
 */
export interface CheckedConnection {
	readonly connectionName: string;
	readonly status: string;
	readonly lastError: unknown;
	isConnecting(): boolean;
	isReady(): boolean;
	isClosed(): boolean;
	readonly ioConnection: {
		ping(): Promise<string>;
		info(section: string): Promise<string>;
		connect(): Promise<void>;
	};
}

/**
 * Raised for a memory threshold that cannot be read as a size. The code is
 * upstream's, verbatim.
 */
export class InvalidBytesValueError extends Error {
	readonly code = "E_INVALID_BYTES_VALUE";
	readonly status = 500;

	constructor(value: unknown) {
		super(`Invalid bytes value "${String(value)}"`);
		this.name = "InvalidBytesValueError";
	}
}

/** Upstream exports its error classes under `errors`; so does quasar. */
export const errors = { E_INVALID_BYTES_VALUE: InvalidBytesValueError };

/**
 * How long a check waits on a connection that is still dialling, and in how
 * many steps. Adonis' numbers: a server being reached for the first time
 * deserves a moment, and three seconds is the whole of it.
 */
const SETTLE_ATTEMPTS = 3;
const SETTLE_STEP_MS = 1_000;

/** The part of ream's `BaseCheck` a check needs: a name, renaming, caching. */
abstract class Check {
	abstract name: string;
	/** Seconds to reuse a previous result for. */
	cacheDuration?: number;

	/** Rename the check, so two checks of one kind stay distinguishable. */
	as(name: string): this {
		this.name = name;
		return this;
	}

	/** Reuse the result for this long — `60`, `'30s'`, `'1 minute'`. */
	cacheFor(duration: string | number): this {
		this.cacheDuration = durationToSeconds(duration);
		return this;
	}

	abstract run(): Promise<HealthResult>;
}

/** PING the server and report whether it answered. */
export class QuasarCheck extends Check {
	name: string;
	readonly #connection: CheckedConnection;

	constructor(connection: CheckedConnection) {
		super();
		this.#connection = connection;
		this.name = `Redis health check (${connection.connectionName})`;
	}

	async run(): Promise<HealthResult> {
		try {
			const unreachable = await settle(this.#connection);
			if (unreachable !== undefined) return unreachable;
			const reply = await this.#connection.ioConnection.ping();
			// Upstream takes any reply as success; a server answering LOADING
			// is not ready to serve.
			return reply === "PONG"
				? result(
						"ok",
						"Successfully connected to the redis server",
						this.#connection,
					)
				: result(
						"error",
						`The redis server replied ${JSON.stringify(reply)} to PING`,
						this.#connection,
					);
		} catch (error) {
			return failed(error, this.#connection);
		}
	}
}

/** Compare the server's memory use against a warning and a failure threshold. */
export class QuasarMemoryUsageCheck<
	Connection extends CheckedConnection = QuasarConnection,
> extends Check {
	name: string;
	readonly #connection: Connection;
	#warnAt = DEFAULT_WARN_BYTES;
	#failAt = DEFAULT_FAIL_BYTES;
	#compute: (connection: Connection) => Promise<number | null> = async (
		connection,
	) => readUsedMemory(await connection.ioConnection.info("memory"));

	constructor(connection: Connection) {
		super();
		this.#connection = connection;
		this.name = `Redis memory consumption health check (${connection.connectionName})`;
	}

	/** Warn past this size — bytes, or `'100 mb'`. */
	warnWhenExceeds(value: string | number): this {
		this.#warnAt = bytesOf(value);
		return this;
	}

	/** Fail past this size — bytes, or `'120 mb'`. */
	failWhenExceeds(value: string | number): this {
		this.#failAt = bytesOf(value);
		return this;
	}

	/** Measure memory use some other way; answer `null` when it cannot be read. */
	compute(callback: (connection: Connection) => Promise<number | null>): this {
		this.#compute = callback;
		return this;
	}

	async run(): Promise<HealthResult> {
		try {
			const unreachable = await settle(this.#connection);
			if (unreachable !== undefined) return unreachable;
			const used = await this.#compute(this.#connection);
			if (used === null || !Number.isFinite(used)) {
				return result(
					"error",
					"Check failed. Unable to get redis memory info",
					this.#connection,
				);
			}
			const meta = {
				memoryInBytes: {
					used,
					warningThreshold: this.#warnAt,
					failureThreshold: this.#failAt,
				},
			};
			const usage = formatBytes(used);
			if (used > this.#failAt) {
				return result(
					"error",
					`Redis memory usage is ${usage}, which is above the threshold of ${formatBytes(this.#failAt)}`,
					this.#connection,
					meta,
				);
			}
			if (used > this.#warnAt) {
				return result(
					"warning",
					`Redis memory usage is ${usage}, which is above the threshold of ${formatBytes(this.#warnAt)}`,
					this.#connection,
					meta,
				);
			}
			return result(
				"ok",
				`Redis memory usage is ${usage}, which is under the defined thresholds`,
				this.#connection,
				meta,
			);
		} catch (error) {
			return failed(error, this.#connection);
		}
	}
}

/**
 * Adonis' defaults, in bytes. A check with no thresholds set must still be able
 * to fail — `Infinity` made one that always reported ok, which reads as a
 * monitored server and is worse than no check at all.
 */
const DEFAULT_WARN_BYTES = 100 * 1024 * 1024;
const DEFAULT_FAIL_BYTES = 120 * 1024 * 1024;

function bytesOf(value: string | number): number {
	const bytes = parseBytes(value);
	if (bytes === null) throw new InvalidBytesValueError(value);
	return bytes;
}

/**
 * Wait for a connection to settle, and refuse to send a command on one that
 * never will.
 *
 * A check must not issue a command against a connection that is not ready.
 * ioredis does not fail such a command, it QUEUES it, and holds it for the
 * whole reconnect budget — measured at 73 seconds with the defaults, and
 * forever with `maxRetriesPerRequest: null`, which is what a queue needs. A
 * readiness probe that hangs for a minute is the outage it exists to report,
 * and it holds a request and a socket for every probe interval meanwhile.
 *
 * The shape is Adonis': wait on a connection that is still dialling, but not
 * on one that has already recorded an error, and dial once for a closed one.
 * Adonis retries that reconnect without a bound; one attempt is enough and
 * cannot loop.
 *
 * NAMED DEVIATION: a connection that was quit, or that the manager dropped,
 * is never dialled again. Upstream revives it, and since nothing tracks it
 * any more the revived socket survives shutdown and keeps the process alive.
 */
async function settle(
	connection: CheckedConnection,
): Promise<HealthResult | undefined> {
	let waited = 0;
	let reconnected = false;
	for (;;) {
		if (
			connection.isConnecting() &&
			waited < SETTLE_ATTEMPTS &&
			connection.lastError === undefined
		) {
			await delay(SETTLE_STEP_MS);
			waited++;
			continue;
		}
		if (connection.isClosed() && isRetired(connection)) {
			return result(
				"error",
				`The redis connection "${connection.connectionName}" was closed and is no longer in use`,
				connection,
			);
		}
		// `end` only: from `close` ioredis reconnects by itself, and dialling
		// as well would race its retry timer with a second socket.
		if (connection.status === "end" && !reconnected) {
			reconnected = true;
			await connection.ioConnection.connect();
			continue;
		}
		if (connection.isReady()) return undefined;
		return result(
			"error",
			"Unable to connect to the redis server",
			connection,
			connection.lastError === undefined ? {} : { error: connection.lastError },
		);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** A result, with the connection described the way Adonis' meta does it. */
function result(
	status: HealthStatus,
	message: string,
	connection: CheckedConnection,
	meta: Record<string, unknown> = {},
): HealthResult {
	return {
		message,
		status,
		finishedAt: new Date(),
		meta: {
			...meta,
			connection: {
				name: connection.connectionName,
				status: connection.status,
			},
		},
	};
}

/** Upstream's `Result.failed(error)`: the error's message, the error in meta. */
function failed(error: unknown, connection: CheckedConnection): HealthResult {
	return result(
		"error",
		error instanceof Error ? error.message : String(error),
		connection,
		{ error },
	);
}

/**
 * `used_memory:1234` out of an INFO payload.
 *
 * Anchored on the colon, unlike Adonis, which matches the line PREFIX and so
 * would read `used_memory_rss` had Redis ever ordered the section differently.
 */
function readUsedMemory(info: string): number | null {
	const line = info
		.split(/\r?\n/)
		.find((entry) => entry.startsWith("used_memory:"));
	if (line === undefined) return null;
	const value = Number(line.slice("used_memory:".length).trim());
	return Number.isFinite(value) ? value : null;
}
