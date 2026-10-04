/**
 * discoveryRankDiversity — DV-54: diversity on all six `06` §6 axes.
 * census-discovery §78 (lane W10-R2).
 *
 * `06` §6: "Apply constraints across: creator, place, Trail, content type,
 * geography, repeated recommendation history." §69.3 counted 3 of 6: creator
 * and content type pass; geography is PARTIAL because `geoPenalty` is
 * undefaulted; place likewise; Trail FAILS because `diversify()` compares no
 * Trail key; history is PARTIAL (a 24 h seen demotion, not enforced diversity).
 *
 * WHAT THIS MODULE SUPPLIES
 * =========================
 *   magnitudes   placePenalty, geoPenalty, trailPenalty, historyPenalty,
 *                historyMaxServes, historyWindowDays — READ FROM THE FLAG ROW'S
 *                METADATA, never from a code constant, exactly as
 *                ranker-hold-designs §2 specified. A null or absent magnitude is
 *                0 and leaves its axis off. Migration 3454 seeds the values this
 *                lane decided (D-W10-R2-7) into that metadata, so they are
 *                visible and owner-editable without a deploy.
 *   Trail key    `candidate.trailIds`: the non-archived Trails whose
 *                `content_trails` list the place as a `primary` or `supporting`
 *                member (a `signal` membership is evidence for a Trail, not
 *                membership of it). portavaRank.repetitionPenalty compares it.
 *   history key  `candidate.servedCount`: how many times THIS viewer was served
 *                the place on the discovery surface inside historyWindowDays
 *                (non-analytics `rank_events` rows — the same cut the 24 h seen
 *                read makes). portavaRank.diversify charges historyPenalty per
 *                prior serve, up to historyMaxServes, inside the greedy re-rank —
 *                so it competes with the other five axes rather than being a
 *                second, separate demotion.
 *
 * Both reads are non-fatal and independent: a Trail read that fails leaves the
 * Trail axis without keys (no penalty), a history read that fails leaves the
 * history axis without counts, and each says so in `degraded`.
 */
import { memberIdForServedId } from "../services/trails/TrailService.js";
import type { DiversityOptions } from "./portavaRank.js";

export interface DiversityMagnitudes {
  placePenalty: number;
  geoPenalty: number;
  trailPenalty: number;
  historyPenalty: number;
  historyMaxServes: number;
  historyWindowDays: number;
}

const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

/** Penalties above 1 would out-weigh `actionability` 0.9 on repetition alone; refused, not clamped. */
export const DIVERSITY_PENALTY_MAX = 1;

/** Parse the flag metadata. Every absent / null / out-of-range value turns its axis OFF. */
export function parseDiversityMagnitudes(metadata: unknown): DiversityMagnitudes {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  return {
    placePenalty: num(m.placePenalty, 0, DIVERSITY_PENALTY_MAX) ?? 0,
    geoPenalty: num(m.geoPenalty, 0, DIVERSITY_PENALTY_MAX) ?? 0,
    trailPenalty: num(m.trailPenalty, 0, DIVERSITY_PENALTY_MAX) ?? 0,
    historyPenalty: num(m.historyPenalty, 0, DIVERSITY_PENALTY_MAX) ?? 0,
    historyMaxServes: Math.round(num(m.historyMaxServes, 1, 20) ?? 3),
    historyWindowDays: num(m.historyWindowDays, 1, 30) ?? 7,
  };
}

/** The DiversityOptions the magnitudes become. Author and kind stay portavaRank's own. */
export function diversityOptionsFrom(m: DiversityMagnitudes): DiversityOptions {
  return {
    placePenalty: m.placePenalty,
    geoPenalty: m.geoPenalty,
    trailPenalty: m.trailPenalty,
    historyPenalty: m.historyPenalty,
    historyMaxServes: m.historyMaxServes,
  };
}

/** The `content_trails` relationships that ARE membership. */
export const TRAIL_MEMBER_RELATIONSHIPS = ["primary", "supporting"] as const;
export const MAX_TRAIL_KEY_ROWS = 2_000;
export const MAX_HISTORY_ROWS = 2_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrailKeyRead { trailIds: Map<string, string[]>; degraded: boolean }

/** candidate id → the non-archived Trails it is a member of. */
export async function loadTrailKeys(sc: any, candidateIds: readonly string[]): Promise<TrailKeyRead> {
  const trailIds = new Map<string, string[]>();
  if (candidateIds.length === 0) return { trailIds, degraded: false };
  if (!sc) return { trailIds, degraded: true };
  const byMember = new Map<string, string[]>();
  for (const id of candidateIds) {
    const m = memberIdForServedId(id);
    if (!UUID_RE.test(m)) continue;            // an OSM serve id names no Trail member
    const a = byMember.get(m) ?? []; a.push(id); byMember.set(m, a);
  }
  if (byMember.size === 0) return { trailIds, degraded: false };
  try {
    const members = await sc.from("content_trails").select("trail_id, source_id")
      .eq("source_type", "place").in("relationship", [...TRAIL_MEMBER_RELATIONSHIPS])
      .in("source_id", [...byMember.keys()]).limit(MAX_TRAIL_KEY_ROWS + 1);  // census-discovery §113 (D-W11X2-137): one past the cap
    if (members.error || !Array.isArray(members.data) || members.data.length > MAX_TRAIL_KEY_ROWS) return { trailIds, degraded: true };  // a cut membership read is reported, never a whole grouping
    const trailSet = [...new Set((members.data as any[]).map((r) => r.trail_id).filter(Boolean))];
    if (trailSet.length === 0) return { trailIds, degraded: false };
    const live = await sc.from("trails").select("id").in("id", trailSet).neq("lifecycle_status", "archived");
    if (live.error || !Array.isArray(live.data)) return { trailIds, degraded: true };
    const liveIds = new Set((live.data as any[]).map((r) => r.id));
    for (const r of members.data as any[]) {
      if (!liveIds.has(r.trail_id)) continue;
      for (const cid of byMember.get(r.source_id) ?? []) {
        const a = trailIds.get(cid) ?? [];
        if (!a.includes(r.trail_id)) a.push(r.trail_id);
        trailIds.set(cid, a);
      }
    }
    for (const a of trailIds.values()) a.sort();
    return { trailIds, degraded: false };
  } catch {
    return { trailIds: new Map(), degraded: true };
  }
}

export interface ServeHistoryRead { servedCount: Map<string, number>; degraded: boolean }

/** item id → prior serves to this viewer on the discovery surface inside the window. */
export async function loadServeHistory(
  sc: any, viewerId: string, windowDays: number, nowMs: number,
): Promise<ServeHistoryRead> {
  const servedCount = new Map<string, number>();
  if (!viewerId) return { servedCount, degraded: false };
  if (!sc) return { servedCount, degraded: true };
  try {
    const since = new Date(nowMs - windowDays * 86_400_000).toISOString();
    const res = await sc.from("rank_events").select("item_id, served_at")
      .eq("user_id", viewerId).eq("surface", "discovery").neq("outcome", "analytics")
      .gte("served_at", since).order("served_at", { ascending: false }).limit(MAX_HISTORY_ROWS);
    if (res.error || !Array.isArray(res.data)) return { servedCount, degraded: true };
    const sinceMs = Date.parse(since);
    for (const r of res.data as any[]) {
      if (typeof r?.item_id !== "string" || !r.item_id) continue;
      const t = Date.parse(r.served_at);
      if (Number.isFinite(t) && t < sinceMs) continue;   // belt and braces over the query's own window
      servedCount.set(r.item_id, (servedCount.get(r.item_id) ?? 0) + 1);
    }
    return { servedCount, degraded: false };
  } catch {
    return { servedCount: new Map(), degraded: true };
  }
}
