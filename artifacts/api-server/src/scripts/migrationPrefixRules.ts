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
 *
 * ── 3000-3999, ADDED 2026-09-23 BECAUSE 2100-2999 RAN OUT ───────────────────
 * The 2100-2999 range is full: main holds prefixes up to 2997, and 2998 and
 * 2999 are both claimed by unmerged branches, so there is no number a new
 * migration can take without planting a collision that goes red the moment the
 * other branch lands.
 *
 * The dated convention is not the way out. Apply order is plain lexicographic,
 * and "20260923_…" sorts BELOW "2810_…" — the second character decides, '0'
 * against '8' — so a dated file authored today would be applied before the
 * migrations it depends on. The escape hatch the error message used to offer
 * was therefore only ever available to a migration that depends on nothing.
 *
 * So the range grows upward, and the invariant survives unchanged: a prefix in
 * 3000-3999 cannot be mistaken for an 8-digit date prefix under a naive string
 * comparison because of its FIRST digit rather than its second — no YYYYMMDD in
 * this millennium begins with "3". It also sorts strictly after every 2xxx
 * prefix, which is what a forward migration needs, and it still satisfies the
 * `filename >= "2100"` test that `auditLiveVsCanonical` uses to mean
 * "post-cutover".
 *
 * What is NOT permitted is a second digit of 0 in the 2000s: 2000-2095 would be
 * genuinely ambiguous, and that is what the reserved buffer and the `2[1-9]`
 * arm keep out. 4000 and above were left unallocated deliberately; when 3999 is
 * reached, whoever needs 4000 should extend this the same way and write down
 * why, rather than reaching for a date.
 *
 * 4000-4999 OPENED 2026-10-05. 3xxx is not exhausted on main, but it is fully
 * PARTITIONED: the mission's integration lead handed 3900-3999 to three parallel
 * lanes and the next four lanes their bands in 4030-4149 (A2 4030-4059, T1
 * 4060-4089, T2 4090-4119, D 4120-4149), so a new number below 4000 would land
 * in another lane's band. 4xxx keeps every invariant above for the same reason
 * 3xxx did: no YYYYMMDD in this millennium begins with "4", it sorts strictly
 * after every 3xxx prefix, and it still reads as post-cutover (>= "2100").
 * 5000 and above stay unallocated.
 */

export const RESERVED_BUFFER_MIN = 2096;
export const RESERVED_BUFFER_MAX = 2099;

/** New canonical 4-digit numeric prefixes must match this: 2100-2999, 3000-3999 or 4000-4999. */
export const NEW_NUMERIC_PREFIX_RE = /^(?:2[1-9]\d{2}|3\d{3}|4\d{3})_/;

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
      reason:
        `prefix ${digits} is >= 2100 but outside the allocated ranges 2100-2999, ` +
        "3000-3999 and 4000-4999 (must match /^(?:2[1-9]\\d{2}|3\\d{3}|4\\d{3})_/). 5000 and above are not " +
        "allocated yet — extend NEW_NUMERIC_PREFIX_RE and say why, rather than " +
        "reaching for a dated prefix, which sorts BELOW every 2xxx file",
    };
  }
  return null;
}

export function validateAllPrefixBands(filenames: string[]): PrefixBandViolation[] {
  return filenames
    .map(validatePrefixBand)
    .filter((v): v is PrefixBandViolation => v !== null);
}
