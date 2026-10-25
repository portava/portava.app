/**
 * discoveryTrendRebuildScheduler — census-discovery DC-07 (§84, lane W10-R1):
 * the caller `rebuild_place_momentum` never had.
 *
 * D-2's cadence, DECIDED (D-W10-R1-11): every TREND_REBUILD_INTERVAL_MS = five
 * minutes, on the five-minute boundary. The trend API serves a stored run for
 * at most TREND_SNAPSHOT_MAX_AGE_MS (ten minutes, the in-process reading's own
 * life). A run every half of that bound keeps a fresh run available while one
 * tick is late or fails; a run every full bound would read `stale_snapshot`
 * for the length of every rebuild. `p_now` is floored to the boundary, so two
 * API instances ticking in the same five minutes write the SAME run
 * (rebuild_place_momentum is idempotent per p_now) rather than two.
 *
 * Gated fail-closed on `discovery_trend_rebuild_scheduler_enabled` (3475,
 * seeded FALSE): with it off a tick reads that one flag row and writes
 * nothing. Which arithmetic the rebuild runs (v1 or v2) is the SQL function's
 * own flag read, `discovery_trend_normalised_enabled` — not this file's.
 *
 * RETENTION IS NOT DECIDED HERE. How long runs are kept is a retention policy
 * (APPROVAL REQUIRED, D-W10-R1-12). The prune below runs only when
 * `discovery_trend_snapshot_retention_enabled` is TRUE AND its metadata names a
 * positive whole number of days in `keep_days`; 3475 seeds FALSE and NULL, so
 * no deployment deletes a row until the owner sets both.
 *
 * Shape: lib/creatorAttributionScheduler.ts's (startup delay, unref'd interval,
 * an in-process guard against overlapping ticks).
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { getFlagRow, isFlagEnabled } from "./featureFlags.js";
import { unfilteredTrendBlockReason, type TrendProducerPrivacyBlock } from "./discoveryTrendProducerPrivacy.js";
// The API's freshness bound IS this constant (lib/discoveryTrendExplanation TREND_SNAPSHOT_MAX_AGE_MS = MOMENTUM_CACHE_TTL_MS);
// imported from its source so the explanation module keeps its one importer (its route).
import { MOMENTUM_CACHE_TTL_MS as TREND_SNAPSHOT_MAX_AGE_MS } from "./discoveryLocalMomentum.js"; import { trendRebuildRpc } from "./discoveryTrendCanonicalContext.js";  // §133: which rebuild a tick calls

const logger = rootLogger.child({ job: "DiscoveryTrendRebuildScheduler" });

/** D-W10-R1-11: half the freshness bound the API serves a run for. */
export const TREND_REBUILD_INTERVAL_MS = TREND_SNAPSHOT_MAX_AGE_MS / 2;
const STARTUP_DELAY_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

let _running = false;
let _testClient: any | null = null;
/** Inject a fake client in tests; pass null to restore. */
export function _setTestClient(sc: any | null): void { _testClient = sc; }

type TrendSnapshotPrune = "retention_off" | "keep_days_unset" | "pruned" | "prune_failed";

export type TrendRebuildTick =
  | { status: "skipped"; reason: "already_running" | "no_client" | "disabled" }
  | { status: "skipped"; reason: TrendProducerPrivacyBlock; pruned: TrendSnapshotPrune }
  | { status: "failed"; reason: string; pNow: string }
  | { status: "ran"; pNow: string; written: number | null; pruned: TrendSnapshotPrune };

/** The run instant for a tick at `nowMs`: the start of its five-minute boundary. */
export function rebuildInstant(nowMs: number): string {
  return new Date(Math.floor(nowMs / TREND_REBUILD_INTERVAL_MS) * TREND_REBUILD_INTERVAL_MS).toISOString();
}

/** A positive whole number of days, or null — a retention period is never guessed. */
export function keepDaysOf(metadata: Record<string, unknown> | null | undefined): number | null {
  const v = metadata?.["keep_days"];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

async function pruneTrendSnapshots(sc: any, pNow: string): Promise<TrendSnapshotPrune> {
  if (!(await isFlagEnabled(sc, "discovery_trend_snapshot_retention_enabled"))) return "retention_off";
  const keep = keepDaysOf((await getFlagRow(sc, "discovery_trend_snapshot_retention_enabled"))?.metadata);
  if (keep === null) return "keep_days_unset";
  const before = new Date(Date.parse(pNow) - keep * DAY_MS).toISOString();
  const places = await sc.from("place_momentum").delete().lt("computed_at", before);
  const areas = await sc.from("area_momentum").delete().lt("computed_at", before);
  if (places?.error || areas?.error) {
    logger.warn({ place: places?.error?.message, area: areas?.error?.message, before }, "DiscoveryTrendRebuildScheduler: retention prune failed");
    return "prune_failed";
  }
  return "pruned";
}

/** One tick. Exported so a test can drive it without timers. */
export async function runTrendRebuildTick(nowMs: number = Date.now()): Promise<TrendRebuildTick> {
  if (_running) return { status: "skipped", reason: "already_running" };
  const sc = _testClient ?? (isServiceClientReady ? getServiceClient() : null);
  if (!sc) return { status: "skipped", reason: "no_client" };
  _running = true;
  try {
    if (!(await isFlagEnabled(sc, "discovery_trend_rebuild_scheduler_enabled"))) return { status: "skipped", reason: "disabled" };
    const privacyBlock = await unfilteredTrendBlockReason(sc);
    const pNow = rebuildInstant(nowMs);
    if (privacyBlock) {
      const pruned = await pruneTrendSnapshots(sc, pNow);
      logger.info({ pNow, reason: privacyBlock, pruned }, "DiscoveryTrendRebuildScheduler: rebuild withheld");
      return { status: "skipped", reason: privacyBlock, pruned };
    }
    const rebuildRpc = (await trendRebuildRpc(sc)) satisfies "rebuild_place_momentum" | "rebuild_place_momentum_canonical"; const { data, error } = await sc.rpc(rebuildRpc, { p_now: pNow });  // the `satisfies` names both RPCs where the static scans (T366 conversation→Memory boundary, unapplied-schema reads) can see them, and tsc holds it to trendRebuildRpc's return type; §133: 3920's producer over the served places (rebuild_place_momentum_canonical) only while discovery_trend_canonical_place_context_enabled reads TRUE, else rebuild_place_momentum — the one rule, lib/discoveryTrendCanonicalContext.ts trendRebuildRpc
    if (error) {
      logger.warn({ code: error?.code, message: error?.message, pNow }, "DiscoveryTrendRebuildScheduler: rebuild failed");
      return { status: "failed", reason: String(error?.code ?? error?.message ?? "rpc_error"), pNow };
    }
    const written = typeof data === "number" ? data : null;

    const pruned = await pruneTrendSnapshots(sc, pNow);
    logger.info({ pNow, written, pruned }, "DiscoveryTrendRebuildScheduler: run stored");
    return { status: "ran", pNow, written, pruned };
  } finally {
    _running = false;
  }
}

/** Start the periodic rebuild. Returns the interval handle so tests can cancel it. */
export function startDiscoveryTrendRebuildScheduler(): ReturnType<typeof setInterval> {
  const tick = () => { runTrendRebuildTick().catch((err) => logger.warn({ err }, "DiscoveryTrendRebuildScheduler: tick error")); };
  const startupTimer = setTimeout(tick, STARTUP_DELAY_MS);
  const interval = setInterval(tick, TREND_REBUILD_INTERVAL_MS);
  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();
  logger.info({ intervalMinutes: TREND_REBUILD_INTERVAL_MS / 60_000 }, "DiscoveryTrendRebuildScheduler: started");
  return interval;
}
