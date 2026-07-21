/**
 * Intelligence Graph Rebuild Scheduler — Phase 15 freshness.
 *
 * Keeps the Travel Intelligence Graph (nodes/edges, per-city Destination
 * World Models, city-confidence index) fresh automatically, instead of only
 * after a manual admin POST /api/compass/graph/rebuild.
 *
 * Follows the compassAbuseScanScheduler pattern:
 *   - Initial run 60 s after server start (lets Supabase client finish init)
 *   - Daily thereafter via setInterval (rebuild is a full idempotent upsert,
 *     so cadence only affects freshness — never correctness)
 *   - Fail-soft: any error is logged and swallowed; the graph job must never
 *     crash the server, and a failed run simply retries at the next tick.
 *   - Overlap guard: an in-process `running` flag skips a tick while a
 *     previous rebuild is still in flight, so runs never overlap.
 */

import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { rebuildIntelligenceGraph, type GraphRebuildReport } from "../compass/CompassGraphEngine.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const logger = rootLogger.child({ job: "IntelligenceGraphScheduler" });

const STARTUP_DELAY_MS    = 60_000;                 // 1 minute
const REBUILD_INTERVAL_MS = 24 * 60 * 60_000;       // daily

// ── test hooks ────────────────────────────────────────────────────────────────

type RebuildFn = (db: SupabaseClient) => Promise<GraphRebuildReport>;

/** Injected rebuild implementation for tests; null = real engine. */
let _testRebuild: RebuildFn | null = null;

export function _setTestRebuild(fn: RebuildFn | null): void {
  _testRebuild = fn;
}

/** Injected service-client getter for tests; null = real getServiceClient. */
let _testGetClient: (() => SupabaseClient | null) | null = null;

export function _setTestGetClient(fn: (() => SupabaseClient | null) | null): void {
  _testGetClient = fn;
}

// ── run-once ──────────────────────────────────────────────────────────────────

/** In-process overlap guard — true while a rebuild is in flight. */
let running = false;

// ── last-run record ───────────────────────────────────────────────────────────

export type LastRebuildOutcome = "completed" | "failed";

export interface LastRebuildInfo {
  /** ISO timestamp of when the last run finished (success or failure). */
  lastRebuildAt: string | null;
  /** Outcome of the last completed/failed run; null if none has run yet. */
  lastOutcome: LastRebuildOutcome | null;
  /** Rebuild report from the last successful run, if any. */
  lastReport: GraphRebuildReport | null;
}

/**
 * In-memory record of the last run that actually executed (skips don't count).
 * Resets on server restart — that's acceptable: staleness visibility only.
 */
let lastRebuild: LastRebuildInfo = {
  lastRebuildAt: null,
  lastOutcome: null,
  lastReport: null,
};

/** Read-only snapshot of the last rebuild for the admin status endpoint. */
export function getLastRebuildInfo(): LastRebuildInfo {
  return { ...lastRebuild };
}

/** Test hook: reset the last-run record between tests. */
export function _resetLastRebuildInfo(): void {
  lastRebuild = { lastRebuildAt: null, lastOutcome: null, lastReport: null };
}

export type SchedulerRunResult =
  | { status: "completed"; report: GraphRebuildReport }
  | { status: "skipped"; reason: "overlap" | "no_service_client" }
  | { status: "failed" };

/**
 * Run one scheduled rebuild. Never throws:
 *  - skips (without queueing) when a previous run is still in flight,
 *  - skips when the service client is unavailable,
 *  - logs and swallows any rebuild/DB failure.
 */
export async function runIntelligenceGraphRebuildOnce(): Promise<SchedulerRunResult> {
  if (running) {
    logger.info("IntelligenceGraphScheduler: previous rebuild still running — skipping this tick");
    return { status: "skipped", reason: "overlap" };
  }

  const sc = _testGetClient ? _testGetClient() : getServiceClient();
  if (!sc) {
    logger.warn("IntelligenceGraphScheduler: service client unavailable — skipping rebuild");
    return { status: "skipped", reason: "no_service_client" };
  }

  running = true;
  const startedAt = Date.now();
  try {
    const rebuild = _testRebuild ?? rebuildIntelligenceGraph;
    const report = await rebuild(sc);
    lastRebuild = {
      lastRebuildAt: new Date(Date.now()).toISOString(),
      lastOutcome: "completed",
      lastReport: report,
    };
    logger.info(
      { ...report, durationMs: Date.now() - startedAt },
      "IntelligenceGraphScheduler: scheduled rebuild completed",
    );
    return { status: "completed", report };
  } catch (err) {
    lastRebuild = {
      lastRebuildAt: new Date(Date.now()).toISOString(),
      lastOutcome: "failed",
      lastReport: lastRebuild.lastReport,
    };
    // Fail-soft: a failing rebuild (e.g. DB outage) never crashes the server;
    // the next scheduled tick simply tries again.
    logger.error(
      { err, durationMs: Date.now() - startedAt },
      "IntelligenceGraphScheduler: scheduled rebuild failed",
    );
    return { status: "failed" };
  } finally {
    running = false;
  }
}

// ── scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the daily intelligence-graph rebuild scheduler.
 * Returns the interval handle so callers can cancel it in tests.
 */
export function startIntelligenceGraphScheduler(): ReturnType<typeof setInterval> {
  const startupTimer = setTimeout(() => {
    runIntelligenceGraphRebuildOnce().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    runIntelligenceGraphRebuildOnce().catch(() => {});
  }, REBUILD_INTERVAL_MS);

  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  logger.info(
    { intervalHours: REBUILD_INTERVAL_MS / 3_600_000 },
    "IntelligenceGraphScheduler: daily scheduler started",
  );

  return interval;
}
