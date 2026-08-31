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
