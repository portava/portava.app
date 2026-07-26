/**
 * RankingFatigueSweeper — periodic cleanup of stale viewer_creator_fatigue rows.
 *
 * Deletes rows where last_impression_at < now() - 30 days so the fatigue
 * table doesn't grow unbounded.  Runs every 6 hours with a 5-minute startup
 * delay.  Non-fatal: any sweep error is logged and ignored.
 */

import { getServiceClient } from "./supabase";
import { logger } from "./logger";

const SWEEP_STARTUP_DELAY_MS = 5 * 60 * 1_000;       // 5 minutes
const SWEEP_INTERVAL_MS      = 6 * 60 * 60 * 1_000;  // 6 hours
const RETENTION_DAYS         = 30;

let _timer: ReturnType<typeof setTimeout> | null = null;

export async function runFatigueSweep(opts: { client?: any } = {}): Promise<number> {
  const sc = opts.client ?? getServiceClient();
  if (!sc) return 0;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();

  const { error, count } = await sc
    .from("viewer_creator_fatigue")
    .delete({ count: "exact" })
    .lt("last_impression_at", cutoff);

  if (error) {
    logger.warn({ err: error }, "rankingFatigueSweeper: delete failed");
    return 0;
  }
  const deleted = count ?? 0;
  if (deleted > 0) {
    logger.info({ deleted, cutoff }, "rankingFatigueSweeper: stale fatigue rows deleted");
  }
  return deleted;
}

export function startRankingFatigueSweeper(): void {
  if (_timer !== null) return; // idempotent
  logger.info(
    { startupDelayMs: SWEEP_STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS },
    "RankingFatigueSweeper scheduled",
  );
  _timer = setTimeout(function tick() {
    void runFatigueSweep()
      .catch((err) => logger.warn({ err }, "rankingFatigueSweeper: sweep failed"))
      .finally(() => {
        _timer = setTimeout(tick, SWEEP_INTERVAL_MS);
      });
  }, SWEEP_STARTUP_DELAY_MS);
}

export function stopRankingFatigueSweeper(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
