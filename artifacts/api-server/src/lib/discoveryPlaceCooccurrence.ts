/**
 * discoveryPlaceCooccurrence — census-discovery DV-72 (§95, lane W11-X3;
 * register D-W11X3-1): the reader and the rebuild tick for `place_cooccurrence`
 * (migration 3495), the Trail-derived form of `10` §3's co-occurrence
 * projection.
 *
 * WHAT IT IS
 * ==========
 * Two places co-occur when a non-archived Trail holds both. The projection is
 * derived from `content_trails` alone — an editorial record — and reads no
 * person's itinerary, trip or movement. The people-derived form (`05` §2's
 * "itineraries, trip sequences, transitions") is NOT built: it is W10D-C5's
 * owner question, and 3495's CHECK admits only basis 'shared_trail'.
 *
 * WHAT GATES IT
 * =============
 * `discovery_place_cooccurrence_enabled` (3496, seeded FALSE), read fail-closed:
 *   - the tick: OFF, it reads that one flag row and calls nothing;
 *   - the reader: OFF, it answers `disabled` and never touches the table.
 * An unreadable table is `unreadable`, never an empty neighbour list.
 *
 * WHAT A READER GETS, AND WHAT IT STILL OWES
 * ==========================================
 * Place ids and counts, with `10` §9 lineage. Not rows: a serving surface must
 * still apply its own eligibility to each id (status, city, blocks, standing —
 * lib/discoveryCandidates/materialize.ts is the Discovery form of it), because
 * the projection is a function of the catalogue, not of a viewer. No ranker
 * reads it at this tree.
 *
 * Shape of the tick: lib/discoveryTrendRebuildScheduler.ts's (startup delay,
 * unref'd interval, an in-process guard against overlapping ticks).
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";

const logger = rootLogger.child({ job: "PlaceCooccurrenceRebuild" });

/** 3496. Read with this literal at every site (check:flag-polarity). */
export const PLACE_COOCCURRENCE_FLAG = "discovery_place_cooccurrence_enabled";

/** MUST equal 3495's c_model / c_feature (pinned by src/test/discoveryPlaceCooccurrence.test.ts). */
export const PLACE_COOCCURRENCE_MODEL_VERSION = "place-cooccurrence-shared-trail-v1";
export const PLACE_COOCCURRENCE_FEATURE_VERSION = "trail-place-membership-v1";
/** MUST equal 3495's c_max_trail_places. */
export const PLACE_COOCCURRENCE_MAX_TRAIL_PLACES = 100;

/** Hourly: Trail membership changes by editorial act, not by the minute. */
export const PLACE_COOCCURRENCE_REBUILD_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS = 3 * 60_000;

/** Most neighbours one read returns. */
export const PLACE_COOCCURRENCE_READ_LIMIT = 20;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlaceCooccurrenceNeighbour {
  placeId: string;
  sharedTrails: number;
  provenance: {
    basis: "shared_trail";
    sourceWindow: { start: string; end: string };
    featureVersion: string;
    modelVersion: string;
    computedAt: string;
  };
}

export type PlaceCooccurrenceRead =
  | { status: "disabled" }
  | { status: "invalid_place" }
  | { status: "unreadable"; failedRead: string }
  | { status: "ok"; neighbours: PlaceCooccurrenceNeighbour[] };

interface Row {
  place_a?: unknown; place_b?: unknown; basis?: unknown; shared_trail_count?: unknown;
  source_window_start?: unknown; source_window_end?: unknown;
  feature_version?: unknown; model_version?: unknown; computed_at?: unknown;
}

const SELECT = "place_a, place_b, basis, shared_trail_count, source_window_start, source_window_end, feature_version, model_version, computed_at";

function neighbourOf(row: Row, self: string): PlaceCooccurrenceNeighbour | null {
  const a = typeof row.place_a === "string" ? row.place_a.toLowerCase() : null;
  const b = typeof row.place_b === "string" ? row.place_b.toLowerCase() : null;
  if (!a || !b || row.basis !== "shared_trail") return null;
  const other = a === self ? b : b === self ? a : null;
  const n = typeof row.shared_trail_count === "number" ? row.shared_trail_count : Number(row.shared_trail_count);
  if (!other || !Number.isInteger(n) || n < 1) return null;
  return {
    placeId: other,
    sharedTrails: n,
    provenance: {
      basis: "shared_trail",
      sourceWindow: { start: String(row.source_window_start), end: String(row.source_window_end) },
      featureVersion: String(row.feature_version),
      modelVersion: String(row.model_version),
      computedAt: String(row.computed_at),
    },
  };
}

/**
 * The places that share a Trail with `placeId`, most shared Trails first, then
 * by id. Two reads — the place as `place_a` (the primary key) and as `place_b`
 * (idx_place_cooccurrence_b) — because a pair is stored once, ordered.
 */
export async function readPlaceCooccurrence(
  sc: any, placeId: string, opts: { limit?: number } = {},
): Promise<PlaceCooccurrenceRead> {
  if (!sc || !(await isFlagEnabled(sc, "discovery_place_cooccurrence_enabled"))) return { status: "disabled" };
  const self = typeof placeId === "string" ? placeId.replace(/^db\//, "").toLowerCase() : "";
  if (!UUID_RX.test(self)) return { status: "invalid_place" };
  const limit = Math.max(1, Math.min(opts.limit ?? PLACE_COOCCURRENCE_READ_LIMIT, PLACE_COOCCURRENCE_READ_LIMIT));
  const half = async (col: "place_a" | "place_b"): Promise<Row[] | null> => {
    try {
      const { data, error } = await sc
        .from("place_cooccurrence")
        .select(SELECT)
        .eq(col, self)
        .order("shared_trail_count", { ascending: false })
        .order(col === "place_a" ? "place_b" : "place_a", { ascending: true })
        .limit(limit);
      return error || !Array.isArray(data) ? null : (data as Row[]);
    } catch {
      return null;
    }
  };
  const [asA, asB] = await Promise.all([half("place_a"), half("place_b")]);
  if (asA === null) return { status: "unreadable", failedRead: "place_cooccurrence.place_a" };
  if (asB === null) return { status: "unreadable", failedRead: "place_cooccurrence.place_b" };
  const neighbours = [...asA, ...asB]
    .map((r) => neighbourOf(r, self))
    .filter((n): n is PlaceCooccurrenceNeighbour => n !== null)
    .sort((x, y) => (y.sharedTrails - x.sharedTrails) || (x.placeId < y.placeId ? -1 : x.placeId > y.placeId ? 1 : 0))
    .slice(0, limit);
  return { status: "ok", neighbours };
}

// ── The rebuild tick ─────────────────────────────────────────────────────────

let _running = false;
let _testClient: any | null = null;
/** Inject a fake client in tests; pass null to restore. */
export function _setTestClient(sc: any | null): void { _testClient = sc; }

export type PlaceCooccurrenceTick =
  | { status: "skipped"; reason: "already_running" | "no_client" | "disabled" }
  | { status: "failed"; reason: string; pNow: string }
  | { status: "ran"; pNow: string; written: number | null };

/** The run instant for a tick at `nowMs`: the start of its hour, so two instances write one run. */
export function cooccurrenceRebuildInstant(nowMs: number): string {
  return new Date(Math.floor(nowMs / PLACE_COOCCURRENCE_REBUILD_INTERVAL_MS) * PLACE_COOCCURRENCE_REBUILD_INTERVAL_MS).toISOString();
}

/** One tick. Exported so a test can drive it without timers. */
export async function runPlaceCooccurrenceRebuildTick(nowMs: number = Date.now()): Promise<PlaceCooccurrenceTick> {
  if (_running) return { status: "skipped", reason: "already_running" };
  const sc = _testClient ?? (isServiceClientReady ? getServiceClient() : null);
  if (!sc) return { status: "skipped", reason: "no_client" };
  _running = true;
  try {
    if (!(await isFlagEnabled(sc, "discovery_place_cooccurrence_enabled"))) return { status: "skipped", reason: "disabled" };
    const pNow = cooccurrenceRebuildInstant(nowMs);
    const { data, error } = await sc.rpc("rebuild_place_cooccurrence", { p_now: pNow });
    if (error) {
      logger.warn({ code: error?.code, message: error?.message, pNow }, "PlaceCooccurrenceRebuild: rebuild failed");
      return { status: "failed", reason: String(error?.code ?? error?.message ?? "rpc_error"), pNow };
    }
    const written = typeof data === "number" ? data : null;
    logger.info({ pNow, written }, "PlaceCooccurrenceRebuild: run stored");
    return { status: "ran", pNow, written };
  } finally {
    _running = false;
  }
}

/** Start the hourly rebuild. Returns the interval handle so tests can cancel it. */
export function startPlaceCooccurrenceRebuildScheduler(): ReturnType<typeof setInterval> {
  const tick = () => { runPlaceCooccurrenceRebuildTick().catch((err) => logger.warn({ err }, "PlaceCooccurrenceRebuild: tick error")); };
  const startupTimer = setTimeout(tick, STARTUP_DELAY_MS);
  const interval = setInterval(tick, PLACE_COOCCURRENCE_REBUILD_INTERVAL_MS);
  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();
  logger.info({ intervalMinutes: PLACE_COOCCURRENCE_REBUILD_INTERVAL_MS / 60_000 }, "PlaceCooccurrenceRebuild: started");
  return interval;
}
