/**
 * Quasar errors, one per code. Upstream's own code, `E_INVALID_BYTES_VALUE`,
 * stays verbatim; the refusals quasar adds carry the `E_QUASAR_` namespace.
 */
import { createError } from "@c9up/flare";

/** A memory threshold that cannot be read as a size. Upstream's, verbatim. */
export const E_INVALID_BYTES_VALUE = createError<[string | number]>(
	'Invalid bytes value "%s"',
	"E_INVALID_BYTES_VALUE",
	500,
);

/** A duration that is neither a number of seconds nor a readable string. */
export const E_QUASAR_INVALID_DURATION = createError<[string]>(
	"[redis] cannot read \"%s\" as a duration. Use a number of seconds, or a duration such as '30s' or '1 minute'.",
	"E_QUASAR_INVALID_DURATION",
);

/** A config that declares no connection, or a default it does not declare. */
export const E_QUASAR_INVALID_CONFIG = createError<[string]>(
	"[redis] %s",
	"E_QUASAR_INVALID_CONFIG",
);

/** `config/redis.ts` is missing. */
export const E_QUASAR_MISSING_CONFIG = createError(
	"[redis] missing config/redis.ts",
	"E_QUASAR_MISSING_CONFIG",
);

/** A connection name the config does not declare. */
export const E_QUASAR_UNKNOWN_CONNECTION = createError<[string, string]>(
	'[redis] connection "%s" is not declared — got %s',
	"E_QUASAR_UNKNOWN_CONNECTION",
);

/** A command the connection does not have. */
export const E_QUASAR_UNKNOWN_COMMAND = createError<[string]>(
	"[redis] %s",
	"E_QUASAR_UNKNOWN_COMMAND",
);

/** The `redis` service used before a provider or `setQuasar()` bound it. */
export const E_QUASAR_NOT_BOOTED = createError(
	"[redis] accessed before initialization — register QuasarProvider, or call setQuasar() yourself.",
	"E_QUASAR_NOT_BOOTED",
);

/** A cluster-only method called on a standalone connection. */
export const E_QUASAR_NOT_A_CLUSTER = createError<[string]>(
	'[redis] connection "%s" is not a cluster — nodes() lists a cluster\'s nodes',
	"E_QUASAR_NOT_A_CLUSTER",
);

/** A port that is not a whole number from 0 to 65535. */
export const E_QUASAR_INVALID_PORT = createError<[string]>(
	'[redis] port "%s" is not a port number',
	"E_QUASAR_INVALID_PORT",
);
