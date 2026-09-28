/**
 * The city-confidence producer's corpus, read in a deterministic order over a
 * stated window — census-discovery §85 (lane W10-R3), H-P21-4 (DC-17's last
 * leg, §75.3). Behind `compass_city_confidence_windowed_reads_enabled` (3484,
 * seeded FALSE).
 *
 * WHAT §75.3 FOUND, AND WHAT THIS CHANGES. `computeCityConfidenceIndex` read
 * `compass_graph_edges` and `compass_graph_nodes` with `.limit(20000)` and no
 * `order`, and destructured `data` while dropping `error`:
 *
 *   1. above the cap the corpus was whatever subset the planner returned, so
 *      no source window could be stated for any reading;
 *   2. a failed read scored the city as having zero visitors or events, so a
 *      reading could not tell an outage from an empty corpus.
 *
 * With the flag on, every one of the producer's four reads here is ORDERED
 * (most recently observed first, id as the tie-break) and PAGED with `.range()`
 * until a short page or CITY_DEPTH_MAX_ROWS. The window is then a fact:
 *
 *   complete read   `unbounded_start` at the computation clock — every row the
 *                   table held was read;
 *   truncated read  `bounded` from the oldest `last_seen` (or `updated_at`) the
 *                   read reached to the computation clock — the rows before it
 *                   were not counted, and the record says so.
 *
 * A read that fails is REPORTED (`readErrors`) and the producer scores NO city
 * on that run: a failed corpus is unknowable, not empty, and the last good
 * reading stays in place rather than being overwritten by a false zero.
 *
 * WHAT MOVES WITH THE FLAG ON: `depth_score` (and so `tier`) for any city whose
 * edges sat beyond the old unordered 20000-row cap, and for any run in which a
 * read failed (no longer written as zero). That is a computed value, which is
 * why it is behind a NEW flag seeded FALSE with the flag-off path byte-identical
 * (src/test/compassCityConfidenceWindow.test.ts W0) — D-W10-R3-9.
 *
 * The same run writes three provenance columns (3484) beside `computed_at`:
 * `model_version` (scoreCityDepth's arithmetic), `feature_version` (what one
 * edge contributes) and `source_window` (the window above), so the reading
 * carries all four `10` §5 facts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../lib/featureFlags.js";

export const COMPASS_CITY_CONFIDENCE_WINDOWED_READS_FLAG = "compass_city_confidence_windowed_reads_enabled";

/** Bump when scoreCityDepth's weights, saturations or tiers change. */
export const CITY_DEPTH_MODEL_VERSION = "compass-city-depth-v1";
/**
 * Bump when what one row contributes changes: a `visited` / `returned_to` edge
 * is one person, an event node one event, an `outcome:*` edge on a city's event
 * one outcome, a slice with MIN_SLICE_SAMPLE observations one covered slice.
 */
export const CITY_DEPTH_FEATURE_VERSION = "compass-city-depth-signals-v1";

/** Rows per page — PostgREST's usual max-rows, so a page is never silently short. */
export const CITY_DEPTH_PAGE_SIZE = 1_000;
/** Hard ceiling per read. Reaching it truncates the window and the record says where. */
export const CITY_DEPTH_MAX_ROWS = 100_000;

export interface CityDepthWindow {
  kind: "unbounded_start" | "bounded";
  startMs: number | null;
  endMs: number;
  /** True when a read stopped at CITY_DEPTH_MAX_ROWS. */
  truncated: boolean;
  /** Rows each read returned, by read. */
  rows: Record<string, number>;
}

export interface CityConfidenceProvenanceColumns {
  model_version: string;
  feature_version: string;
  source_window: CityDepthWindow;
}

export interface WindowedCityCorpus {
  /** The same three results `computeCityConfidenceIndex`'s Promise.all yields. */
  base: [{ data: any[] | null }, { data: any[] | null }, { data: any[] | null }];
  outcomes: any[];
  computedAtIso: string;
  window: CityDepthWindow;
  readErrors: string[];
  provenance: CityConfidenceProvenanceColumns;
}

type Page = (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>;

async function readAll(name: string, page: Page, tsCol: string | null): Promise<{ rows: any[]; truncated: boolean; oldestMs: number | null; error: string | null }> {
  const rows: any[] = [];
  for (let from = 0; from < CITY_DEPTH_MAX_ROWS; from += CITY_DEPTH_PAGE_SIZE) {
    let r: { data: unknown; error: unknown };
    try { r = await page(from, Math.min(from + CITY_DEPTH_PAGE_SIZE, CITY_DEPTH_MAX_ROWS) - 1); } catch { return { rows, truncated: false, oldestMs: null, error: name }; }
    if (r.error) return { rows, truncated: false, oldestMs: null, error: name };
    const got = Array.isArray(r.data) ? (r.data as any[]) : [];
    rows.push(...got);
    if (got.length < CITY_DEPTH_PAGE_SIZE) return { rows, truncated: false, oldestMs: null, error: null };
  }
  let oldestMs: number | null = null;
  if (tsCol) for (const row of rows) {
    const t = Date.parse(String(row?.[tsCol] ?? ""));
    if (Number.isFinite(t) && (oldestMs === null || t < oldestMs)) oldestMs = t;
  }
  return { rows, truncated: true, oldestMs, error: null };
}

/**
 * The producer's corpus under the flag, or `null` with the flag off (one
 * cached-nowhere flag read; the caller then runs its original reads unchanged).
 */
export async function cityConfidenceWindowedCorpus(db: SupabaseClient, nowMs: number = Date.now()): Promise<WindowedCityCorpus | null> {
  if (!(await isFlagEnabled(db, COMPASS_CITY_CONFIDENCE_WINDOWED_READS_FLAG))) return null;
  const computedAtIso = new Date(nowMs).toISOString();
  const [models, visits, events, outcomes] = await Promise.all([
    readAll("compass_city_models", (a, z) => db.from("compass_city_models").select("city, time_slices, sample_size, built_at")
      .order("city", { ascending: true }).range(a, z), null),
    readAll("compass_graph_edges.visits", (a, z) => db.from("compass_graph_edges").select("id, src_key, dst_key, edge_type, observed_count, last_seen")
      .in("edge_type", ["visited", "returned_to", "in_city"])
      .order("last_seen", { ascending: false, nullsFirst: false }).order("id", { ascending: true }).range(a, z), "last_seen"),
    readAll("compass_graph_nodes.events", (a, z) => db.from("compass_graph_nodes").select("id, node_type, node_key, city, updated_at")
      .eq("node_type", "event")
      .order("updated_at", { ascending: false }).order("id", { ascending: true }).range(a, z), "updated_at"),
    readAll("compass_graph_edges.outcomes", (a, z) => db.from("compass_graph_edges").select("id, dst_key, edge_type, last_seen")
      .like("edge_type", "outcome:%")
      .order("last_seen", { ascending: false, nullsFirst: false }).order("id", { ascending: true }).range(a, z), "last_seen"),
  ]);
  const all = { compass_city_models: models, "compass_graph_edges.visits": visits, "compass_graph_nodes.events": events, "compass_graph_edges.outcomes": outcomes };
  const readErrors = Object.values(all).map((r) => r.error).filter((e): e is string => !!e);
  const truncated = Object.values(all).some((r) => r.truncated);
  const starts = Object.values(all).filter((r) => r.truncated).map((r) => r.oldestMs);
  // The window is the NARROWEST of the reads: a truncated read bounds the corpus.
  const startMs = !truncated ? null : starts.every((s): s is number => s !== null) ? Math.max(...starts) : null;  // null on a truncated read whose rows carried no timestamp: the window is then NOT statable, and `truncated` says so
  const window: CityDepthWindow = {
    kind: truncated ? "bounded" : "unbounded_start",
    startMs, endMs: nowMs, truncated,
    rows: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, r.rows.length])),
  };
  return {
    base: [{ data: models.rows }, { data: visits.rows }, { data: events.rows }],
    outcomes: outcomes.rows,
    computedAtIso, window, readErrors,
    provenance: { model_version: CITY_DEPTH_MODEL_VERSION, feature_version: CITY_DEPTH_FEATURE_VERSION, source_window: window },
  };
}
