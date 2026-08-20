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

/** PING the server and report whether it answered. */
export class QuasarCheck {
	readonly name = "redis";
	readonly #connection: QuasarConnection;

	constructor(connection: QuasarConnection) {
		this.#connection = connection;
	}

	async run(): Promise<HealthResult> {
		try {
			const reply = await this.#connection.ioConnection.ping();
			return reply === "PONG"
				? {
						name: this.name,
						status: "ok",
						message: `"${this.#connection.name}" answers`,
					}
				: {
						name: this.name,
						status: "error",
						message: `"${this.#connection.name}" replied ${JSON.stringify(reply)} to PING`,
					};
		} catch (error) {
			return {
				name: this.name,
				status: "error",
				message: `"${this.#connection.name}" is unreachable: ${messageOf(error)}`,
			};
		}
	}
}

/** Compare `used_memory` against a warning and a failure threshold. */
export class QuasarMemoryUsageCheck {
	readonly name = "redis:memory";
	readonly #connection: QuasarConnection;
	#warnAt = Number.POSITIVE_INFINITY;
	#failAt = Number.POSITIVE_INFINITY;

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
			const info = await this.#connection.ioConnection.info("memory");
			const used = readUsedMemory(info);
			if (used === undefined) {
				return {
					name: this.name,
					status: "error",
					message: "INFO memory carried no used_memory field",
				};
			}
			const status: HealthStatus =
				used > this.#failAt ? "error" : used > this.#warnAt ? "warning" : "ok";
			return {
				name: this.name,
				status,
				message: `${this.#connection.name} uses ${used} bytes`,
				meta: { usedMemory: used, warnAt: this.#warnAt, failAt: this.#failAt },
			};
		} catch (error) {
			return {
				name: this.name,
				status: "error",
				message: `"${this.#connection.name}" is unreachable: ${messageOf(error)}`,
			};
		}
	}
}

/** `used_memory:1234` out of an INFO payload. */
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
