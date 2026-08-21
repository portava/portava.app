/**
 * k-anonymity — Phase 0 roadmap item 6 (the math half).
 *
 * An aggregate may be shown only if at least k DISTINCT subjects contributed to
 * it; below k the individual becomes re-identifiable and the output must be
 * suppressed. This module is the mechanism ONLY — it never chooses k. k is the
 * caller's (owner's) parameter, so the privacy threshold stays a product
 * decision and is not invented here.
 *
 * It is one input to the `privacy_eligible` seam on the live-output envelope
 * (item 4, liveEnvelope.ts): a caller computes privacy_eligible from its own
 * privacy rules — of which k-anonymity is typically one — and passes the result
 * in. This module deliberately does not reach into that seam itself.
 *
 * The other half of item 6 — the sensitive-zone exclusion REGISTRY (2104) — is
 * owner data plus a geometry-model decision, and is deferred rather than guessed.
 *
 * Fail-closed everywhere: a non-finite or < 1 k, or a non-finite/negative count,
 * returns "suppress".
 */

/**
 * True iff `distinctSubjects` meets the k-anonymity threshold `k` and the
 * aggregate may be shown. Fail-closed on any invalid input.
 */
export function meetsKAnonymity(distinctSubjects: number, k: number): boolean {
  if (!Number.isFinite(k) || k < 1) return false; // no valid threshold => suppress
  if (!Number.isFinite(distinctSubjects) || distinctSubjects < 0) return false;
  return distinctSubjects >= k;
}

/**
 * Return `value` when it meets k-anonymity, else `fallback` (default null).
 * A typed convenience over meetsKAnonymity so call sites read as suppression.
 */
export function kAnonymize<T>(
  value: T,
  distinctSubjects: number,
  k: number,
  fallback: T | null = null,
): T | null {
  return meetsKAnonymity(distinctSubjects, k) ? value : fallback;
}
