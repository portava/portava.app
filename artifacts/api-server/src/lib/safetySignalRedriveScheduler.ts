/**
 * The durable re-drive of a conversation's help request (Telegraph §19 P0) —
 * Fable pass 3 §1.1's one CHANGE: an unreadable roster or blocks read must not
 * lose the help request. The rules — what one attempt reads, who it tells,
 * when it must not tell — are the producer's own and live beside it
 * (services/telegraph/safetyNotifications.ts, "THE DURABLE RE-DRIVE"). This
 * file is only the loop: which messages are due, and when to stop.
 *
 * WHAT A PASS DOES. Reads the §6.2 SAFETY rows (need_help / heads_up /
 * all_clear) and §9.1 NEED_HELP rows written in the last
 * SAFETY_REDRIVE_WINDOW_MS (15 minutes) and at least the first schedule point
 * (10 s) ago, oldest first, paged. For each one:
 *   - settled in this process (its door told everyone, or an attempt settled
 *     it) or a door still telling it: skipped — no read at all;
 *   - otherwise, when its age has passed a schedule point it has not been
 *     attempted for, ONE attempt (redriveSafetySignal), however many points
 *     were missed;
 *   - an attempt that cannot finish is re-attempted at the next point; the
 *     15-minute attempt is the last, and its failure is an ERROR naming the
 *     message ("GAVE UP").
 * The work is derived from public.messages + public.notifications on every
 * pass, so a restart, a scale-in or a second instance loses nothing but the
 * in-process memo: the first pass after it makes one catch-up attempt for
 * each message still inside the window.
 *
 * UNGATED, like the producer it re-drives (the door's own SOS is ungated): a
 * flag would need a seeding migration, and an OFF re-drive is exactly the
 * defect. When no help request is in the window a pass is ONE read.
 *
 * THE HOUSE SHAPE (memoryDeletionRedriveScheduler / telegraphOutboxDrain): a
 * startup delay, then a self-rescheduling setTimeout that re-arms only while
 * its own loop is current (generation counter, PR #652), unref()'d; reported
 * at GET /healthz/schedulers as `safetySignalRedrive` and persisted to
 * public.job_health (every failing pass and the first success after one; at
 * most once a minute while healthy), so its stopping is visible
 * (lib/schedulerCoverage.ts).
 */
import { getServiceClient } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import {
  SAFETY_REDRIVE_SCHEDULE_MS,
  SAFETY_REDRIVE_SUBTYPES,
  SAFETY_REDRIVE_WINDOW_MS,
  pruneSafetyRedriveMemo,
  redriveEntry,
  redriveSafetySignal,
  type SafetyNotifyDeps,
  type SafetyNotifyLog,
} from "../services/telegraph/safetyNotifications.js";

const logger = rootLogger.child({ job: "SafetySignalRedrive" });

export const SAFETY_REDRIVE_JOB_KEY = "safetySignalRedrive";
/** Half the first schedule point, so the 10 s attempt is never more than 5 s late. */
export const SAFETY_REDRIVE_INTERVAL_MS = 5_000;
/** A page of the window scan; SAFETY_REDRIVE_MAX_PAGES pages at most per pass (the rest wait one tick, and the pass says so). */
export const SAFETY_REDRIVE_PAGE = 200;
export const SAFETY_REDRIVE_MAX_PAGES = 5;
/** Two ticks of slack past the window, so the 15-minute point is still seen by a pass that runs a little late. */
const WINDOW_GRACE_MS = 2 * SAFETY_REDRIVE_INTERVAL_MS;
/** Short: after a restart the catch-up attempt should not wait minutes. */
const STARTUP_DELAY_MS = 15_000;
const HEALTH_PERSIST_EVERY_MS = 60_000;

/** The last schedule point a message of this age has passed (-1: none yet). */
export function dueIndexFor(ageMs: number): number {
  let due = -1;
  for (let i = 0; i < SAFETY_REDRIVE_SCHEDULE_MS.length; i++) if (ageMs >= SAFETY_REDRIVE_SCHEDULE_MS[i]!) due = i;
  return due;
}

export interface SafetyRedrivePassResult {
  outcome: "ran" | "no_client" | "error";
  /** Rows the window scan returned. */
  considered: number;
  /** Attempts made this pass. */
  attempted: number;
  /** Attempts that settled the message (told everyone eligible, or it must not go). */
  settled: number;
  /** Members told by this pass. */
  told: number;
  /** Attempts that could not finish and have a later point left. */
  retrying: number;
  /** Attempts at the LAST point that could not finish: the re-drive gave up on these (ERROR). */
  gaveUp: number;
  /** Skipped: a door in this process is still telling the message. */
  inFlight: number;
  /** The scan hit SAFETY_REDRIVE_MAX_PAGES; later rows wait for the next pass. */
  truncated: boolean;
}

const emptyResult = (outcome: SafetyRedrivePassResult["outcome"]): SafetyRedrivePassResult =>
  ({ outcome, considered: 0, attempted: 0, settled: 0, told: 0, retrying: 0, gaveUp: 0, inFlight: 0, truncated: false });

/** One pass. Never throws. `client: null` = no service client. */
export async function runSafetySignalRedrivePass(
  opts: { client?: any; nowMs?: number; deps?: SafetyNotifyDeps; log?: SafetyNotifyLog } = {},
): Promise<SafetyRedrivePassResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return emptyResult("no_client");
  const nowMs = opts.nowMs ?? Date.now();
  const log: SafetyNotifyLog = opts.log ?? logger;
  const result = emptyResult("ran");
  try {
    // The window is the re-drive's DEADLINE, not a span consumed once: every row inside it is re-read on every
    // pass, so a gap shorter than the window loses nothing (scripts/checkSchedulerRelativeWindows.ts ALLOWLIST).
    const since = new Date(nowMs - SAFETY_REDRIVE_WINDOW_MS - WINDOW_GRACE_MS).toISOString();
    const until = new Date(nowMs - SAFETY_REDRIVE_SCHEDULE_MS[0]!).toISOString();
    const due: Array<{ id: string; createdMs: number }> = [];
    for (let page = 0; ; page++) {
      if (page >= SAFETY_REDRIVE_MAX_PAGES) { result.truncated = true; break; }
      const { data, error } = await db
        .from("messages")
        .select("id, created_at")
        .in("msg_type", ["safety", "coordination"])
        .in("subtype", [...SAFETY_REDRIVE_SUBTYPES])
        .is("deleted_at", null)
        .gte("created_at", since)
        .lte("created_at", until)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(page * SAFETY_REDRIVE_PAGE, page * SAFETY_REDRIVE_PAGE + SAFETY_REDRIVE_PAGE - 1);
      if (error || !Array.isArray(data)) {
        logger.error({ err: error ?? "not a row list" }, "safety re-drive: the window scan FAILED — no help request is being re-attempted this pass");
        return { ...result, outcome: "error" };
      }
      for (const r of data as Array<{ id?: unknown; created_at?: unknown }>) {
        const createdMs = typeof r?.created_at === "string" ? Date.parse(r.created_at) : Number.NaN;
        if (typeof r?.id === "string" && r.id.length > 0 && Number.isFinite(createdMs)) due.push({ id: r.id, createdMs });
      }
      if (data.length < SAFETY_REDRIVE_PAGE) break;
    }
    result.considered = due.length;

    for (const { id, createdMs } of due) {
      const entry = redriveEntry(id, createdMs);
      if (entry.settled) continue;
      if (entry.inFlight > 0) { result.inFlight += 1; continue; }
      const point = dueIndexFor(nowMs - createdMs);
      if (point < entry.next) continue; // not due: back-off
      result.attempted += 1;
      entry.inFlight += 1;
      let outcome: Awaited<ReturnType<typeof redriveSafetySignal>>;
      try {
        outcome = await redriveSafetySignal(db, id, { ...(opts.deps ? { deps: opts.deps } : {}), log });
      } finally {
        entry.inFlight -= 1;
      }
      result.told += outcome.notified.length;
      if (outcome.status === "settled") {
        entry.settled = true;
        result.settled += 1;
        if (outcome.notified.length > 0) {
          log.warn({ messageId: id, threadId: outcome.threadId, signal: outcome.signal, told: outcome.notified.length, attempt: point + 1 }, "SAFETY re-drive delivered a help-request notification the door could not");
        } else if (outcome.reason !== "complete") {
          log.warn({ messageId: id, threadId: outcome.threadId, signal: outcome.signal, reason: outcome.reason }, "SAFETY re-drive stopped: it must not be sent late");
        }
        continue;
      }
      entry.next = point + 1;
      if (entry.next >= SAFETY_REDRIVE_SCHEDULE_MS.length) {
        entry.settled = true;
        result.gaveUp += 1;
        const error = (log as { error?: SafetyNotifyLog["error"] }).error;
        const obj = { messageId: id, threadId: outcome.threadId, signal: outcome.signal, stage: outcome.stage, attempts: SAFETY_REDRIVE_SCHEDULE_MS.length, told: outcome.notified.length };
        const msg = "SAFETY re-drive GAVE UP: 15 minutes of attempts could not tell every member about this help request — those not told were never notified (the message is in the thread)";
        if (typeof error === "function") error.call(log, obj, msg); else log.warn(obj, msg);
      } else {
        result.retrying += 1;
        log.warn({ messageId: id, threadId: outcome.threadId, signal: outcome.signal, stage: outcome.stage, attempt: point + 1, nextInMs: SAFETY_REDRIVE_SCHEDULE_MS[entry.next]! - (nowMs - createdMs) }, "SAFETY re-drive attempt could not finish — re-attempted at the next point");
      }
    }
    pruneSafetyRedriveMemo(nowMs - SAFETY_REDRIVE_WINDOW_MS - 4 * WINDOW_GRACE_MS);
    if (result.truncated) logger.warn({ ...result }, "safety re-drive: more help requests in the window than one pass reads — the rest wait for the next pass");
    return result;
  } catch (err) {
    logger.error({ err }, "safety re-drive pass threw — no help request is being re-attempted this pass");
    return { ...result, outcome: "error" };
  }
}

// ── health (GET /healthz/schedulers job "safetySignalRedrive", public.job_health) ──

export interface SafetySignalRedriveStatus {
  /** A tick began. Never evidence that it worked. */
  lastAttemptAt: string | null;
  /** A tick whose scan ran (gave-ups are reported, not failures: the job did its job; the database did not). */
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastResult: SafetyRedrivePassResult | null;
  /** Since this process started. */
  gaveUpTotal: number;
  lastGaveUpAt: string | null;
}

const _status: SafetySignalRedriveStatus = { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null, gaveUpTotal: 0, lastGaveUpAt: null };
let _lastPersistMs = 0;

export function getSafetySignalRedriveStatus(): Readonly<SafetySignalRedriveStatus> {
  return { ..._status, lastResult: _status.lastResult ? { ..._status.lastResult } : null };
}

/** Test seam. */
export function _resetSafetySignalRedriveStatus(): void {
  Object.assign(_status, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null, gaveUpTotal: 0, lastGaveUpAt: null });
  _lastPersistMs = 0;
}

/** The health detail line. */
export function safetySignalRedriveHealthDetail(s: Readonly<SafetySignalRedriveStatus>): string | undefined {
  const r = s.lastResult;
  if (!r) return undefined;
  const parts = [r.outcome === "ran"
    ? `last pass: ${r.considered} help request(s) in the 15-minute window, ${r.attempted} attempted, ${r.settled} settled, ${r.told} member(s) told, ${r.retrying} retrying, ${r.gaveUp} given up${r.truncated ? ", window truncated" : ""}`
    : `last pass: ${r.outcome === "no_client" ? "no service client" : "the window scan failed"} — nothing was re-attempted`];
  if (s.gaveUpTotal > 0) parts.push(`${s.gaveUpTotal} help request(s) given up on since start, last at ${s.lastGaveUpAt}`);
  return parts.join(" | ");
}

/** One tick: the pass, its status and (throttled while healthy) the job_health row. Never throws. */
export async function runSafetySignalRedriveTick(
  opts: { client?: any; nowMs?: number; deps?: SafetyNotifyDeps; log?: SafetyNotifyLog } = {},
): Promise<SafetyRedrivePassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const result = await runSafetySignalRedrivePass({ ...opts, nowMs });
  _status.lastAttemptAt = at;
  _status.lastResult = result;
  const succeeded = result.outcome === "ran";
  const recovered = succeeded && _status.consecutiveFailures > 0;
  if (succeeded) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = at;
  } else {
    _status.consecutiveFailures += 1;
  }
  if (result.gaveUp > 0) { _status.gaveUpTotal += result.gaveUp; _status.lastGaveUpAt = at; }
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (db && (!succeeded || recovered || nowMs - _lastPersistMs >= HEALTH_PERSIST_EVERY_MS)) {
    _lastPersistMs = nowMs;
    try {
      const row: Record<string, unknown> = { job: SAFETY_REDRIVE_JOB_KEY, last_run_at: at };
      if (succeeded) row["last_success_at"] = at;
      const { error } = await db.from("job_health").upsert(row, { onConflict: "job" });
      if (error) logger.warn({ job: SAFETY_REDRIVE_JOB_KEY, err: error }, "safety re-drive: could not persist job health");
    } catch (err) {
      logger.warn({ job: SAFETY_REDRIVE_JOB_KEY, err }, "safety re-drive: could not persist job health");
    }
  }
  return result;
}

let _timer: ReturnType<typeof setTimeout> | null = null;
let _generation = 0;

export function startSafetySignalRedriveScheduler(timing: { startupDelayMs?: number; intervalMs?: number } = {}): void {
  if (_timer !== null) return;
  const startupDelayMs = timing.startupDelayMs ?? STARTUP_DELAY_MS;
  const intervalMs = timing.intervalMs ?? SAFETY_REDRIVE_INTERVAL_MS;
  logger.info({ startupDelayMs, intervalMs, scheduleMs: SAFETY_REDRIVE_SCHEDULE_MS }, "SafetySignalRedrive scheduled (ungated: re-attempts help requests the door could not tell, for 15 minutes)");
  const generation = ++_generation;
  _timer = setTimeout(function tick() {
    void runSafetySignalRedriveTick()
      .catch((err) => logger.error({ err }, "safety re-drive tick failed"))
      .finally(() => { if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, intervalMs); _timer.unref?.(); } });
  }, startupDelayMs);
  _timer.unref?.();
}

export function stopSafetySignalRedriveScheduler(): void {
  _generation += 1;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
