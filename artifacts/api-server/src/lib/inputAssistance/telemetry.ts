/**
 * §40 `SuggestionTelemetryService` — the server-side half of §44.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════════════
 * `census-input-intelligence.md` G292 graded this service NOT-BUILT, with the
 * sentence: "There is no server-side telemetry service, no serve log, no
 * impression record and no analytics write anywhere in `lib/inputAssistance/`."
 * Five further rows (G263, G306, G355, G365, G366, G367) name the SAME blocker
 * from the client side: `platform/input-assistance/services/inputTelemetry.ts`
 * emits fourteen declared event names into a sink that is `() => {}`, and the
 * reason recorded for not fixing it was that "the only honest destination is a
 * server endpoint that does not exist yet".
 *
 * This module is that destination's logic; `routes/inputAssistance.ts` is its
 * door and `migrations/2950_input_assistance_telemetry_events.sql` is its table.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE PAYLOAD IS REBUILT, NOT ACCEPTED
 * ══════════════════════════════════════════════════════════════════════════════
 * §44's prohibition is on capturing raw typed content for a field that forbids
 * it, and §29 makes a caption / comment / Telegraph message the hard case. The
 * client already scrubs four key names (`text`, `query`, `rawText`, `message`)
 * before an event leaves the device — but a denylist protects only as well as it
 * is complete, and this server cannot audit the client that called it.
 *
 * So each event is REBUILT from a per-event-name allow-list of props: a key that
 * is not named for that event is never copied, under any spelling. An attacker
 * (or a future careless caller) cannot smuggle a message body through as `note`,
 * `caption`, `label` or `q`, because there is no branch that copies an unnamed
 * key. This is the same posture `routes/wallTelemetry.ts` adopted, for the same
 * reason, and migration 2950's CHECK constraint is the third line behind it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE FIELD'S OWN POLICY IS ENFORCED HERE, NOT MERELY DECLARED
 * ══════════════════════════════════════════════════════════════════════════════
 * Census G33 records that `telemetryPolicy` is enforced on the client and is
 * inert on the server. `policyRegistry.ts` declares, per context, which §44
 * events the field participates in (`telemetryPolicy.events`) and whether raw
 * text may be logged (`logRawText`). This module reads BOTH:
 *
 *   • an event the field's policy does not declare is REFUSED and counted as
 *     rejected — it is never written, and never quietly dropped from the tally;
 *   • `logRawText: false` (which is every registered context today) removes the
 *     raw-text key names as a backstop over the rebuilt payload.
 *
 * `telegraph_message` is the case that matters: its policy declares three
 * metadata events and nothing else, so an IMPRESSION OF A RECIPIENT LIST — a
 * list of people — is refused at this boundary rather than stored.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * A FAILED WRITE IS A REFUSAL, NOT AN EMPTY SUCCESS
 * ══════════════════════════════════════════════════════════════════════════════
 * `supabase-js` RESOLVES on a database error rather than throwing. A discarded
 * `error` therefore produces a response byte-identical to "the write succeeded
 * and there was nothing to do". For a telemetry table that is the worst possible
 * failure mode: the funnel would read as ZERO USAGE rather than as BROKEN
 * INGEST, and nobody would look.
 *
 * That is not hypothetical here. Migration 2950 is NOT APPLIED to any database
 * at the time of writing, so every call to `recordTelemetryEvents` in production
 * today takes the refusal branch. It must be visible.
 *
 * So the error is bound and answered as a RETRYABLE refusal. The caller
 * (`routes/inputAssistance.ts`) turns that into 503 + `retryable: true`. The
 * client transport is free to DROP rather than retry — that is the client's
 * choice to make — but the server never reports a failure as a success.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { InputContext, InputFieldPolicy } from './types';

/** The table migration 2950 creates. */
export const TELEMETRY_TABLE = 'input_assistance_telemetry_events';

/**
 * §44's event vocabulary. These fourteen mirror `InputTelemetryEventName` in
 * travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts
 * EXACTLY and in the same order.
 *
 * There is DELIBERATELY no fifteenth, server-only `suggestion_served` name. An
 * earlier draft of this file had one, for the suggest route's own latency — and
 * a name that nothing produces is the precise defect this census spent two
 * passes on ("declared and never emitted"). Serve latency instead travels on
 * the response envelope as `serverMs` and comes back on
 * `suggestion_request_completed`: one path, with a producer, rather than two.
 *
 * This list and migration 2950's `iate_event_name_known` CHECK are two copies of
 * one vocabulary. They are kept in step by `TELEMETRY_EVENT_PROPS` below having
 * an entry per name, by the vocabulary check in `rebuildTelemetryEvent`, and by
 * a test asserting no registered policy declares a name this list does not have.
 */
export const INPUT_TELEMETRY_EVENT_NAMES = [
  'input_opened',
  'query_length_changed',
  'suggestion_request_started',
  'suggestion_request_completed',
  'suggestion_rendered',
  'suggestion_selected',
  'suggestion_dismissed',
  'raw_search_submitted',
  'manual_value_kept',
  'validation_shown',
  'correction_accepted',
  'disambiguation_selected',
  'action_completed',
  'downstream_task_completed',
] as const;

export type InputTelemetryEventName = (typeof INPUT_TELEMETRY_EVENT_NAMES)[number];

const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set(INPUT_TELEMETRY_EVENT_NAMES);

/**
 * How a single prop is validated. Deliberately only four shapes, none of which
 * is "a string of arbitrary length":
 *
 *   int    — a count or a length. Bounded, non-negative, integral.
 *   unit   — a confidence in [0,1].
 *   bool   — a flag.
 *   token  — a SHORT enum-ish string. This is the only shape that carries
 *            characters, and it is capped at 64 and stripped of anything that
 *            is not an identifier character, a comma or a hyphen, so it can
 *            hold `entity,recent` or `add_to_trip` and cannot hold prose.
 */
type PropShape = 'int' | 'unit' | 'bool' | 'token';

const MAX_TOKEN_LEN = 64;
const MAX_INT = 100_000;
/** Only identifier characters, commas and hyphens survive. No spaces: prose has spaces. */
const TOKEN_RE = /^[A-Za-z0-9_,.:-]{1,64}$/;

function coerce(shape: PropShape, raw: unknown): number | boolean | string | undefined {
  switch (shape) {
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number.NaN;
      if (!Number.isFinite(n)) return undefined;
      const i = Math.floor(n);
      return i >= 0 && i <= MAX_INT ? i : undefined;
    }
    case 'unit': {
      const n = typeof raw === 'number' ? raw : Number.NaN;
      if (!Number.isFinite(n)) return undefined;
      return n >= 0 && n <= 1 ? n : undefined;
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'token': {
      if (typeof raw !== 'string') return undefined;
      const t = raw.trim();
      if (t.length === 0 || t.length > MAX_TOKEN_LEN) return undefined;
      return TOKEN_RE.test(t) ? t : undefined;
    }
  }
}

/**
 * THE ALLOW-LIST. One entry per event name; a key not listed here for that name
 * is not copied. Every shape is a count, a length, a confidence, a flag or a
 * short token — never free text.
 *
 * These mirror the payloads the client helpers actually build
 * (`services/inputTelemetry.ts`); where the client sends a key this list does
 * not name, the key is dropped rather than the event refused, because a client
 * that adds a prop must not be able to break ingest for an event that is
 * otherwise valid.
 */
export const TELEMETRY_EVENT_PROPS: Record<InputTelemetryEventName, Record<string, PropShape>> = {
  input_opened: {},
  query_length_changed: { length: 'int' },
  suggestion_request_started: {},
  // `serverMs` is the value the suggest envelope now returns (census G372);
  // `clientMs` is the round trip the device saw. Both, because the difference
  // between them is the network and it is the part the server cannot see.
  suggestion_request_completed: { count: 'int', serverMs: 'int', clientMs: 'int' },
  suggestion_rendered: { count: 'int', types: 'token' },
  suggestion_selected: { suggestionType: 'token', source: 'token' },
  suggestion_dismissed: { shownCount: 'int', reason: 'token' },
  raw_search_submitted: { length: 'int', viaSuggestion: 'bool' },
  manual_value_kept: { length: 'int' },
  validation_shown: { count: 'int' },
  correction_accepted: { confidence: 'unit', source: 'token' },
  // `resolvedExisting` is §57's duplicate-prevention count (census G369): true
  // when the disambiguation row the user pressed carried a `resolve_existing`
  // structured value, i.e. it was a §55 duplicate rather than a §19 ambiguity.
  // One bool — no identifier, no text. `metrics.ts` is its only reader.
  disambiguation_selected: { entityType: 'token', confidence: 'unit', resolvedExisting: 'bool' },
  action_completed: { actionType: 'token', ok: 'bool' },
  downstream_task_completed: { task: 'token', ok: 'bool' },
};

/**
 * Raw-text key names, as the CLIENT scrubber knows them
 * (`services/inputTelemetry.ts` RAW_TEXT_KEYS) plus the server's own additions.
 * These can never survive the rebuild — no allow-list above names one — so this
 * set is a BACKSTOP whose job is to fail loudly if the rebuild is ever widened.
 */
const RAW_TEXT_KEYS: ReadonlySet<string> = new Set([
  'text', 'query', 'rawText', 'raw_text', 'message',
  'label', 'labels', 'name', 'handle', 'username', 'title', 'body', 'caption',
]);

export interface RawTelemetryEvent {
  name?: unknown;
  context?: unknown;
  fieldId?: unknown;
  at?: unknown;
  requestId?: unknown;
  props?: unknown;
}

/** A row exactly as migration 2950 declares it. */
export interface TelemetryRow {
  session_id: string;
  request_id: string | null;
  event_name: InputTelemetryEventName;
  context: string;
  field_id: string;
  policy_version: string;
  occurred_at: string;
  props: Record<string, number | boolean | string>;
}

export type RejectReason =
  | 'unknown_event_name'
  | 'unknown_context'
  | 'no_policy'
  | 'event_not_declared_by_policy'
  | 'malformed';

export type RebuildOutcome =
  | { ok: true; row: TelemetryRow }
  | { ok: false; reason: RejectReason };

const MAX_FIELD_ID_LEN = 128;
/** Clocks drift and devices sleep. Anything outside this window is not a timestamp. */
const MAX_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rebuild ONE event into a row, or refuse it with a reason.
 *
 * `policy` is the server's own registered policy for the claimed context — the
 * caller resolves it, because the caller owns the registry import. A null policy
 * is a refusal, never a pass-through: an unregistered context has declared
 * nothing, and "declared nothing" is not "declared everything".
 */
export function rebuildTelemetryEvent(
  raw: RawTelemetryEvent,
  sessionId: string,
  policy: InputFieldPolicy | null,
  policyVersion: string,
  now: number,
): RebuildOutcome {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };

  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!KNOWN_EVENT_NAMES.has(name)) return { ok: false, reason: 'unknown_event_name' };
  const eventName = name as InputTelemetryEventName;

  if (!policy) return { ok: false, reason: 'no_policy' };

  // §44 — the field's OWN declared vocabulary. `events` is a plain string[] on
  // the server side of the contract (types.ts `InputTelemetryPolicy`), and an
  // empty list means the field participates in nothing, not in everything.
  const declared = policy.telemetryPolicy?.events ?? [];
  if (!declared.includes(eventName)) {
    return { ok: false, reason: 'event_not_declared_by_policy' };
  }

  const fieldIdRaw = typeof raw.fieldId === 'string' ? raw.fieldId.trim() : '';
  const fieldId = fieldIdRaw.length > 0 && fieldIdRaw.length <= MAX_FIELD_ID_LEN
    ? fieldIdRaw
    : policy.fieldId;

  const atRaw = typeof raw.at === 'number' ? raw.at : Number.NaN;
  if (!Number.isFinite(atRaw)) return { ok: false, reason: 'malformed' };
  // A device clock that is days out would corrupt every window query silently.
  // Clamp rather than refuse: the event is real, only its timestamp is not.
  const at = Math.abs(atRaw - now) > MAX_CLOCK_SKEW_MS ? now : atRaw;

  const requestIdRaw = typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
  const requestId =
    requestIdRaw.length > 0 && requestIdRaw.length <= 64 && TOKEN_RE.test(requestIdRaw)
      ? requestIdRaw
      : null;

  // ── THE REBUILD ────────────────────────────────────────────────────────────
  const allowed = TELEMETRY_EVENT_PROPS[eventName];
  const incoming = (raw.props && typeof raw.props === 'object' ? raw.props : {}) as Record<string, unknown>;
  const props: Record<string, number | boolean | string> = {};
  for (const [key, shape] of Object.entries(allowed)) {
    // The backstop. No allow-list entry names a raw-text key today; if one ever
    // does, this refuses to copy it rather than trusting the review that added it.
    if (RAW_TEXT_KEYS.has(key)) continue;
    if (!policy.telemetryPolicy?.logRawText && RAW_TEXT_KEYS.has(key)) continue;
    if (!(key in incoming)) continue;
    const v = coerce(shape, incoming[key]);
    if (v !== undefined) props[key] = v;
  }

  return {
    ok: true,
    row: {
      session_id: sessionId,
      request_id: requestId,
      event_name: eventName,
      context: policy.context as InputContext,
      field_id: fieldId,
      policy_version: policyVersion,
      occurred_at: new Date(at).toISOString(),
      props,
    },
  };
}

export type RecordOutcome =
  | { recorded: number }
  | { recorded: 0; refusal: { retryable: boolean; reason: string } };

// ── Permanent failures, and the one that is a privacy signal ─────────────────
//
// EVERY write failure used to be answered `retryable: true`, including a CHECK
// violation — which the doc comment below already listed among the failures it
// binds. The comment and the code disagreed, and the code was the wrong one.
// Two things follow from that, and only one of them is about privacy.
//
// 1. A POISON PILL. A row that violates a CHECK can NEVER be accepted. Telling
//    the client to retry it means the batch is retried forever and every event
//    queued behind it never lands — a PERMANENT failure reported as transient,
//    which is the same class of dishonesty as `{ok:true, accepted:0}` over a
//    broken ingest that this file's header already refuses.
//
// 2. A PRIVACY SIGNAL, and it is the loudest one this subsystem can produce.
//    `iate_props_no_raw_text` fires only when a row reaching the database still
//    carries one of migration 2950's thirteen forbidden keys. But the server
//    REBUILDS every event from a per-name allow-list before it gets here, so
//    that constraint firing means the allow-list and the database's forbidden
//    list DISAGREE — the last line of defence caught something the earlier
//    lines were supposed to make impossible. Logged as a generic "write
//    failed", it is indistinguishable from a network blip.
//
// WHAT IS DELIBERATELY NOT LOGGED: the props. Logging the offending blob to
// diagnose a raw-text leak would write the raw text into the log — the exact
// harm the constraint exists to prevent, moved somewhere with weaker controls.
// Only the constraint name, the event name and WHICH forbidden keys were
// present are recorded, and those key names come from a fixed list in this file
// rather than from the payload.
//
// THIS IS NOT §57's PRIVACY-INCIDENT METRIC (G371) AND MUST NOT BE READ AS ONE.
// A fired constraint is a NEAR MISS: the gate held and nothing leaked. An
// incident is a leak that happened, and this table stores no account id, so
// "it happened to someone" is not a fact it can hold. G371 is settled by
// production security and audit logs, by someone with access to them.

/** PostgreSQL SQLSTATEs that no retry can ever turn into a success. */
const PERMANENT_SQLSTATES: ReadonlySet<string> = new Set([
  '23514', // check_violation
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation
  '22001', // string_data_right_truncation
]);

/** The constraint migration 2950 names for the raw-text key refusal. */
const RAW_TEXT_CONSTRAINT = 'iate_props_no_raw_text';

/**
 * Mirrors the key list in migration 2950's `iate_props_no_raw_text` CHECK.
 * Used ONLY to name which keys were present in a refused row — never to filter,
 * because the rebuild allow-list upstream is what does the filtering, and a
 * second filter here would mask the disagreement this exists to surface.
 */
export const FORBIDDEN_PROP_KEYS: readonly string[] = [
  'text', 'query', 'rawText', 'raw_text', 'message',
  'label', 'labels', 'name', 'handle', 'username', 'title', 'body', 'caption',
];

function sqlState(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

function constraintName(err: unknown): string {
  const e = err as { constraint?: unknown; message?: unknown } | null;
  if (typeof e?.constraint === 'string') return e.constraint;
  // PostgREST does not always surface `constraint`; the name appears in the
  // message when it does not.
  const msg = typeof e?.message === 'string' ? e.message : '';
  return msg.includes(RAW_TEXT_CONSTRAINT) ? RAW_TEXT_CONSTRAINT : '';
}

/**
 * Which forbidden keys the rows carried. Key NAMES only — the values are never
 * read, and the names are matched against this file's own list rather than
 * enumerated from the payload, so a novel key cannot smuggle itself into a log
 * line by being present.
 */
export function forbiddenKeysPresent(rows: readonly TelemetryRow[]): string[] {
  const hit = new Set<string>();
  for (const r of rows) {
    const props = (r as { props?: unknown }).props;
    if (!props || typeof props !== 'object') continue;
    for (const k of FORBIDDEN_PROP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(props, k)) hit.add(k);
    }
  }
  return [...hit].sort();
}

/**
 * Write rebuilt rows to the serve log.
 *
 * THE ERROR IS BOUND AND ANSWERED. A PostgREST failure here — a missing table
 * (migration 2950 is unapplied today), a CHECK violation, a network fault — is
 * reported as a RETRYABLE refusal. It is never folded into `recorded: 0`, which
 * is what "no events arrived" looks like and is a different fact entirely.
 */
export async function recordTelemetryEvents(
  db: SupabaseClient,
  rows: readonly TelemetryRow[],
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<RecordOutcome> {
  if (rows.length === 0) return { recorded: 0 };
  try {
    const { error } = await db.from(TELEMETRY_TABLE).insert(rows as TelemetryRow[]);
    if (error) return classifyWriteFailure(error, rows, log, 'write_failed');
  } catch (err) {
    return classifyWriteFailure(err, rows, log, 'write_threw');
  }
  return { recorded: rows.length };
}

/**
 * Decide whether a write failure can ever succeed on a retry, and surface the
 * one kind that is a privacy signal.
 *
 * The default stays RETRYABLE: a missing table, a network fault or an unknown
 * error is transient until proven otherwise, and the honest answer to "I do not
 * recognise this" is to let the client try again. Only a SQLSTATE this file
 * names as permanent flips that.
 */
function classifyWriteFailure(
  err: unknown,
  rows: readonly TelemetryRow[],
  log: { warn: (obj: unknown, msg?: string) => void; error?: (obj: unknown, msg?: string) => void } | undefined,
  fallbackReason: string,
): RecordOutcome {
  const state = sqlState(err);
  const constraint = constraintName(err);

  if (constraint === RAW_TEXT_CONSTRAINT || (state === '23514' && constraint === '')) {
    // The loudest thing this subsystem can say. The server REBUILDS every event
    // from a per-name allow-list before it reaches here, so this constraint
    // firing means that allow-list and migration 2950's forbidden-key list
    // DISAGREE. Nothing leaked — the gate held — but a line of defence that was
    // supposed to be unreachable was reached.
    //
    // The props are NOT logged. Logging the offending blob to diagnose a
    // raw-text leak would write the raw text into the log, which is the harm
    // the constraint exists to prevent moved somewhere with weaker controls.
    // Only key NAMES, matched against this file's own list, travel.
    const report = {
      constraint: RAW_TEXT_CONSTRAINT,
      sqlstate: state || 'unknown',
      count: rows.length,
      eventNames: [...new Set(rows.map((r) => r.event_name))].sort(),
      forbiddenKeysPresent: forbiddenKeysPresent(rows),
    };
    const emit = log?.error ?? log?.warn;
    if (emit) {
      emit(
        report,
        'INPUT TELEMETRY PRIVACY GUARD FIRED: the serve-log rebuild allow-list admitted a key migration 2950 forbids',
      );
    }
    return { recorded: 0, refusal: { retryable: false, reason: 'forbidden_props_key' } };
  }

  if (PERMANENT_SQLSTATES.has(state)) {
    // A poison pill. Retrying cannot turn this into a success, and telling the
    // client otherwise means every event queued behind it never lands.
    if (log) {
      log.warn(
        { sqlstate: state, constraint: constraint || 'unknown', count: rows.length },
        'input telemetry ingest refused permanently — the batch can never be accepted',
      );
    }
    return { recorded: 0, refusal: { retryable: false, reason: `constraint_violation:${state}` } };
  }

  if (log) log.warn({ err, count: rows.length }, `input telemetry ingest ${fallbackReason}`);
  return { recorded: 0, refusal: { retryable: true, reason: fallbackReason } };
}
