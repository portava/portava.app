/**
 * mediaFreshness — freshness classes for MEDIA (not claims).
 *
 * A media projection's freshness is derived purely from age. It caps at 'fresh'
 * and NEVER reaches 'live': the word "live" and any current-state badge are
 * reserved for the gated Live Intelligence path (lib/liveClaimRead.ts), which
 * is fail-closed. This keeps §2/§31's boundary — media alone never manufactures
 * a "busy now" / "live" signal.
 *
 * The claim-side freshness TTLs live in lib/freshnessPolicy.ts and are read from
 * the DB. These media windows are UI recency buckets and are intentionally
 * simple constants shared across the projection services.
 */

/** A media perspective is "fresh" for one hour. §4.1/§47 "fresh perspectives". */
export const FRESH_WINDOW_MS = 60 * 60 * 1000;
/** "recent" up to 24h. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The freshness state of a group of perspectives (§23 FreshnessState). */
export type FreshnessState = "fresh" | "recent" | "historical" | "none";

/** True when a single item of the given age still counts as fresh (< 1h). */
export function isFreshEnoughForLabel(ageMs: number): boolean {
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < FRESH_WINDOW_MS;
}

/**
 * Aggregate freshness of a set of items from their newest capture time.
 * `none` when the set is empty — the honest answer for a place with no media,
 * never dressed up as fresh.
 */
export function aggregateFreshness(capturedAts: string[], nowMs: number): FreshnessState {
  let newest = -Infinity;
  for (const c of capturedAts) {
    const t = new Date(c).getTime();
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (!Number.isFinite(newest) || newest === -Infinity) return "none";
  const ageMs = nowMs - newest;
  if (ageMs < FRESH_WINDOW_MS) return "fresh";
  if (ageMs < RECENT_WINDOW_MS) return "recent";
  return "historical";
}

/** Count of items whose age is within the fresh window. */
export function countFresh(capturedAts: string[], nowMs: number): number {
  let n = 0;
  for (const c of capturedAts) {
    const ageMs = nowMs - new Date(c).getTime();
    if (isFreshEnoughForLabel(ageMs)) n += 1;
  }
  return n;
}
