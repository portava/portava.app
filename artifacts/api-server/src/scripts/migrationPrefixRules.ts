/**
 * New-numeric-prefix band rules for the canonical migration chain.
 *
 * The canonical chain uses two disjoint filename conventions: a legacy
 * 4-digit numeric prefix (0010_..., 2059_..., 2095_...) and, more recently, an
 * 8-digit dated prefix (20260815_...). Apply order is plain lexicographic
 * string comparison, so any code that wants to distinguish "new" 4-digit
 * numbering from "old" by testing filename >= "2100" is exact ONLY if every
 * filename it's compared against is a same-length 4-digit prefix. It silently
 * misclassifies an 8-digit dated file: "20270101_foo.sql" < "2100" lexically,
 * because the second character ('0') sorts below "2100"'s second character
 * ('1') — a migration authored in 2027 would sort as if it were older than
 * the current chain's baseline.
 *
 * This module closes that gap by making the two conventions structurally
 * unambiguous rather than relying on a length-blind string comparison
 * anywhere: a NEW 4-digit numeric prefix must fall in 2100-2999
 * (`^2[1-9]\d{2}_`) — a range that starts with the same "2" every legacy
 * prefix in this decade starts with, but whose second digit (1-9) can never
 * appear in an 8-digit YYYYMMDD date prefix for any date in the 2000s
 * (whose second digit is always "0"). The two conventions can never collide
 * under a naive string comparison again, by construction, not by convention.
 *
 * 2096-2099 are reserved as an unusable buffer directly below the new range,
 * so there is no ambiguous edge immediately adjacent to 2100 either.
 */

export const RESERVED_BUFFER_MIN = 2096;
export const RESERVED_BUFFER_MAX = 2099;

/** New canonical 4-digit numeric prefixes must match this: 2100-2999. */
export const NEW_NUMERIC_PREFIX_RE = /^2[1-9]\d{2}_/;

export interface PrefixBandViolation {
  file: string;
  reason: string;
}

/**
 * Validate one canonical migration filename against the reserved-buffer and
 * new-numeric-prefix-range rules.
 *
 * Returns null (no violation) for:
 *   - a filename with no leading numeric prefix at all (not this check's concern)
 *   - an 8-digit dated prefix (20260815_...) — a structurally different,
 *     unambiguous convention
 *   - a legacy 4-digit prefix below the reserved buffer (grandfathered —
 *     every file that exists today is < 2096)
 *   - a new-format 4-digit prefix correctly in 2100-2999
 *
 * Returns a violation for:
 *   - a 4-digit prefix landing in the reserved buffer 2096-2099
 *   - a 4-digit prefix >= 2100 that isn't in the 2100-2999 range (i.e. >= 3000)
 */
export function validatePrefixBand(filename: string): PrefixBandViolation | null {
  const m = /^(\d+)_/.exec(filename);
  if (!m) return null;
  const digits = m[1];
  if (digits.length !== 4) return null; // 8-digit dated files are a separate convention

  const n = Number(digits);
  if (n >= RESERVED_BUFFER_MIN && n <= RESERVED_BUFFER_MAX) {
    return {
      file: filename,
      reason: `prefix ${digits} falls in the reserved buffer (${RESERVED_BUFFER_MIN}-${RESERVED_BUFFER_MAX}) — never usable, pick 2100 or above`,
    };
  }
  if (n >= 2100 && !NEW_NUMERIC_PREFIX_RE.test(filename)) {
    return {
      file: filename,
      reason: `prefix ${digits} is >= 2100 but outside the required 2100-2999 range (must match /^2[1-9]\\d{2}_/)`,
    };
  }
  return null;
}

export function validateAllPrefixBands(filenames: string[]): PrefixBandViolation[] {
  return filenames
    .map(validatePrefixBand)
    .filter((v): v is PrefixBandViolation => v !== null);
}
