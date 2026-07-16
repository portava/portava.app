/**
 * Shared coordinate validation helpers.
 *
 * Centralised here so that the same logic is not duplicated across route
 * handlers and cannot silently drift if the validation rules ever change.
 */

/**
 * Returns true when `v` is present but is NOT a valid finite number.
 * Accepts undefined/null (coord not supplied) but rejects strings,
 * booleans, objects, NaN, and ±Infinity.
 */
export const isNonNumericCoord = (v: unknown): boolean =>
  v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v as number));
