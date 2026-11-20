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

/** The same names, as query keys are compared: without regard to case. */
const SENSITIVE_QUERY_KEYS = new Set(
	[...SENSITIVE_KEYS].map((key) => key.toLowerCase()),
);

/**
 * A connection string with every credential ioredis would read from it
 * replaced: the userinfo (`rediss://user:pw@host` → `rediss://[redacted]@host`)
 * and each sensitive query parameter (`?password=pw` → `?password=[redacted]`).
 *
 * ioredis takes EVERY query parameter of a URL as a client option, so
 * `redis://host?password=pw` and a unix socket `/run/redis.sock?password=pw`
 * authenticate just like userinfo does. The query is therefore read on every
 * string, URL-shaped or not — the walk above cannot tell which strings ioredis
 * will parse, and over-redacting a printed view costs nothing.
 *
 * Purely textual on purpose: a parse that fails must not fall back to printing
 * the input, and a string that is not a URL must come out unchanged.
 */
function redactUrl(value: string): string {
	const queryAt = value.indexOf("?");
	const base = queryAt === -1 ? value : value.slice(0, queryAt);
	const safeBase = redactUserinfo(base);
	if (queryAt === -1) return safeBase;
	return `${safeBase}?${redactQuery(value.slice(queryAt + 1))}`;
}

/**
 * Replace the userinfo of `base` (the string before its query).
 *
 * The authority is found the way WHATWG URL (which ioredis parses with) finds
 * it: after the scheme — or after `//`, or from the start for the scheme-less
 * `user:pw@host:port` ioredis prefixes with `redis://` — up to the first `/` or
 * `#`, and the userinfo is everything before its LAST `@`. A unix socket path
 * (a single leading `/`) has no authority.
 */
function redactUserinfo(base: string): string {
	if (!base.includes("@")) return base;
	if (base.startsWith("/") && !base.startsWith("//")) return base;
	const prefix =
		/^[a-z][a-z0-9+.-]*:\/\//i.exec(base)?.[0] ??
		(base.startsWith("//") ? "//" : "");
	const rest = base.slice(prefix.length);
	const authorityEnd = rest.search(/[/#]/);
	const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
	const at = authority.lastIndexOf("@");
	if (at === -1) return base;
	return `${prefix}${REDACTED}${rest.slice(at)}`;
}

/**
 * Redact the value of each sensitive pair of a raw query string, leaving every
 * other pair byte for byte. Keys are decoded the way `URLSearchParams` decodes
 * them (what ioredis uses), so `pass%77ord` is still `password`.
 */
function redactQuery(query: string): string {
	return query
		.split("&")
		.map((pair) => {
			const equals = pair.indexOf("=");
			if (equals === -1) return pair;
			const rawKey = pair.slice(0, equals);
			const [key] = new URLSearchParams(`${rawKey}=`).keys();
			if (key === undefined || !SENSITIVE_QUERY_KEYS.has(key.toLowerCase()))
				return pair;
			return `${rawKey}=${REDACTED}`;
		})
		.join("&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
