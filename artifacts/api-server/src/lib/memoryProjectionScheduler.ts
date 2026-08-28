/**
 * Memory projection scheduler — the driver that makes the memory system run.
 *
 * Implements the memory spec's activation step (§22): on a cadence,
 *   1. project_all_memory()   — projects canonical facts + the Experience Graph
 *      (compass_graph_edges) into memory_events / memory_projections. Idempotent
 *      upsert, so cadence only affects freshness, never correctness.
 *   2. memory_sweep_expired()  — retention (§18): expired ephemeral/short-lived
 *      memory is deleted; other expired memory decays (intent §9 decays fast).
 *
 * Both are service_role-only SQL functions (2184/2186 projector, 2185 sweep) that
 * self-check the `memory_projection` flag. Gated here too (fail-closed): off ⇒ an
 * inert no-op that touches nothing. Follows the house scheduler shape
 * (see intelCoverageScheduler / intelProjectionScheduler): startup delay, then a
 * self-rescheduling timer, every error logged and swallowed so a bad pass can
 * never crash the server.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";

const MEMORY_FLAG = "memory_projection";
const STARTUP_DELAY_MS = 5 * 60 * 1000;       // after intel projection (3m) so the graph it reads is fresh
const INTERVAL_MS = 6 * 60 * 60 * 1000;       // every 6h; the projection is idempotent, so cadence only affects freshness

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface MemoryProjectionResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  projected: number;
  swept: number;
}

export async function runMemoryProjectionPass(
  opts: { client?: any } = {},
): Promise<MemoryProjectionResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see intelCoverageScheduler).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty: MemoryProjectionResult = { skipped: true, reason: null, projected: 0, swept: 0 };
  if (!db) return { ...empty, reason: "no_client" };
  if (!(await isFlagEnabled(db, MEMORY_FLAG))) return { ...empty, reason: "disabled" };

  try {
    const { data: projData, error: projErr } = await db.rpc("project_all_memory", { p_enforce_flag: true });
    if (projErr) {
      logger.warn({ err: projErr }, "memory projection: project_all_memory failed");
      return { ...empty, reason: "error" };
    }
    const { data: sweepData, error: sweepErr } = await db.rpc("memory_sweep_expired", { p_enforce_flag: true });
    if (sweepErr) {
      logger.warn({ err: sweepErr }, "memory projection: memory_sweep_expired failed");
      return { ...empty, reason: "error" };
    }
    const projected = typeof projData === "number" ? projData : 0;
    const swept = typeof sweepData === "number" ? sweepData : 0;
    if (projected > 0 || swept > 0) {
      logger.info({ projected, swept }, "memory projection pass complete");
    }
    return { skipped: false, reason: null, projected, swept };
  } catch (err) {
    logger.warn({ err }, "memory projection pass threw");
    return { ...empty, reason: "error" };
  }
}

export function startMemoryProjectionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: MEMORY_FLAG },
    "MemoryProjectionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runMemoryProjectionPass()
      .catch((err) => logger.warn({ err }, "memory projection pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopMemoryProjectionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
