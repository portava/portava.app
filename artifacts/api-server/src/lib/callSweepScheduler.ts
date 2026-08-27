/**
 * Call sweep scheduler — periodic sweepOpenSessions() runs.
 *
 * Follows the start*Scheduler pattern (see eventWaitlistSweeper): a setTimeout
 * loop with a startup delay, a test-injectable runSweep, and idempotent
 * start/stop. Cadence lives in CALL_CONFIG (never a scattered constant).
 *
 * The sweep expires overdue rings into `missed`, force-ends calls at the
 * 4-hour cap (with server-side room termination), and heals ghost sessions.
 */
import { getServiceClient } from "./supabase";
import { logger } from "./logger";
import { CALL_CONFIG } from "./calls/callTypes";
import { sweepOpenSessions, type RoomAdminPort } from "./calls/callReconciler";
import { makeCallStore } from "./calls/callStoreAdapter";
import { livekitEnvStatus, makeRoomAdmin, readLivekitEnv } from "./calls/livekitService";
import { emitCallAnalytics } from "./calls/callSignaling";

let _timer: ReturnType<typeof setTimeout> | null = null;

export async function runCallSweep(opts: {
  client?: any;
  admin?: RoomAdminPort;
  nowMs?: number;
} = {}): Promise<{ missed: number; capped: number; ghosted: number } | null> {
  const client = opts.client ?? getServiceClient();
  if (!client) return null;
  let admin = opts.admin;
  if (!admin) {
    if (!livekitEnvStatus().ok) {
      // No LiveKit room control available — but the DB-side transitions the sweep
      // exists to apply (RING_TIMEOUT -> missed, MAX_DURATION -> capped) do NOT
      // need it; only the best-effort endRoom and the OPTIONAL ghost-healing
      // probes do. Bailing out entirely was fail-OPEN: overdue rings never flipped
      // to 'missed' and calls never hit the 4h cap. Use a no-op admin so the DB
      // transitions still run; the absent roomExists/listRoomNames just make the
      // sweep skip ghost healing (its documented fail-closed default).
      admin = { endRoom: async () => {} };
    } else {
      admin = makeRoomAdmin(readLivekitEnv());
    }
  }
  const store = makeCallStore(client);
  const nowMs = opts.nowMs ?? Date.now();

  // Track missed sessions for analytics before the sweep flips them.
  const open = await store.listOpenSessions();
  const result = await sweepOpenSessions(store, admin, nowMs);
  if (result.missed > 0 || result.capped > 0 || result.ghosted > 0) {
    logger.info(result, "call sweep applied transitions");
    for (const s of open) {
      const fresh = await store.getSession(s.id);
      if (fresh?.status === "missed") emitCallAnalytics("missed", fresh);
    }
  }
  return result;
}

export function startCallSweepScheduler(): void {
  if (_timer !== null) return; // already started
  logger.info(
    { startupDelayMs: CALL_CONFIG.SWEEP_STARTUP_DELAY_MS, intervalMs: CALL_CONFIG.SWEEP_INTERVAL_MS },
    "CallSweepScheduler scheduled",
  );
  _timer = setTimeout(function tick() {
    void runCallSweep()
      .catch((err) => logger.warn({ err }, "call sweep failed"))
      .finally(() => {
        _timer = setTimeout(tick, CALL_CONFIG.SWEEP_INTERVAL_MS);
      });
  }, CALL_CONFIG.SWEEP_STARTUP_DELAY_MS);
}

export function stopCallSweepScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
