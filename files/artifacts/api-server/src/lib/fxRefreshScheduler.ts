/**
 * FX daily refresh scheduler.
 *
 * ECB reference rates change at most once per business day, so a daily pull is
 * plenty. Env-gated (FX_REFRESH_ENABLED=true) following the house worker
 * pattern (cf. STAMP_WORKER_ENABLED). Runs once shortly after boot (if the
 * table looks stale) and then on a fixed interval. Best-effort: a failed fetch
 * logs and is retried on the next tick; it never crashes the server.
 */

import type { Logger } from "pino";
import { refreshFxRates, loadFxTable } from "./fx.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let started = false;

/** True when the newest fx rate_date is older than ~1 day (or absent). */
async function isStale(sc: any): Promise<boolean> {
  try {
    const table = await loadFxTable(sc);
    if (!table.rateDate) return true;
    const age = Date.now() - Date.parse(`${table.rateDate}T00:00:00Z`);
    return !Number.isFinite(age) || age > DAY_MS;
  } catch {
    return true;
  }
}

/**
 * Start the FX refresh loop. `getSc` returns the service client (may be null).
 * Interval overridable via FX_REFRESH_INTERVAL_MS (default 24h).
 */
export function startFxRefreshLoop(getSc: () => any, logger?: Logger): void {
  if (started) return;
  started = true;
  const intervalMs = Number(process.env.FX_REFRESH_INTERVAL_MS) || DAY_MS;

  const tick = async (reason: string) => {
    const sc = getSc();
    if (!sc) return;
    const result = await refreshFxRates(sc);
    const log = logger ?? (console as unknown as Logger);
    if (result.ok) {
      log.info?.({ event: "fx.refresh.ok", reason, rate_date: result.rateDate, upserted: result.upserted }, "fx rates refreshed");
    } else {
      log.warn?.({ event: "fx.refresh.failed", reason, why: result.reason }, "fx refresh failed (will retry next tick)");
    }
  };

  // Kick once shortly after boot, only if the table is stale (avoids a needless
  // fetch on every deploy when rates are already current).
  setTimeout(() => {
    void (async () => {
      const sc = getSc();
      if (sc && (await isStale(sc))) await tick("startup_stale");
    })();
  }, 10_000);

  setInterval(() => { void tick("interval"); }, intervalMs);
}

/** Test hook to reset the singleton guard. */
export function _resetFxSchedulerForTest(): void {
  started = false;
}
