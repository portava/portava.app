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

/**
 * CONSECUTIVE FAILED SWEEPS.
 *
 * There was no such counter, and until listOpenSessions began observing its
 * `.error` there was nothing for one to count: an unreadable `call_sessions`
 * resolved to an empty list, so a tick that swept NOTHING BECAUSE IT COULD NOT
 * READ ANYTHING was byte-for-byte the same observation as a tick with nothing
 * to sweep — `{ missed: 0, capped: 0, ghosted: 0 }`, logged by neither. The
 * failure shapes most likely to be SUSTAINED (a renamed column, an RLS or grant
 * change) are exactly the ones that would have gone unnoticed indefinitely
 * while overdue rings never became `missed` and no call ever hit the 4h cap.
 *
 * The counter resets ONLY on a tick that actually completed a sweep. A tick
 * that threw, and a tick that could not get a client at all, both COUNT — a
 * pass in which everything failed is not a pass.
 */
let _consecutiveFailures = 0;

/** Consecutive failed sweeps, and the last failure — for tests and health. */
export function callSweepFailureState(): { consecutiveFailures: number; lastError: string | null } {
  return { consecutiveFailures: _consecutiveFailures, lastError: _lastError };
}
let _lastError: string | null = null;

/** Test seam: forget the failure history (does not touch the timer). */
export function _resetCallSweepFailureState(): void {
  _consecutiveFailures = 0;
  _lastError = null;
}

/** Escalate once the failure looks sustained rather than transient. */
const SUSTAINED_FAILURE_TICKS = 3;

/**
 * Run one tick and keep the failure ledger. Separated from the timer so a test
 * can drive a tick without a scheduler; `sweep` is the injectable seam this
 * module's header has always promised, and is the only way to reach the
 * "no client" branch below in a test (getServiceClient() answers from the
 * environment, so a null client cannot be forced through `opts`).
 */
export async function runCallSweepTick(
  opts: Parameters<typeof runCallSweep>[0] = {},
  sweep: typeof runCallSweep = runCallSweep,
): Promise<
  { ok: true; result: { missed: number; capped: number; ghosted: number } | null } | { ok: false; error: unknown }
> {
  try {
    const result = await sweep(opts);
    if (result === null) {
      // No service client: the sweep did not run. Reporting this as a clean
      // pass is the same lie the unreadable-table case used to tell.
      recordFailure("no supabase client available for call sweep");
      return { ok: false, error: new Error("no supabase client available for call sweep") };
    }
    _consecutiveFailures = 0;
    _lastError = null;
    return { ok: true, result };
  } catch (err) {
    recordFailure(String((err as any)?.message ?? err));
    return { ok: false, error: err };
  }
}

function recordFailure(message: string): void {
  _consecutiveFailures += 1;
  _lastError = message;
  const payload = { consecutiveFailures: _consecutiveFailures, err: message };
  if (_consecutiveFailures >= SUSTAINED_FAILURE_TICKS) {
    logger.error(payload, "call sweep has failed on consecutive ticks — ring timeouts and the 4h cap are not being applied");
  } else {
    logger.warn(payload, "call sweep failed");
  }
}

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
    // runCallSweepTick never rejects — it records the failure instead — so the
    // reschedule below is unconditional by construction rather than by a
    // `.catch()` that a resolved PostgREST error would have walked straight past.
    void runCallSweepTick().finally(() => {
      _timer = setTimeout(tick, CALL_CONFIG.SWEEP_INTERVAL_MS);
    });
  }, CALL_CONFIG.SWEEP_STARTUP_DELAY_MS);
}

export function stopCallSweepScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
