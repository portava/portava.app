/**
 * Global Input Intelligence — telemetry taxonomy + sink (spec §44).
 *
 * "Telemetry should measure usefulness without unnecessarily capturing raw
 * private text." This defines the §44 event names and a pluggable sink. By
 * default it is a no-op (Phase 1 wires the taxonomy; a later phase attaches a
 * real analytics transport). The privacy rule is enforced HERE: when a field's
 * telemetry policy says `captureRawText: false`, any `text`/`query` payload is
 * dropped before the event leaves this module — a caller cannot leak a private
 * message by accident.
 *
 * Pure module — no React, no network (the sink is injected).
 */
import type {
  InputTelemetryEventName,
  InputTelemetryPolicy,
} from '../types/fieldPolicy.ts';
import type { InputContext } from '../types/inputContext.ts';

export interface InputTelemetryEvent {
  name: InputTelemetryEventName;
  fieldId: string;
  context: InputContext;
  /** Milliseconds since epoch. */
  at: number;
  /**
   * Non-sensitive metadata only. Raw text is stripped upstream when the field's
   * policy forbids it; prefer counts, lengths, suggestion types, latency.
   */
  props?: Record<string, string | number | boolean | null | undefined>;
}

export type TelemetrySink = (event: InputTelemetryEvent) => void;

/** Default sink: no-op. Real transport is attached in a later phase. */
let sink: TelemetrySink = () => {};

/** Attach a telemetry transport (analytics client, dev logger, test spy). */
export function setTelemetrySink(next: TelemetrySink): void {
  sink = next;
}

/** Reset to the no-op sink. Tests + teardown. */
export function resetTelemetrySink(): void {
  sink = () => {};
}

/** Keys that carry raw user text and must be dropped for non-public fields. */
const RAW_TEXT_KEYS = new Set(['text', 'query', 'rawText', 'message']);

function scrubProps(
  props: InputTelemetryEvent['props'],
  policy: InputTelemetryPolicy | undefined,
): InputTelemetryEvent['props'] {
  if (!props) return props;
  if (policy?.captureRawText) return props;
  const out: NonNullable<InputTelemetryEvent['props']> = {};
  for (const [k, v] of Object.entries(props)) {
    if (RAW_TEXT_KEYS.has(k)) continue; // drop raw text for private/sensitive fields
    out[k] = v;
  }
  return out;
}

function isEventAllowed(
  name: InputTelemetryEventName,
  policy: InputTelemetryPolicy | undefined,
): boolean {
  if (!policy) return true;
  if (policy.events === 'all') return true;
  return policy.events.includes(name);
}

/**
 * Emit a §44 event. `policy` gates which events fire and whether raw-text props
 * survive. Never throws — telemetry must not affect the input UX.
 */
export function emitInputEvent(
  name: InputTelemetryEventName,
  fieldId: string,
  context: InputContext,
  props?: InputTelemetryEvent['props'],
  policy?: InputTelemetryPolicy,
): void {
  try {
    if (!isEventAllowed(name, policy)) return;
    sink({ name, fieldId, context, at: Date.now(), props: scrubProps(props, policy) });
  } catch {
    // best-effort — a telemetry failure must never surface to the user
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §44/§45 — the funnel arms that were declared and never emitted
// ─────────────────────────────────────────────────────────────────────────────
//
// The taxonomy above has always listed fourteen event names. Until now exactly
// three of them had a call site: `input_opened`, `query_length_changed` and
// `suggestion_selected` (plus the two request lifecycle events). Every other
// name was a string in a union that nothing produced, which is why §45's
// learning loop had only its "accepted" arm, why §57's funnel metrics had no
// denominator, and why the §49 certification could say "measure usefulness"
// while measuring nothing but acceptance.
//
// The helpers below are the call-site vocabulary. They exist as named functions
// rather than raw `emitInputEvent` calls at each site so that (a) the prop shape
// for one event is decided in ONE place and cannot drift between callers, and
// (b) a test can assert the funnel by name instead of by string literal.
//
// WHAT THEY STILL DO NOT DO. The default sink is a no-op and this module ships
// no transport. Emission is not measurement: until `setTelemetrySink` is called
// with something that leaves the device, these events are produced and dropped.
// That gap is deliberate and is recorded as such in the census — inventing a
// transport here would be worse, because the only honest destination is a server
// endpoint that does not exist yet.

import type { InputSuggestion } from '../types/inputSuggestion.ts';

/** Common emit shape: every helper takes the field's id + resolved policy. */
export interface TelemetryField {
  fieldId: string;
  context: InputContext;
  policy?: InputTelemetryPolicy;
}

/**
 * §44 `suggestion_rendered` — the funnel's DENOMINATOR. Without it §57's
 * "valid entity resolution rate" has nothing to divide by, because nothing
 * recorded that a suggestion was ever put in front of the user.
 *
 * Carries counts and TYPE names only. It deliberately does not carry labels: a
 * rendered recipient list is a list of people, and the event must be safe to
 * emit for a field whose policy forbids raw text.
 */
export function emitSuggestionsRendered(f: TelemetryField, suggestions: readonly InputSuggestion[]): void {
  const types = [...new Set(suggestions.map((s) => s.type))].sort().join(',');
  emitInputEvent(
    'suggestion_rendered',
    f.fieldId,
    f.context,
    { count: suggestions.length, types },
    f.policy,
  );
}

/**
 * §44 `validation_shown` — a non-blocking validation row reached the user.
 * §23's validations have been produced and rendered since Phase 5; nothing
 * recorded that they were seen, so "manual fallback rate" could not distinguish
 * a user who ignored a warning from one who never got it.
 */
export function emitValidationShown(f: TelemetryField, count: number): void {
  emitInputEvent('validation_shown', f.fieldId, f.context, { count }, f.policy);
}

/**
 * §44/§45 `suggestion_dismissed` — the IGNORED arm. §45 requires the engine to
 * learn from accepted *and ignored* suggestions; only acceptance was recorded,
 * which is exactly the "optimise for acceptance rate" anti-pattern §45 names.
 *
 * Fires when a list that WAS shown goes away without a selection — a blur, an
 * Escape, or the field emptying. `shownCount` is what the user passed over.
 */
export function emitSuggestionsDismissed(f: TelemetryField, shownCount: number, reason: string): void {
  emitInputEvent('suggestion_dismissed', f.fieldId, f.context, { shownCount, reason }, f.policy);
}

/**
 * §44 `manual_value_kept` — the EDITED arm: suggestions were shown and the user
 * kept their own text anyway. §57's "manual fallback rate" is this event over
 * `suggestion_rendered`, and neither existed.
 *
 * `length` rather than the text itself, always: this event must be emittable on
 * a caption or a private message, where the raw value may never be captured.
 */
export function emitManualValueKept(f: TelemetryField, length: number): void {
  emitInputEvent('manual_value_kept', f.fieldId, f.context, { length }, f.policy);
}

/** §44 `raw_search_submitted` — the user submitted their query instead of resolving it. */
export function emitRawSearchSubmitted(f: TelemetryField, length: number, viaSuggestion: boolean): void {
  emitInputEvent('raw_search_submitted', f.fieldId, f.context, { length, viaSuggestion }, f.policy);
}

/** §44 `correction_accepted` — a §10 spelling correction row was taken. */
export function emitCorrectionAccepted(f: TelemetryField, s: InputSuggestion): void {
  emitInputEvent(
    'correction_accepted',
    f.fieldId,
    f.context,
    { confidence: s.confidence ?? null, source: s.source },
    f.policy,
  );
}

/** §44 `disambiguation_selected` — a §19 ranked CHOICE was resolved by the user. */
export function emitDisambiguationSelected(f: TelemetryField, s: InputSuggestion): void {
  emitInputEvent(
    'disambiguation_selected',
    f.fieldId,
    f.context,
    { entityType: s.entityType ?? null, confidence: s.confidence ?? null },
    f.policy,
  );
}

/**
 * §44 `action_completed` — a §21/§43 action the user tapped actually RAN.
 *
 * Exported for the screen that dispatches the action, because only that screen
 * knows whether the propose-only flow it opened was confirmed. SmartInput
 * deliberately does NOT call this on selection: selecting an action row opens a
 * picker, and calling the event "completed" at that moment would make every
 * abandoned picker look like a success.
 */
export function emitActionCompleted(f: TelemetryField, actionType: string, ok: boolean): void {
  emitInputEvent('action_completed', f.fieldId, f.context, { actionType, ok }, f.policy);
}

/**
 * §45/§57 `downstream_task_completed` — the OUTCOME signal the whole learning
 * loop is built on: did the task the suggestion served actually succeed (trip
 * saved, event created, message sent)?
 *
 * Exported for the feature screens, because this layer cannot observe it: the
 * input field is long gone by the time a trip is saved. No caller exists yet,
 * and the census records that honestly rather than pretending a proxy for it.
 */
export function emitDownstreamTaskCompleted(f: TelemetryField, task: string, ok: boolean): void {
  emitInputEvent('downstream_task_completed', f.fieldId, f.context, { task, ok }, f.policy);
}
