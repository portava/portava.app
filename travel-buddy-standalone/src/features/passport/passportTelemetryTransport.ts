/**
 * passportTelemetryTransport — the real transport behind the §32 Passport
 * telemetry seam (passportTelemetry.ts).
 *
 * WHAT THIS IS
 * ============
 * `passportTelemetry.ts` fans every `track*` call out to a pluggable sink and,
 * until the app wires one, only dev-logs. This module IS that sink for the
 * running app: it queues scrubbed events, batches them, and POSTs them with the
 * same authenticated, fire-and-forget fetch the rest of the app already uses
 * for analytics (`services/rankEvents.ts` → /api/rank-events/outcome,
 * `features/map/telemetry` → /api/map/telemetry, `hooks/useMediaAnalytics` →
 * /api/media/analytics/batch). The server stamps the actor from the bearer
 * token — the client never sends a user id.
 *
 * WIRE SHAPE (POST `${baseUrl}/api/passport/telemetry`)
 * =====================================================
 *   {
 *     schemaVersion: '1',
 *     events: [{ name, ts, seq, payload }],   // payload already scrubbed (§23/§24)
 *     meta: { dropped }                        // client-side drop counter
 *   }
 *
 * NEVER BREAKS A PASSPORT SCREEN
 * ==============================
 *   • `sink` and `flush` never throw and never reject.
 *   • A failed POST re-queues the batch (bounded) and backs off exponentially,
 *     capped at BACKOFF_MAX_MS — a dead endpoint can never hot-loop the network.
 *   • 401/403 drops the batch: events for a signed-out session are not worth
 *     retrying. 404/410 drops the batch too (the ingest route is not deployed)
 *     and pins the backoff at its cap, so an undeployed server costs one probe
 *     every few minutes, not a request per event.
 *   • No API base URL (local dev without an API) drops with reason
 *     'unconfigured'; no token keeps events queued (the user may sign in).
 *   • The queue is bounded: past MAX_QUEUE the OLDEST events are dropped and
 *     counted, so a long offline session cannot grow memory without limit.
 *
 * Timers and `now` are injectable so the whole policy is unit-testable without
 * fake timers; `installPassportTelemetry.ts` binds the real ones.
 */
import type { PassportTelemetryEvent, PassportTelemetrySink } from './passportTelemetry.ts';

// ── Wire types ────────────────────────────────────────────────────────────────

export interface PassportTelemetryWireEvent {
  name: PassportTelemetryEvent['type'];
  /** Epoch ms when the event was emitted on the device. */
  ts: number;
  /** Monotonic per-transport sequence — lets the server order a batch. */
  seq: number;
  payload: Record<string, unknown>;
}

export interface PassportTelemetryBatch {
  schemaVersion: '1';
  events: PassportTelemetryWireEvent[];
  meta: { dropped: number };
}

export type PassportTelemetryDropReason =
  | 'unconfigured'
  | 'unauthenticated'
  | 'unavailable'
  | 'queue_overflow';

// ── Options ───────────────────────────────────────────────────────────────────

export interface PassportTelemetryScheduler {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface PassportTelemetryTransportOptions {
  /** e.g. process.env.EXPO_PUBLIC_API_BASE_URL */
  baseUrl: string;
  /** e.g. `freshToken` from services/apiToken.ts */
  getToken: () => Promise<string | null>;
  /** Injected so this module imports nothing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to '/api/passport/telemetry'. */
  path?: string;
  /** Idle delay before a queued batch is sent. Default 4 s. */
  flushIntervalMs?: number;
  /** Send immediately once this many events are queued. Default 25. */
  maxBatch?: number;
  /** Oldest events are dropped past this depth. Default 200. */
  maxQueue?: number;
  /** Clock + timers — injectable for tests. */
  now?: () => number;
  scheduler?: PassportTelemetryScheduler;
}

export interface PassportTelemetryDiagnostics {
  queueDepth: number;
  inFlight: boolean;
  consecutiveFailures: number;
  /** ms until the next scheduled flush, or null when none is scheduled. */
  nextFlushInMs: number | null;
  droppedTotal: number;
  droppedByReason: Partial<Record<PassportTelemetryDropReason, number>>;
  sentTotal: number;
  seq: number;
}

export interface PassportTelemetryTransport {
  /** Plug into `setPassportTelemetrySink`. Never throws. */
  sink: PassportTelemetrySink;
  /** Send whatever is queued now. Never rejects. */
  flush: () => Promise<void>;
  /** Wire to AppState: backgrounding is the last safe moment to send. */
  notifyAppStateChange: (state: string) => void;
  /** Observability for tests / a debug screen. Never used to inject events. */
  diagnostics: () => PassportTelemetryDiagnostics;
  /** Cancel timers and stop accepting events. */
  dispose: () => void;
}

export const DEFAULT_PASSPORT_TELEMETRY_PATH = '/api/passport/telemetry';
export const DEFAULT_FLUSH_INTERVAL_MS = 4_000;
export const DEFAULT_MAX_BATCH = 25;
export const DEFAULT_MAX_QUEUE = 200;
/** Exponential backoff cap — one probe every five minutes at worst. */
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Backoff for the n-th consecutive failure (n >= 1), capped. Pure, exported for tests. */
export function backoffMs(consecutiveFailures: number, baseMs: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  const exp = Math.min(consecutiveFailures, 16);
  return Math.min(BACKOFF_MAX_MS, baseMs * 2 ** exp);
}

const defaultScheduler: PassportTelemetryScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createPassportTelemetryTransport(
  opts: PassportTelemetryTransportOptions,
): PassportTelemetryTransport {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  const path = opts.path ?? DEFAULT_PASSPORT_TELEMETRY_PATH;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatch = Math.max(1, opts.maxBatch ?? DEFAULT_MAX_BATCH);
  const maxQueue = Math.max(maxBatch, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
  const now = opts.now ?? (() => Date.now());
  const scheduler = opts.scheduler ?? defaultScheduler;
  const doFetch =
    opts.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch | undefined);

  let queue: PassportTelemetryWireEvent[] = [];
  let seq = 0;
  let timer: unknown = null;
  let timerDueAt: number | null = null;
  let inFlight = false;
  let flushAgain = false;
  let consecutiveFailures = 0;
  let droppedTotal = 0;
  let sentTotal = 0;
  let disposed = false;
  const droppedByReason: Partial<Record<PassportTelemetryDropReason, number>> = {};

  function drop(reason: PassportTelemetryDropReason, count: number): void {
    if (count <= 0) return;
    droppedTotal += count;
    droppedByReason[reason] = (droppedByReason[reason] ?? 0) + count;
  }

  function cancelTimer(): void {
    if (timer !== null) {
      try { scheduler.clear(timer); } catch { /* never throw */ }
      timer = null;
      timerDueAt = null;
    }
  }

  function schedule(ms: number): void {
    if (disposed || timer !== null || queue.length === 0) return;
    timerDueAt = now() + ms;
    timer = scheduler.set(() => {
      timer = null;
      timerDueAt = null;
      void flush();
    }, ms);
  }

  function scheduleAfterOutcome(): void {
    if (queue.length === 0) return;
    schedule(consecutiveFailures > 0 ? backoffMs(consecutiveFailures, flushIntervalMs) : flushIntervalMs);
  }

  /** Put a failed batch back at the FRONT so ordering survives a retry. */
  function requeue(batch: PassportTelemetryWireEvent[]): void {
    queue = batch.concat(queue);
    const overflow = queue.length - maxQueue;
    if (overflow > 0) {
      queue = queue.slice(overflow);
      drop('queue_overflow', overflow);
    }
  }

  async function send(batch: PassportTelemetryWireEvent[]): Promise<void> {
    if (!baseUrl || typeof doFetch !== 'function') {
      // Nothing to talk to (local dev without an API). Not a failure to retry.
      drop('unconfigured', batch.length);
      return;
    }
    let token: string | null = null;
    try { token = await opts.getToken(); } catch { token = null; }
    if (!token) {
      // Signed out (or auth momentarily unavailable): keep the events, back off.
      consecutiveFailures += 1;
      requeue(batch);
      return;
    }
    const body: PassportTelemetryBatch = {
      schemaVersion: '1',
      events: batch,
      meta: { dropped: droppedTotal },
    };
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch {
      consecutiveFailures += 1;
      requeue(batch);
      return;
    }
    if (res.ok) {
      consecutiveFailures = 0;
      sentTotal += batch.length;
      return;
    }
    if (res.status === 401 || res.status === 403) {
      // Not this session's events any more — do not retry them.
      drop('unauthenticated', batch.length);
      consecutiveFailures += 1;
      return;
    }
    if (res.status === 404 || res.status === 410) {
      // Ingest route not deployed. Drop and pin the backoff at its cap so the
      // client probes rarely instead of retrying every event.
      drop('unavailable', batch.length);
      consecutiveFailures = 16;
      return;
    }
    // 5xx / 429 / anything else: transient — keep and back off.
    consecutiveFailures += 1;
    requeue(batch);
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    if (inFlight) { flushAgain = true; return; }
    cancelTimer();
    if (queue.length === 0) return;
    inFlight = true;
    const batch = queue.slice(0, maxBatch);
    queue = queue.slice(batch.length);
    try {
      await send(batch);
    } catch {
      // send() handles its own failures; this is belt and braces.
      requeue(batch);
      consecutiveFailures += 1;
    } finally {
      inFlight = false;
    }
    if (flushAgain) {
      flushAgain = false;
      if (consecutiveFailures === 0 && queue.length > 0) {
        await flush();
        return;
      }
    }
    scheduleAfterOutcome();
  }

  const sink: PassportTelemetrySink = (event) => {
    try {
      if (disposed) return;
      queue.push({
        name: event.type,
        ts: now(),
        seq: seq++,
        payload: (event.payload ?? {}) as Record<string, unknown>,
      });
      const overflow = queue.length - maxQueue;
      if (overflow > 0) {
        queue = queue.slice(overflow);
        drop('queue_overflow', overflow);
      }
      if (queue.length >= maxBatch && consecutiveFailures === 0 && !inFlight) {
        void flush();
      } else {
        scheduleAfterOutcome();
      }
    } catch {
      // Telemetry must never surface an error to the user.
    }
  };

  function notifyAppStateChange(state: string): void {
    if (state === 'background' || state === 'inactive') {
      void flush();
    }
  }

  function diagnostics(): PassportTelemetryDiagnostics {
    return {
      queueDepth: queue.length,
      inFlight,
      consecutiveFailures,
      nextFlushInMs: timerDueAt === null ? null : Math.max(0, timerDueAt - now()),
      droppedTotal,
      droppedByReason: { ...droppedByReason },
      sentTotal,
      seq,
    };
  }

  function dispose(): void {
    disposed = true;
    cancelTimer();
    queue = [];
  }

  return { sink, flush, notifyAppStateChange, diagnostics, dispose };
}
