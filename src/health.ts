/**
 * Health checks, so a readiness endpoint can answer for Redis too.
 *
 * Both return a plain result rather than throwing: a health endpoint reports,
 * it does not crash. `QuasarCheck` proves the server answers; `MemoryUsageCheck`
 * reads `INFO memory` and compares against the thresholds you set.
 */

import type { QuasarConnection } from "./QuasarConnection.js";

export type HealthStatus = "ok" | "warning" | "error";

export interface HealthResult {
	name: string;
	status: HealthStatus;
	message: string;
	meta?: Record<string, unknown>;
}

/**
 * How long a check waits on a connection that is still dialling, and in how
 * many steps. Adonis' numbers: a server being reached for the first time
 * deserves a moment, and three seconds is the whole of it.
 */
const SETTLE_ATTEMPTS = 3;
const SETTLE_STEP_MS = 1_000;

/**
 * Adonis' defaults, in bytes. A check with no thresholds set must still be able
 * to fail — `Infinity` made one that always reported ok, which reads as a
 * monitored server and is worse than no check at all.
 */
const DEFAULT_WARN_BYTES = 100 * 1024 * 1024;
const DEFAULT_FAIL_BYTES = 120 * 1024 * 1024;

/** PING the server and report whether it answered. */
export class QuasarCheck {
	readonly name = "redis";
	readonly #connection: QuasarConnection;

	constructor(connection: QuasarConnection) {
		this.#connection = connection;
	}

	async run(): Promise<HealthResult> {
		try {
			const unreachable = await settle(this.#connection);
			if (unreachable !== undefined) {
				return { name: this.name, status: "error", ...unreachable };
			}
			const reply = await this.#connection.ioConnection.ping();
			return reply === "PONG"
				? {
						name: this.name,
						status: "ok",
						message: `"${this.#connection.name}" answers`,
						meta: metaOf(this.#connection),
					}
				: {
						name: this.name,
						status: "error",
						message: `"${this.#connection.name}" replied ${JSON.stringify(reply)} to PING`,
						meta: metaOf(this.#connection),
					};
		} catch (error) {
			return {
				name: this.name,
				status: "error",
				message: `"${this.#connection.name}" is unreachable: ${messageOf(error)}`,
				meta: metaOf(this.#connection),
			};
		}
	}
}

/** Compare `used_memory` against a warning and a failure threshold. */
export class QuasarMemoryUsageCheck {
	readonly name = "redis:memory";
	readonly #connection: QuasarConnection;
	#warnAt = DEFAULT_WARN_BYTES;
	#failAt = DEFAULT_FAIL_BYTES;

	constructor(connection: QuasarConnection) {
		this.#connection = connection;
	}

	/** Warn past this many bytes. */
	warnWhenExceeds(bytes: number): this {
		this.#warnAt = bytes;
		return this;
	}

	/** Fail past this many bytes. */
	failWhenExceeds(bytes: number): this {
		this.#failAt = bytes;
		return this;
	}

	async run(): Promise<HealthResult> {
		try {
			const unreachable = await settle(this.#connection);
			if (unreachable !== undefined) {
				return { name: this.name, status: "error", ...unreachable };
			}
			const info = await this.#connection.ioConnection.info("memory");
			const used = readUsedMemory(info);
			if (used === undefined) {
				return {
					name: this.name,
					status: "error",
					message: "INFO memory carried no used_memory field",
					meta: metaOf(this.#connection),
				};
			}
			const status: HealthStatus =
				used > this.#failAt ? "error" : used > this.#warnAt ? "warning" : "ok";
			return {
				name: this.name,
				status,
				message: `${this.#connection.name} uses ${used} bytes`,
				meta: {
					...metaOf(this.#connection),
					usedMemory: used,
					warnAt: this.#warnAt,
					failAt: this.#failAt,
				},
			};
		} catch (error) {
			return {
				name: this.name,
				status: "error",
				message: `"${this.#connection.name}" is unreachable: ${messageOf(error)}`,
				meta: metaOf(this.#connection),
			};
		}
	}
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
 */
async function settle(
	connection: QuasarConnection,
): Promise<{ message: string; meta: Record<string, unknown> } | undefined> {
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
		if (connection.isClosed() && !reconnected) {
			reconnected = true;
			await connection.ioConnection.connect();
			continue;
		}
		if (connection.isReady()) return undefined;
		const reason = connection.lastError;
		return {
			message:
				`unable to reach "${connection.name}"` +
				(reason === undefined ? "" : `: ${messageOf(reason)}`),
			meta: metaOf(connection),
		};
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** What a health report says about the connection itself, as Adonis reports it. */
function metaOf(connection: QuasarConnection): Record<string, unknown> {
	return { connection: connection.name, status: connection.status };
}

/**
 * `used_memory:1234` out of an INFO payload.
 *
 * Anchored on the colon, unlike Adonis, which matches the line PREFIX and so
 * would read `used_memory_rss` had Redis ever ordered the section differently.
 */
function readUsedMemory(info: string): number | undefined {
	const line = info
		.split(/\r?\n/)
		.find((entry) => entry.startsWith("used_memory:"));
	if (line === undefined) return undefined;
	const value = Number(line.slice("used_memory:".length).trim());
	return Number.isFinite(value) ? value : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
