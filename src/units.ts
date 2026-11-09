/**
 * Byte sizes and durations as the health checks accept them.
 *
 * Upstream reads both through `@adonisjs/core/helpers/string` (`bytes`,
 * `seconds`). Quasar is a leaf and does not import the framework, so the two
 * readers are carried here with the same semantics as ream's helpers: binary
 * units (1 kb = 1024 b), a number is already the unit asked for, and a
 * duration string with no unit is milliseconds.
 */

const BYTE_UNITS = {
	b: 1,
	kb: 1024,
	mb: 1024 ** 2,
	gb: 1024 ** 3,
	tb: 1024 ** 4,
	pb: 1024 ** 5,
} as const;

type ByteUnit = keyof typeof BYTE_UNITS;

function isByteUnit(value: string): value is ByteUnit {
	return Object.hasOwn(BYTE_UNITS, value);
}

const BYTES_PATTERN = /^((?:-|\+)?(?:\d+(?:\.\d+)?)) *(kb|mb|gb|tb|pb)$/i;
const TRAILING_ZEROS = /(?:\.0*|(\.[^0]+)0+)$/;

/** `'100 mb'` → 104857600; a number passes through; `null` when unreadable. */
export function parseBytes(value: string | number): number | null {
	if (typeof value === "number") return Number.isNaN(value) ? null : value;
	const [, digits, suffix] = BYTES_PATTERN.exec(value) ?? [];
	const amount =
		digits !== undefined
			? Number.parseFloat(digits)
			: Number.parseInt(value, 10);
	if (Number.isNaN(amount)) return null;
	const unit = suffix === undefined ? "b" : suffix.toLowerCase();
	if (!isByteUnit(unit)) return null;
	return Math.floor(BYTE_UNITS[unit] * amount);
}

/** 104857600 → `'100MB'`, picking the largest unit that keeps a value ≥ 1. */
export function formatBytes(value: number): string {
	const magnitude = Math.abs(value);
	const units: ByteUnit[] = ["pb", "tb", "gb", "mb", "kb"];
	const unit =
		units.find((candidate) => magnitude >= BYTE_UNITS[candidate]) ?? "b";
	const rendered = (value / BYTE_UNITS[unit])
		.toFixed(2)
		.replace(TRAILING_ZEROS, "$1");
	return `${rendered}${unit.toUpperCase()}`;
}

const DURATION_PATTERN =
	/^(-?(?:\d+)?\.?\d+) *(m(?:illiseconds?|s(?:ecs?)?))?(s(?:ec(?:onds?|s)?)?)?(m(?:in(?:utes?|s)?)?)?(h(?:ours?|rs?)?)?(d(?:ays?)?)?(w(?:eeks?|ks?)?)?(y(?:ears?|rs?)?)?$/;

const SECOND = 1000;
const MINUTE = SECOND * 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const YEAR = DAY * 365.25;

/**
 * `'1 minute'` → 60; a number is already seconds. Throws on anything else: a
 * cache duration that silently became zero would disable the cache unseen.
 */
export function durationToSeconds(value: string | number): number {
	if (typeof value === "number") return Math.trunc(value);
	const matched = DURATION_PATTERN.exec(value.toLowerCase());
	const amount = Number.parseFloat(matched?.[1] ?? "");
	if (matched === null || !amount) {
		throw new Error(
			`[redis] cannot read "${value}" as a duration. Use a number of seconds, or a duration such as '30s' or '1 minute'.`,
		);
	}
	const unit = matched[3]
		? SECOND
		: matched[4]
			? MINUTE
			: matched[5]
				? HOUR
				: matched[6]
					? DAY
					: matched[7]
						? DAY * 7
						: matched[8]
							? YEAR
							: 1;
	return Math.floor((amount * unit) / SECOND);
}
