/**
 * A copy of a connection config that is safe to print.
 *
 * The manager is the `redis` container binding, so it lands in log lines,
 * error payloads and debug dumps. What it prints keeps where each connection
 * points (host, port, db) and drops who it authenticates as.
 */

const REDACTED = "[redacted]";

/**
 * Option names that carry a credential: ioredis' own, plus the TLS material a
 * `tls` block can hold (`key`, `pfx`, `passphrase`).
 */
const SENSITIVE_KEYS = new Set([
	"password",
	"sentinelPassword",
	"username",
	"sentinelUsername",
	"passphrase",
	"pfx",
	"key",
]);

export function redactConfig(value: unknown): unknown {
	if (typeof value === "string") return redactUrl(value);
	if (Array.isArray(value)) return value.map(redactConfig);
	if (!isPlainObject(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		copy[key] =
			SENSITIVE_KEYS.has(key) && entry !== undefined && entry !== ""
				? REDACTED
				: redactConfig(entry);
	}
	return copy;
}

/** `rediss://user:pw@host:6380/2` → `rediss://[redacted]@host:6380/2`. */
function redactUrl(value: string): string {
	if (!value.includes("://") || !value.includes("@")) return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		// Unparseable yet shaped like a URL with userinfo: printing any of it
		// risks printing the password.
		return REDACTED;
	}
	if (url.username === "" && url.password === "") return value;
	return `${url.protocol}//${REDACTED}@${url.host}${url.pathname}${url.search}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
