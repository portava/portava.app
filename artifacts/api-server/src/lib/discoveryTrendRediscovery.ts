/**
 * discoveryTrendRediscovery — census-discovery DV-31 (§84, lane W10-R1):
 * `02` §9.5's "periodically retest promising items", for places that cooled.
 *
 * WHAT IT DOES (D-W10-R1-14)
 * =========================
 * Detection already exists (`rediscovered`, `03` §9). What never existed is the
 * RE-EXPOSURE that lets a cooled place show whether it can come back: a place
 * nobody is shown cannot convert, so without a retest "cooling" is terminal by
 * construction. This module picks, per candidate set and per period, at most
 * RETEST_MAX_PER_PAGE cooled place and moves it into a page slot:
 *
 *   candidate   a v2 reading that is `cooling`, or `unknown` now after carrying
 *               history (≥ TREND_V2_MIN_GROUPS independent groups in the mid or
 *               prior window) — a place that WAS confirmed and has gone quiet.
 *               Never `inactive` (its content-type horizon has passed: a
 *               finished event is not retested), never a place that is not in
 *               this page's candidates (nothing is added to a page).
 *   periodic    one pick per RETEST_PERIOD_MS, rotated by a hash of (period,
 *               place): every candidate comes round, none is pinned, and the
 *               same period picks the same place on every request (a retry is
 *               byte-identical).
 *   slot        the middle of the page, never position 0: the top slot stays
 *               the ranker's, exactly as the exploration governor keeps it.
 *   budget      one slot per page — inside the ruled 15–25 % exploration
 *               budget for any page of ≥ 4 items (GOVERNOR_BUDGET_MIN_PCT).
 *
 * The retest is MEASURED by the machinery that already exists: the re-exposed
 * place is logged as an exposure like any other, and the next rebuild reads
 * whether it converted (`rediscovered` if it did).
 *
 * Behind `discovery_trend_rediscovery_retest_enabled` (3475, seeded FALSE) AND
 * the v2 model: the pool is lib/discoveryLocalMomentum `readRetestReadings`,
 * which is empty unless `discovery_trend_normalised_enabled` computed v2.
 *
 * THE CONSUMER. Page order is decided in lib/discoveryPde.ts. The hunk that
 * calls `planRediscoveryRetest` after the exploration governor (§84.5,
 * H-W10R1-1) landed in census-discovery §93 (lane W11-X1): `rankForViewer`'s
 * retest stage, only with the modifiers on (discoveryRediscoveryRetestServe).
 */
import { isFlagEnabled } from "./featureFlags.js";
import { readRetestReadings } from "./discoveryLocalMomentum.js";
import type { TrendReading } from "./discoveryTrendState.js";
import { TREND_V2_MIN_GROUPS, type TrendEvidenceV2 } from "./discoveryTrendNormalised.js";

/** One retest per page. */
export const RETEST_MAX_PER_PAGE = 1;
/** A candidate set rotates its retest once a day. */
export const RETEST_PERIOD_MS = 24 * 60 * 60 * 1_000;
/** Below this many items there is no middle to use without taking the top slot's neighbour. */
export const RETEST_MIN_PAGE = 4;

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Is this reading a cooled place worth retesting? */
export function isRetestCandidate(r: TrendReading | undefined): boolean {
  if (!r || r.lifecycle === undefined || r.lifecycle === "inactive") return false;   // v2 readings only; never past its horizon
  if (r.state === "cooling") return true;
  if (r.state !== "unknown") return false;
  const e = r.evidence as Partial<TrendEvidenceV2>;
  return (e.midGroups ?? 0) >= TREND_V2_MIN_GROUPS || (e.priorGroups ?? 0) >= TREND_V2_MIN_GROUPS;
}

/** The period's pick among the candidates on this page, or null. Pure and deterministic. */
export function pickRetest(pageIds: readonly string[], readings: Readonly<Record<string, TrendReading>>, nowMs: number): string | null {
  const period = Math.floor(nowMs / RETEST_PERIOD_MS);
  let best: { id: string; h: number } | null = null;
  for (const id of new Set(pageIds)) {
    if (!isRetestCandidate(readings[id])) continue;
    const h = fnv1a(`${period}:${id}`);
    if (!best || h < best.h || (h === best.h && id < best.id)) best = { id, h };
  }
  return best?.id ?? null;
}

export interface RetestPlan {
  /** The page in served order, a permutation of the input. */
  order: string[];
  /** The re-exposed place and the slot it was moved to; null when nothing was retested. */
  retest: { id: string; slot: number; fromIndex: number } | null;
}

/**
 * Move the period's pick to the middle of the page. A permutation: nothing is
 * added or dropped. A pick already at or above the middle stays where it is
 * (it is exposed anyway; a retest never DEMOTES a place).
 */
export function applyRediscoveryRetest(order: readonly string[], pick: string | null): RetestPlan {
  const base = [...order];
  if (pick === null || base.length < RETEST_MIN_PAGE) return { order: base, retest: null };
  const from = base.indexOf(pick);
  if (from < 0) return { order: base, retest: null };
  const slot = Math.max(1, Math.floor(base.length / 2));
  if (from <= slot) return { order: base, retest: null };
  base.splice(from, 1);
  base.splice(slot, 0, pick);
  return { order: base, retest: { id: pick, slot, fromIndex: from } };
}

/**
 * The serve-path entry point H-W10R1-1 calls: the flag, then the v2 pool the
 * momentum load kept for this candidate key, then the plan. With the flag off,
 * unreadable, or no v2 pool, the order comes back unchanged and `retest` null.
 */
export async function planRediscoveryRetest(sc: any, cacheKey: string, order: readonly string[], nowMs: number): Promise<RetestPlan> {
  if (!sc || !(await isFlagEnabled(sc, "discovery_trend_rediscovery_retest_enabled"))) return { order: [...order], retest: null };
  return applyRediscoveryRetest(order, pickRetest(order, readRetestReadings(cacheKey, nowMs), nowMs));
}
