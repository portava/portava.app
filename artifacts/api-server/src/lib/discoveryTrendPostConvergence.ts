/**
 * discoveryTrendPostConvergence — "visitors post afterward", one of `03` §6's
 * five independent-convergence signals, for the v2 trend classifier
 * (census-discovery DV-34, §95, lane W11-X3; register D-W11X3-2; work item
 * W11A-B9).
 *
 * THE SIGNAL
 * ==========
 * For a place key and a window, the travellers who PUBLISHED a PUBLIC Memory
 * at the place inside the window, after their own positive Discovery outcome
 * at that place (a save, a trip add, or any other positive outcome — the same
 * set lib/discoveryTrendNormalised counts as activity). A Memory counts only
 * when `state = 'published'` AND `visibility = 'public'`: the one rung of the
 * six-rung audience ladder whose audience is the world, the basis D-W10-R3-5
 * and the Compass graph builder already use (compass/CompassGraphEngine.ts
 * `isPublicWorldMemory`). A draft, archived, removed, friends-only, crew,
 * circle, only-me or custom Memory is never read into this signal.
 *
 * WHAT IT IS NOT
 * ==============
 * It reads no circle, crew, check-in, passport stamp or visit record. Those
 * are AR-W11A-2's legs and wait on the owner. It never names anyone: the
 * author ids live only inside one computation and leave it as COUNTS.
 *
 * THE K-FLOOR
 * ===========
 * A window contributes only when at least POST_CONVERGENCE_MIN_AUTHORS (2)
 * distinct travellers qualify — first over every qualifying author, and again
 * over the authors who are NEW to the window's convergence (not already one of
 * its activity actors). Below the floor the window contributes 0, so no count
 * this leg adds ever rests on one person.
 *
 * HOW IT FEEDS THE CLASSIFIER
 * ===========================
 * lib/discoveryTrendNormalised `computeTrendStatesV2(…, { postAfterVisit })`:
 * the window's independent-group count G gains the independence clusters
 * (Sensing's clustering, reused) of the NEW authors. An author who is already
 * an activity actor in that window adds nothing — the same traveller is not
 * independent evidence twice. The addition is never negative, so the leg can
 * only add convergence, never remove it. Activity, exposure and the rate are
 * unchanged.
 *
 * GATE
 * ====
 * `discovery_trend_post_convergence_enabled` (3496, seeded FALSE), read by
 * lib/discoveryLocalMomentum.ts only when `discovery_trend_normalised_enabled`
 * (3475) is also on. Off, absent or unreadable: no Memory is read and no
 * option is passed, so every reading is byte-identical to §84's.
 */
import type { TrendRowV2 } from "./discoveryTrendNormalised.js";

/** 3496. Read with this literal at its one site (check:flag-polarity). */
export const TREND_POST_CONVERGENCE_FLAG = "discovery_trend_post_convergence_enabled";

/** The k-floor: fewer distinct authors than this contribute nothing. */
export const POST_CONVERGENCE_MIN_AUTHORS = 2;

/** Most Memory rows one read takes; a full page is reported unread, never partial. */
export const POST_CONVERGENCE_MEMORY_LIMIT = 1000;

/** The `memories` columns the loader reads. */
export interface PublicMemoryRow {
  owner_id?: string | null;
  place_id?: string | null;
  created_at?: string | null;
  state?: string | null;
  visibility?: string | null;
}

export type PostWindow = "recent" | "mid" | "prior";
export type PostAuthorsByWindow = Readonly<Record<PostWindow, readonly string[]>>;

/** The option computeTrendStatesV2 takes. `unread` adds nothing and says so. */
export type PostAfterVisitInput =
  | { status: "ok"; byKey: ReadonlyMap<string, PostAuthorsByWindow>; posts: ReadonlyMap<string, ReadonlyMap<string, number>> }
  | { status: "unread" };

/** A Memory eligible for public-world intelligence (the Compass rule, restated: this module may not import the engine). */
export function isPublicPublishedMemory(m: PublicMemoryRow | null | undefined): boolean {
  return !!m && m.state === "published" && m.visibility === "public";
}

const lowerKey = (itemId: string): string => itemId.replace(/^db\//, "").toLowerCase();

function positive(outcome: string): boolean {
  return outcome !== "impression" && outcome !== "analytics" && outcome !== "dismiss";
}

/**
 * Rows + Memories → per trend key, per window, the qualifying authors (k-floored)
 * and each author's earliest qualifying post time (for the independence
 * clustering). Pure. `keyOf` is the classifier's key (the item id by default).
 */
export function postAfterVisitAuthors(
  rows: readonly TrendRowV2[],
  memories: readonly PublicMemoryRow[],
  nowMs: number,
  windows: { recentMs: number; midMs: number; priorMs: number },
  keyOf: (row: TrendRowV2) => string | null = (r) => r.item_id,
): PostAfterVisitInput {
  const recentSince = nowMs - windows.recentMs;
  const midSince = nowMs - windows.midMs;
  const priorSince = nowMs - windows.priorMs;
  const winOf = (at: number): PostWindow => (at >= recentSince ? "recent" : at >= midSince ? "mid" : "prior");

  // place (lower-case uuid) → trend key → author → earliest positive outcome.
  const firstVisit = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    if (!r?.item_id || !positive(r.outcome) || !(Date.parse(String(r.served_at)) >= priorSince)) continue;  // §95.9: served inside the window, the loader's read and the SQL twin's (3497)
    const actor = typeof r.user_id === "string" && r.user_id !== "" ? r.user_id.toLowerCase() : null;
    const at = typeof r.outcome_at === "string" ? Date.parse(r.outcome_at) : NaN;
    const key = keyOf(r);
    if (!actor || key === null || !Number.isFinite(at) || at > nowMs) continue;
    const place = lowerKey(r.item_id);
    const byKey = firstVisit.get(place) ?? new Map<string, Map<string, number>>();
    const byActor = byKey.get(key) ?? new Map<string, number>();
    const prev = byActor.get(actor);
    byActor.set(actor, prev === undefined ? at : Math.min(prev, at));
    byKey.set(key, byActor);
    firstVisit.set(place, byKey);
  }

  // trend key → window → author → earliest qualifying post.
  const acc = new Map<string, Record<PostWindow, Map<string, number>>>();
  for (const m of memories) {
    if (!isPublicPublishedMemory(m)) continue;
    const author = typeof m.owner_id === "string" && m.owner_id !== "" ? m.owner_id.toLowerCase() : null;
    const place = typeof m.place_id === "string" ? m.place_id.toLowerCase() : null;
    const at = typeof m.created_at === "string" ? Date.parse(m.created_at) : NaN;
    if (!author || !place || !Number.isFinite(at) || at > nowMs || at < priorSince) continue;
    for (const [key, byActor] of firstVisit.get(place) ?? []) {
      const visit = byActor.get(author);
      if (visit === undefined || !(at > visit)) continue;   // AFTER their own positive outcome
      const w = acc.get(key) ?? { recent: new Map(), mid: new Map(), prior: new Map() };
      const win = winOf(at);
      const prev = w[win].get(author);
      w[win].set(author, prev === undefined ? at : Math.min(prev, at));
      acc.set(key, w);
    }
  }

  const byKey = new Map<string, PostAuthorsByWindow>();
  const posts = new Map<string, Map<string, number>>();
  for (const [key, w] of acc) {
    const floored = (m: Map<string, number>): string[] => (m.size >= POST_CONVERGENCE_MIN_AUTHORS ? [...m.keys()].sort() : []);
    const entry = { recent: floored(w.recent), mid: floored(w.mid), prior: floored(w.prior) };
    if (entry.recent.length + entry.mid.length + entry.prior.length === 0) continue;
    byKey.set(key, entry);
    const times = new Map<string, number>();
    for (const win of ["recent", "mid", "prior"] as const) {
      for (const a of entry[win]) times.set(`${win}|${a}`, w[win].get(a)!);
    }
    posts.set(key, times);
  }
  return { status: "ok", byKey, posts };
}

/**
 * Read the PUBLISHED, PUBLIC Memories at these places since `sinceIso`.
 * Null when the read failed or hit its ceiling: an unreadable (or truncated)
 * Memory set is not an empty one, and the caller passes `{ status: "unread" }`.
 */
export async function loadPublicMemoriesAtPlaces(
  sc: any, placeKeys: readonly string[], sinceIso: string,
): Promise<PublicMemoryRow[] | null> {
  const ids = [...new Set(placeKeys.map(lowerKey))].filter((k) => k.length > 0).sort();
  if (ids.length === 0) return [];
  try {
    const { data, error } = await sc
      .from("memories")
      .select("owner_id, place_id, created_at, state, visibility")
      .in("place_id", ids)
      .eq("state", "published")
      .eq("visibility", "public")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(POST_CONVERGENCE_MEMORY_LIMIT);
    if (error || !Array.isArray(data)) return null;
    if (data.length >= POST_CONVERGENCE_MEMORY_LIMIT) return null;
    return data as PublicMemoryRow[];
  } catch {
    return null;
  }
}
