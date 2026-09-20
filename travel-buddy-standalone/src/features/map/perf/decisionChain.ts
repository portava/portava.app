/**
 * §38's 10:47 PM scenario, as a falsifiable assertion over a captured telemetry
 * stream (census-map M292).
 *
 * ## The pass condition, quoted
 *
 * "ONE `decisionId` appearing across
 * `compass_requested → compass_option_selected → recommendation_accepted →
 * route_started → contribution_submitted` in the captured stream."
 *
 * That is five events joined on one correlation id, and it is also M275's
 * outcome loop — the difference is that M275 asserts it over rows the server
 * stored, while M292 asserts it over a stream captured from a real walk on a
 * handset. Both read the same shape, so both can use this module.
 *
 * ## Why the assertion is made on ROWS, not on client payloads
 *
 * The census is explicit for M275: "queried back after the run — not asserted
 * on the client payloads". A client that minted and threaded a `decisionId`
 * perfectly while every event was dropped by the queue, refused by the payload
 * scrubber or discarded by a dark `map_telemetry_enabled` would satisfy a
 * client-side assertion completely. So the input here is the row shape of
 * `public.map_telemetry_events` — `event_name`, `map_session_id`, `seq`,
 * `client_ts`, `synthesized_session`, `payload` — and the caller is expected to
 * have SELECTed them back.
 *
 * ## What this module is NOT
 *
 * It is not the walk. No physical handset was available where this was written
 * (`docs/architecture/map-sensing-certification.md`'s device ledger, and plan
 * blocker B4), so no stream has been captured and M292 is NOT measured. The
 * runnable protocol is `docs/map/device-measurement-protocol.md` §M292.
 */

/**
 * The five events, in the order §38's scenario walks them.
 *
 * ORDER IS PART OF THE CLAIM, and dropping it would be the easiest way to pass
 * this row dishonestly: the same five rows arriving in any sequence would show
 * a `contribution_submitted` that preceded the `compass_requested` it is
 * supposed to be an outcome of. That is not a decision loop, it is five events
 * that happen to share a string.
 */
export const DECISION_CHAIN = [
  'compass_requested',
  'compass_option_selected',
  'recommendation_accepted',
  'route_started',
  'contribution_submitted',
] as const;

export type ChainEvent = (typeof DECISION_CHAIN)[number];

/** One row of `public.map_telemetry_events`, reduced to what is read here. */
export interface TelemetryRow {
  event_name: string;
  map_session_id: string;
  seq?: number | null;
  client_ts?: string | null;
  /** Set when the event fired before any `map_opened`. Excluded — see below. */
  synthesized_session?: boolean | null;
  payload?: { decisionId?: unknown } | null;
}

function decisionIdOf(row: TelemetryRow): string | null {
  const raw = row?.payload?.decisionId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Sort key within one decision.
 *
 * `seq` is the monotonic per-session counter the emitter writes and is the
 * authority. `client_ts` is the fallback, and only the fallback: two events in
 * the same millisecond are common on a fast tap, and a device clock can step
 * mid-session.
 */
function orderKey(row: TelemetryRow): number {
  if (typeof row.seq === 'number' && Number.isFinite(row.seq)) return row.seq;
  const t = row.client_ts ? Date.parse(row.client_ts) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

export interface ChainCandidate {
  decisionId: string;
  mapSessionId: string | null;
  /** The chain events observed for this id, in observed order. */
  observed: ChainEvent[];
  /** Chain events with no row. */
  missing: ChainEvent[];
  /** True when all five are present AND in §38's order. */
  complete: boolean;
  /** True when all five are present but the order is wrong. */
  outOfOrder: boolean;
  /**
   * True when the id's rows span more than one map session. A decision that
   * crosses sessions is not one walk; it is a correlation id that leaked.
   */
  crossSession: boolean;
}

/**
 * Group a captured stream by `decisionId` and grade each group.
 *
 * Rows with a synthesised session are EXCLUDED. `2202_map_telemetry.sql` says
 * why in its own comment: they fired before any `map_opened`, so "analysis must
 * exclude these from session funnels rather than counting a stray as a real map
 * visit". A chain assembled from strays is not a walk.
 */
export function chainCandidates(rows: readonly TelemetryRow[]): ChainCandidate[] {
  const chainSet = new Set<string>(DECISION_CHAIN);
  const groups = new Map<string, TelemetryRow[]>();

  for (const row of rows ?? []) {
    if (!row || typeof row.event_name !== 'string') continue;
    if (row.synthesized_session === true) continue;
    if (!chainSet.has(row.event_name)) continue;
    const id = decisionIdOf(row);
    if (id == null) continue;
    const bucket = groups.get(id);
    if (bucket) bucket.push(row);
    else groups.set(id, [row]);
  }

  const out: ChainCandidate[] = [];
  for (const [decisionId, bucket] of groups) {
    const sorted = [...bucket].sort((a, b) => orderKey(a) - orderKey(b));
    const sessions = new Set(sorted.map((r) => r.map_session_id));

    // First occurrence of each chain event, in observed order.
    const observed: ChainEvent[] = [];
    for (const r of sorted) {
      const name = r.event_name as ChainEvent;
      if (!observed.includes(name)) observed.push(name);
    }
    const missing = DECISION_CHAIN.filter((e) => !observed.includes(e));
    const inOrder =
      missing.length === 0 &&
      DECISION_CHAIN.every((event, i) => observed[i] === event);

    out.push({
      decisionId,
      mapSessionId: sessions.size === 1 ? sorted[0].map_session_id : null,
      observed,
      missing,
      complete: inOrder,
      outOfOrder: missing.length === 0 && !inOrder,
      crossSession: sessions.size > 1,
    });
  }
  return out;
}

export interface ChainVerdict {
  /** The §38 pass condition: at least one id walked all five, in order. */
  pass: boolean;
  /** Every id that did. */
  complete: ChainCandidate[];
  /** Ids that got part of the way — what a failed walk is diagnosed from. */
  partial: ChainCandidate[];
  /** Ids with all five events in the wrong order. */
  outOfOrder: ChainCandidate[];
  /** How many chain-event rows carried no decisionId at all. */
  rowsWithoutDecisionId: number;
  /** How many chain-event rows were dropped as synthesised-session strays. */
  synthesizedRowsExcluded: number;
}

/**
 * Grade a captured stream against §38.
 *
 * ## Anti-vacuity
 *
 * An empty stream FAILS. It has to: "no decisionId was broken" is trivially
 * true of a capture that contains nothing, and a device run that produced no
 * telemetry at all is the single most likely way for M292 to "pass" without
 * anything having happened. `pass` requires a positively identified complete
 * chain, and `rowsWithoutDecisionId` / `synthesizedRowsExcluded` are surfaced
 * so a stream that had the events but lost the correlation is diagnosable
 * rather than merely absent.
 */
export function gradeDecisionChain(rows: readonly TelemetryRow[]): ChainVerdict {
  const chainSet = new Set<string>(DECISION_CHAIN);
  let rowsWithoutDecisionId = 0;
  let synthesizedRowsExcluded = 0;
  for (const row of rows ?? []) {
    if (!row || typeof row.event_name !== 'string') continue;
    if (!chainSet.has(row.event_name)) continue;
    if (row.synthesized_session === true) {
      synthesizedRowsExcluded += 1;
      continue;
    }
    if (decisionIdOf(row) == null) rowsWithoutDecisionId += 1;
  }

  const candidates = chainCandidates(rows);
  const complete = candidates.filter((c) => c.complete && !c.crossSession);
  return {
    pass: complete.length > 0,
    complete,
    partial: candidates.filter((c) => c.missing.length > 0),
    outOfOrder: candidates.filter((c) => c.outOfOrder),
    rowsWithoutDecisionId,
    synthesizedRowsExcluded,
  };
}

/** A ledger line for `docs/map/device-measurement-protocol.md` §M292. */
export function formatChainVerdict(verdict: ChainVerdict): string {
  if (verdict.pass) {
    const c = verdict.complete[0];
    return `PASS — decisionId ${c.decisionId} walked all ${DECISION_CHAIN.length} events in order (session ${c.mapSessionId}).`;
  }
  const best = [...verdict.partial].sort((a, b) => a.missing.length - b.missing.length)[0];
  const detail = best
    ? `best partial chain ${best.decisionId} missing [${best.missing.join(', ')}]`
    : 'no chain event carried a decisionId';
  return (
    `FAIL — ${detail}; ` +
    `${verdict.outOfOrder.length} out-of-order, ` +
    `${verdict.rowsWithoutDecisionId} rows without a decisionId, ` +
    `${verdict.synthesizedRowsExcluded} synthesised-session rows excluded.`
  );
}
