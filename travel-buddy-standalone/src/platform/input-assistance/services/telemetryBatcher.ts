/**
 * §44 — the telemetry TRANSPORT's pure half.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════════
 * `inputTelemetry.ts` has declared fourteen §44 event names since Phase 1 and
 * has had real call sites for nine of them since Phase 11. Every one of them is
 * handed to a sink that is `() => {}`. `census-input-intelligence.md` records it
 * at G263 — "Emission is not measurement: in production these events are now
 * produced and dropped" — and gives the reason nothing was built: "the only
 * honest destination is a server endpoint that does not exist yet."
 *
 * That endpoint now exists: `POST /api/input-assistance/telemetry`
 * (`artifacts/api-server/src/routes/inputAssistance.ts`, table from migration
 * 2950). This module is the device side of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY IT IS SPLIT IN TWO
 * ══════════════════════════════════════════════════════════════════════════════
 * This file is PURE: no React, no fetch, no Supabase, no timers of its own. The
 * poster and the scheduler are injected. `telemetryTransport.ts` is the impure
 * half that hands it a real `fetch` and a real bearer token, and it must not be
 * imported by a node:test file for exactly the reason `inputAssistance.ts`'s
 * header already states. Splitting them is what lets the batching, the bound,
 * and the drop semantics be tested at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THREE DECISIONS WORTH ARGUING
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. A REFUSED BATCH IS DROPPED, NOT RETRIED. The server answers a failed write
 *    with 503 + `retryable: true`, truthfully — it does not pretend a broken
 *    ingest is an empty one. Whether to retry is the CLIENT's decision, and for
 *    a funnel event the answer is no: a retry loop against a server incident is
 *    how an analytics client turns one outage into two. The drop is COUNTED
 *    (`dropped()`), so "we lost events" is answerable rather than invisible.
 *
 * 2. THE BUFFER IS BOUNDED AND DROPS THE OLDEST. A device that is offline for an
 *    hour must not accumulate an unbounded array in memory. When the bound is
 *    reached the OLDEST events go, because a funnel wants recent behaviour and
 *    because dropping the newest would silently truncate the arm the user is in
 *    right now.
 *
 * 3. THE BATCHER MANUFACTURES NOTHING. It copies six fields off the event and
 *    adds none. `inputTelemetry.ts`'s scrub is only worth something if the
 *    transport does not helpfully put a label back on the way out, so the wire
 *    shape is fixed here and asserted in the test.
 */
import type { InputTelemetryEvent, TelemetrySink } from './inputTelemetry.ts';

/** One event, exactly as the ingest route's allow-list expects to read it. */
export interface WireTelemetryEvent {
  name: string;
  context: string;
  fieldId: string;
  at: number;
  requestId: string | null;
  props: Record<string, string | number | boolean | null | undefined> | undefined;
}

export interface TelemetryBatch {
  sessionId: string;
  events: WireTelemetryEvent[];
}

export interface PostResult {
  ok: boolean;
  /** The server's own word on whether a later attempt could succeed. */
  retryable?: boolean;
}

export type TelemetryPoster = (batch: TelemetryBatch) => Promise<PostResult>;

export interface TelemetryBatcherOptions {
  post: TelemetryPoster;
  /** The pseudonymous per-app-run correlator. Held by the caller, not invented here. */
  sessionId: string;
  /**
   * Flush as soon as this many events are buffered. Must stay at or under the
   * route's own `MAX_TELEMETRY_BATCH` (50), which refuses an oversized batch
   * WHOLE rather than truncating it.
   */
  maxBatch?: number;
  /** Hard memory bound. Beyond this the OLDEST buffered events are dropped. */
  maxBuffer?: number;
  /** Idle delay before a partial batch leaves. */
  flushMs?: number;
  /**
   * How a deferred flush is scheduled. Injected so this module owns no timer
   * and a test never has to wait on one. The real transport passes setTimeout.
   */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface TelemetryBatcher {
  /** Hand this to `setTelemetrySink`. */
  sink: TelemetrySink;
  /** Send whatever is buffered now. Never rejects. */
  flush: () => Promise<void>;
  /** Events currently buffered. */
  pending: () => number;
  /** Events lost to a refused post or to the buffer bound, since process start. */
  dropped: () => number;
}

/** The route's own ceiling. Exceeding it is refused whole, so never exceed it. */
const ROUTE_MAX_BATCH = 50;

/**
 * An opaque, bounded, per-app-run correlator. Not derived from and not
 * resolvable to an account id — migration 2950 stores NO account id at all, and
 * this is the only thing that lets G365's "time to valid selection" correlate an
 * `input_opened` with the `suggestion_selected` that followed it.
 *
 * The route's own bound is `/^[A-Za-z0-9_.:-]{1,64}$/`; this stays well inside it.
 */
export function newTelemetrySessionId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${rand()}${rand()}`.slice(0, 24);
}

export function createTelemetryBatcher(opts: TelemetryBatcherOptions): TelemetryBatcher {
  const maxBatch = Math.min(opts.maxBatch ?? 20, ROUTE_MAX_BATCH);
  const maxBuffer = opts.maxBuffer ?? 200;
  const flushMs = opts.flushMs ?? 5_000;
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });

  let buffer: WireTelemetryEvent[] = [];
  let droppedCount = 0;
  let timerArmed = false;
  let inFlight = false;

  function toWire(e: InputTelemetryEvent): WireTelemetryEvent {
    // SIX FIELDS, COPIED BY NAME. Not a spread: a spread would carry whatever a
    // future caller decided to hang on the event, which is the leak this layer
    // spends three other mechanisms preventing.
    return {
      name: e.name,
      context: e.context,
      fieldId: e.fieldId,
      at: e.at,
      requestId: e.requestId ?? null,
      props: e.props,
    };
  }

  async function send(): Promise<void> {
    if (inFlight || buffer.length === 0) return;
    const batch: TelemetryBatch = { sessionId: opts.sessionId, events: buffer };
    // Taken off the buffer BEFORE the await: a keystroke landing mid-flight
    // belongs to the next batch, not to this one, and must not be sent twice.
    buffer = [];
    inFlight = true;
    try {
      const res = await opts.post(batch);
      if (!res.ok) droppedCount += batch.events.length;
    } catch {
      // A network failure is a dropped batch, never an exception into the UI.
      droppedCount += batch.events.length;
    } finally {
      inFlight = false;
    }
  }

  const sink: TelemetrySink = (event) => {
    buffer.push(toWire(event) as unknown as WireTelemetryEvent);
    if (buffer.length > maxBuffer) {
      // Oldest out. See decision 2 in the header.
      const overflow = buffer.length - maxBuffer;
      buffer = buffer.slice(overflow);
      droppedCount += overflow;
    }
    if (buffer.length >= maxBatch) {
      void send();
      return;
    }
    if (!timerArmed) {
      timerArmed = true;
      schedule(() => { timerArmed = false; void send(); }, flushMs);
    }
  };

  return {
    sink,
    flush: send,
    pending: () => buffer.length,
    dropped: () => droppedCount,
  };
}
