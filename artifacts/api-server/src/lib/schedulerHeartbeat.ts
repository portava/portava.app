/**
 * schedulerHeartbeat — one durable answer to "were the background jobs running?"
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Every scheduler `index.ts` starts is a timer inside this process, and
 * `.replit` deploys the process to Replit Autoscale, which stops a container
 * after about fifteen idle minutes. A stopped container runs no timer. On
 * 2026-09-30 15:28 every scheduler stopped together and nothing said so for
 * fifty-four hours (lib/schedulerCoverage.ts). The failure that matters is not
 * one job breaking: it is ALL of them stopping at once because the process is
 * not running, and no in-process counter can report that, because the counter
 * stops with the process.
 *
 * `lib/schedulerCoverage.ts` counts the schedulers whose stopping leaves no
 * trace. Making each of them observable is a change to each of them. This file
 * covers the shared failure for all of them at once: while any instance of this
 * process is running its timers, it upserts one `public.job_health` row every
 * minute. The row survives the process. So:
 *
 *   - At boot, the new process reads the row before writing it, and the
 *     distance between the previous beat and now IS the time no scheduler ran
 *     anywhere. That stop is logged and reported by GET /api/healthz/schedulers
 *     (and, on an always-on host, sent to Sentry when SENTRY_DSN is set; see
 *     below).
 *   - While running, a beat that arrives long after the one before it means the
 *     event loop itself was frozen (a suspended container that was resumed
 *     rather than replaced). Same report.
 *
 * Several Autoscale instances write the same row, which is correct: the
 * question is whether ANY instance was running the timers, not which one.
 *
 * ── WHAT THE HEALTH ENTRY SAYS (job "schedulerHeartbeat") ────────────────────
 *   failing    the last beat could not be written. Every other job_health
 *              writer is likely failing too.
 *   stale      this process has not beaten for three intervals; or, on a host
 *              declared always-on, a stop longer than GAP_ALERT_MS ended less
 *              than GAP_REPORT_WINDOW_MS ago. That second case is "recovered",
 *              and it is still 503 on purpose: the probe that wakes the host is
 *              the first thing that can learn the jobs were stopped.
 *   never_ran  this process has not completed its first beat (or never started
 *              the heartbeat, as in tests).
 *   healthy    beating. A stop, if any, is in the detail.
 *
 * ── A STOP IS AN INCIDENT ONLY ON AN ALWAYS-ON HOST ──────────────────────────
 * Owner call, 2026-11-04: production stays on Autoscale for now, with no new
 * hosting spend. On Autoscale a stop after every quiet spell is the expected
 * behaviour of the host, not an incident, and a probe or a Sentry issue that
 * fires on every wake is one that gets muted, taking the real failures with it.
 * So by default a stop is DISCLOSED: logged at warn, named in the detail, and
 * the entry stays healthy. Set PORTAVA_ALWAYS_ON=true on a host that should
 * never stop (a Reserved VM) and the same stop is logged at error, sent to
 * Sentry, and answers 503 for its report window.
 *
 * WHAT IT IS NOT. It proves the timers in this process can fire. It does not
 * prove any single scheduler's loop is still armed, and it does not make a
 * sleeping host run anything: that needs an always-on host or an external
 * request, which is a hosting decision (docs/ops/scheduler-hosting.md).
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";
import { Sentry } from "./sentry.js";

/** The `public.job_health` key this file owns. */
export const JOB_KEY = "scheduler_heartbeat";

/** One beat a minute: 1,440 single-row upserts a day per instance. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Three missed beats before this process reads as stale. */
export const HEARTBEAT_STALE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * A stop longer than this is recorded (and is an incident on an always-on
 * host; see the header). Ten minutes stays clear of an
 * ordinary restart (a publish keeps the old instance serving until the new one
 * is promoted) while catching an Autoscale sleep, which starts at fifteen idle
 * minutes.
 */
export const GAP_ALERT_MS = 10 * 60_000;

/** On an always-on host, how long after a stop ends the endpoint keeps answering 503 for it. */
export const GAP_REPORT_WINDOW_MS = 30 * 60_000;

/** How long GET /healthz/schedulers waits for the boot read before answering anyway. */
export const READY_TIMEOUT_MS = 3_000;

export interface SchedulerGap {
  /** The last beat before the stop. */
  from: string;
  /** When beating resumed (process boot, or the late beat). */
  to: string;
  ms: number;
  /** "restart": a new process found an old row. "frozen": this process's own timer fired late. */
  kind: "restart" | "frozen";
}

export interface SchedulerHeartbeatStatus {
  started: boolean;
  bootAt: string | null;
  /** True once the boot read has finished, whatever it found. */
  hydrated: boolean;
  /** The newest beat any earlier process wrote, as read at boot. */
  previousBeatAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastFailure: string | null;
  /** The most recent stop longer than GAP_ALERT_MS, if any. */
  lastGap: SchedulerGap | null;
}

function emptyStatus(): SchedulerHeartbeatStatus {
  return {
    started: false, bootAt: null, hydrated: false, previousBeatAt: null,
    lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailure: null, lastGap: null,
  };
}

const _status: SchedulerHeartbeatStatus = emptyStatus();

export function getSchedulerHeartbeatStatus(): Readonly<SchedulerHeartbeatStatus> {
  return { ..._status, lastGap: _status.lastGap ? { ..._status.lastGap } : null };
}

let _timer: ReturnType<typeof setInterval> | null = null;
let _ready: Promise<void> | null = null;
let _client: any = undefined;

/**
 * True when the deployment declares an always-on host (PORTAVA_ALWAYS_ON), so
 * that a stop of the schedulers is an incident. Read on every call so a test,
 * or an operator, changes it without a restart of this module.
 */
export function stopsAreIncidents(): boolean {
  const v = (process.env["PORTAVA_ALWAYS_ON"] ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Test seam: stop the timer and forget everything. */
export function _resetSchedulerHeartbeat(): void {
  stopSchedulerHeartbeat();
  Object.assign(_status, emptyStatus());
  _ready = null;
  _client = undefined;
}

function resolveClient(db?: any): any | null {
  if (db !== undefined) return db;
  return isServiceClientReady ? getServiceClient() : null;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function recordGap(gap: SchedulerGap): void {
  _status.lastGap = gap;
  const payload = { job: JOB_KEY, from: gap.from, to: gap.to, minutes: minutes(gap.ms), kind: gap.kind };
  const what = gap.kind === "restart"
    ? "no instance ran the background schedulers"
    : "this process's timers did not fire (the container was suspended and resumed)";
  const line = `schedulerHeartbeat: ${what} for ${minutes(gap.ms)} minute(s), ${gap.from} to ${gap.to}`;
  if (!stopsAreIncidents()) {
    // The host sleeps when idle by decision; see the header.
    logger.warn({ ...payload, alwaysOn: false }, line);
    return;
  }
  logger.error({ ...payload, alwaysOn: true }, line);
  try {
    Sentry.captureMessage(`Background schedulers were stopped for ${minutes(gap.ms)} minute(s)`, {
      level: "error",
      tags: { job: JOB_KEY, kind: gap.kind },
      extra: payload,
    });
  } catch {
    // Reporting is best-effort; the log line above and the health entry stand.
  }
}

/**
 * The boot read: find the previous beat and measure the stop. Never throws.
 * An unreadable row leaves `previousBeatAt` null, which reports no gap rather
 * than an invented one; the write that follows will say whether the table is
 * reachable at all.
 */
export async function hydrateSchedulerHeartbeat(db?: any, now: Date = new Date()): Promise<void> {
  const client = resolveClient(db);
  try {
    if (!client) return;
    const { data, error } = await client
      .from("job_health")
      .select("last_run_at, last_success_at")
      .eq("job", JOB_KEY)
      .maybeSingle();
    if (error) {
      logger.warn({ job: JOB_KEY, err: error }, "schedulerHeartbeat: could not read the previous beat");
      return;
    }
    const prev = ((data as any)?.last_success_at ?? (data as any)?.last_run_at ?? null) as string | null;
    _status.previousBeatAt = prev;
    const at = prev ? Date.parse(prev) : Number.NaN;
    if (Number.isFinite(at)) {
      const ms = now.getTime() - at;
      if (ms > GAP_ALERT_MS) recordGap({ from: prev!, to: now.toISOString(), ms, kind: "restart" });
    }
  } catch (err) {
    logger.warn({ job: JOB_KEY, err }, "schedulerHeartbeat: could not read the previous beat");
  } finally {
    _status.hydrated = true;
  }
}

/** One beat: measure the distance from the last tick, then write the row. Never throws. */
export async function runSchedulerHeartbeat(db?: any, now: Date = new Date()): Promise<Readonly<SchedulerHeartbeatStatus>> {
  const at = now.toISOString();
  const previousTick = _status.lastAttemptAt ? Date.parse(_status.lastAttemptAt) : Number.NaN;
  // The previous ATTEMPT, not the previous success: a database outage stops
  // successes while the loop keeps ticking, and that is reported as `failing`,
  // never as a frozen event loop.
  if (Number.isFinite(previousTick) && now.getTime() - previousTick > GAP_ALERT_MS) {
    recordGap({ from: _status.lastAttemptAt!, to: at, ms: now.getTime() - previousTick, kind: "frozen" });
  }
  _status.lastAttemptAt = at;

  const client = resolveClient(db);
  let failure: string | null = null;
  if (!client) {
    failure = "no service client";
  } else {
    try {
      // supabase-js RESOLVES with `error` on a database failure, so it is read,
      // not caught.
      const { error } = await client
        .from("job_health")
        .upsert({ job: JOB_KEY, last_run_at: at, last_success_at: at }, { onConflict: "job" });
      if (error) failure = `job_health upsert: ${error?.code ?? "?"} ${error?.message ?? String(error)}`;
    } catch (err) {
      failure = `job_health upsert threw: ${(err as any)?.message ?? String(err)}`;
    }
  }

  if (failure) {
    _status.consecutiveFailures += 1;
    _status.lastFailure = failure;
    const log = _status.consecutiveFailures >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ job: JOB_KEY, failure, consecutiveFailures: _status.consecutiveFailures }, "schedulerHeartbeat: could not write the beat");
  } else {
    _status.consecutiveFailures = 0;
    _status.lastFailure = null;
    _status.lastSuccessAt = at;
  }
  return getSchedulerHeartbeatStatus();
}

/**
 * Start the heartbeat: the boot read, the first beat at once, then one a
 * minute. Idempotent. The timer is unref'd like every other scheduler: the
 * server keeps the process alive, not a background loop.
 */
export function startSchedulerHeartbeat(opts: { client?: any; intervalMs?: number } = {}): void {
  if (_status.started) return;
  _status.started = true;
  _status.bootAt = new Date().toISOString();
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  _client = opts.client;
  _ready = (async () => {
    await hydrateSchedulerHeartbeat(opts.client);
    await runSchedulerHeartbeat(opts.client);
  })();
  _timer = setInterval(() => { void runSchedulerHeartbeat(opts.client); }, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
  logger.info({ job: JOB_KEY, intervalMs }, "schedulerHeartbeat: started");
}

export function stopSchedulerHeartbeat(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Resolves once the boot read and first beat are done, or after `timeoutMs`,
 * or at once when the heartbeat was never started. GET /healthz/schedulers
 * waits on this because the request that wakes a sleeping container is the one
 * that most needs the measured stop, and it arrives before the boot read ends.
 *
 * It also beats once itself when the timer is armed but overdue. That only
 * happens when the process was suspended and has just resumed: Node can run
 * the waking request before the overdue timer, and without this beat the
 * report would read "timers are not firing" for a loop that is about to fire.
 * The beat records the suspension as a "frozen" stop, so nothing is hidden. A
 * timer that was stopped is not armed, so it is never covered for.
 */
export async function schedulerHeartbeatReady(timeoutMs: number = READY_TIMEOUT_MS): Promise<void> {
  if (!_ready) return;
  const ready = _ready;
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      (async () => {
        await ready;
        const last = _status.lastAttemptAt ? Date.parse(_status.lastAttemptAt) : Number.NaN;
        if (_timer && Number.isFinite(last) && Date.now() - last > HEARTBEAT_STALE_AFTER_MS) {
          await runSchedulerHeartbeat(_client);
        }
      })(),
      new Promise<void>((r) => { t = setTimeout(r, timeoutMs); }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export type SchedulerHeartbeatHealth = "healthy" | "failing" | "stale" | "never_ran";

export interface SchedulerHeartbeatReport {
  status: SchedulerHeartbeatHealth;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  detail?: string;
}

function describeGap(g: SchedulerGap): string {
  const how = g.kind === "restart" ? "no instance was running" : "this process was suspended";
  return `background jobs were stopped for ${minutes(g.ms)} min (${how}), ${g.from} to ${g.to}`;
}

/** The `/healthz/schedulers` entry. Pure: reads the status and the clock. */
export function schedulerHeartbeatReport(now: number = Date.now()): SchedulerHeartbeatReport {
  const s = _status;
  const base = { lastRunAt: s.lastAttemptAt, lastSuccessAt: s.lastSuccessAt, consecutiveFailures: s.consecutiveFailures };
  const gapNote = s.lastGap ? describeGap(s.lastGap) : null;

  if (s.consecutiveFailures > 0) {
    return { ...base, status: "failing", detail: [`could not write the beat: ${s.lastFailure ?? "unknown"}`, gapNote].filter(Boolean).join(" | ") };
  }
  if (!s.started) {
    return { ...base, status: "never_ran", detail: "the heartbeat is not started in this process" };
  }
  const own = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : Number.NaN;
  if (Number.isFinite(own) && now - own > HEARTBEAT_STALE_AFTER_MS) {
    return { ...base, status: "stale", detail: [`no beat from this process since ${s.lastSuccessAt}: its timers are not firing`, gapNote].filter(Boolean).join(" | ") };
  }
  if (s.lastGap && stopsAreIncidents() && now - Date.parse(s.lastGap.to) < GAP_REPORT_WINDOW_MS) {
    return { ...base, status: "stale", detail: `${gapNote}; running again since ${s.lastGap.to}` };
  }
  if (!Number.isFinite(own)) {
    return { ...base, status: "never_ran", detail: s.previousBeatAt ? `first beat pending; previous beat ${s.previousBeatAt}` : "first beat pending" };
  }
  return {
    ...base,
    status: "healthy",
    detail: [
      `beating every ${Math.round(HEARTBEAT_INTERVAL_MS / 1000)} s since ${s.bootAt}`,
      gapNote ? `last stop: ${gapNote}` : null,
      gapNote && !stopsAreIncidents() ? "expected on a host that sleeps when idle (PORTAVA_ALWAYS_ON is not set)" : null,
    ].filter(Boolean).join(" | "),
  };
}
