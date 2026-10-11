/**
 * §7 `structured_value` rows on a creation field — the client half of census G46.
 *
 * The server parses a date, a time window, a length or a party size out of the
 * typed title with fixed rules (`lib/inputAssistance/structuredValues.ts`) and
 * offers each as a `structured_value` row whose action is `set_structured_value`.
 * This module reads those rows defensively (the value is `unknown` on the wire:
 * a malformed one is dropped, never half-applied) and turns a TAPPED one into a
 * patch for the event form's own fields. Nothing is applied without a tap, and
 * the typed title is never changed.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export interface EventTimeValue {
  kind: 'event_time';
  date: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
}
export interface PartySizeValue { kind: 'party_size'; count: number }
export interface DurationValue { kind: 'duration'; minutes: number }
export type CreationStructuredValue = EventTimeValue | PartySizeValue | DurationValue;

export interface StructuredValueChip {
  id: string;
  label: string;
  subtitle: string | null;
  value: CreationStructuredValue;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const dateOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' && DATE_RE.test(v) ? v : undefined;
const timeOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' && TIME_RE.test(v) ? v : undefined;

/** Read one wire value; `null` when it is not exactly a shape this build applies. */
export function readStructuredValue(raw: unknown): CreationStructuredValue | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (v.kind === 'party_size') {
    const n = v.count;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 500 ? { kind: 'party_size', count: n } : null;
  }
  if (v.kind === 'duration') {
    const m = v.minutes;
    return typeof m === 'number' && Number.isInteger(m) && m >= 5 && m <= 1440 ? { kind: 'duration', minutes: m } : null;
  }
  if (v.kind === 'event_time') {
    const date = dateOrNull(v.date);
    const startTime = timeOrNull(v.startTime);
    const endDate = dateOrNull(v.endDate);
    const endTime = timeOrNull(v.endTime);
    if (date === undefined || startTime === undefined || endDate === undefined || endTime === undefined) return null;
    if (date === null && startTime === null) return null;
    return { kind: 'event_time', date, startTime, endDate, endTime };
  }
  return null;
}

/** The tappable structured values in a serve, in the server's order. */
export function mapStructuredValues(suggestions: readonly InputSuggestion[] | null | undefined): StructuredValueChip[] {
  const out: StructuredValueChip[] = [];
  for (const s of suggestions ?? []) {
    if (s.type !== 'structured_value' || s.action?.type !== 'set_structured_value') continue;
    const value = readStructuredValue((s.action as { value?: unknown }).value);
    const label = (s.label ?? '').trim();
    if (!value || !label) continue;
    out.push({ id: s.id, label, subtitle: s.subtitle?.trim() || null, value });
  }
  return out;
}

/** The event form's fields a structured value may set. */
export interface EventFormTimes {
  startDateStr: string;
  startTime: string;
  endDateStr: string;
  endTime: string;
}
export type EventFormPatch = Partial<EventFormTimes> & { maxAttendees?: string };

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What tapping `value` changes on the event form, given what it holds now.
 * A duration needs a start to measure from; without one it changes nothing
 * (`null`), and the screen does not offer it.
 */
export function eventFormPatch(value: CreationStructuredValue, form: EventFormTimes): EventFormPatch | null {
  if (value.kind === 'party_size') return { maxAttendees: String(value.count) };
  if (value.kind === 'event_time') {
    const patch: EventFormPatch = {};
    if (value.date) patch.startDateStr = value.date;
    if (value.startTime) patch.startTime = value.startTime;
    if (value.endTime) {
      patch.endTime = value.endTime;
      patch.endDateStr = value.endDate ?? value.date ?? form.startDateStr;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }
  // duration: end = start + minutes, in the form's own wall clock.
  const dm = DATE_RE.test(form.startDateStr) ? form.startDateStr.split('-').map(Number) : null;
  const tm = TIME_RE.test(form.startTime) ? form.startTime.split(':').map(Number) : null;
  if (!dm || !tm) return null;
  const end = new Date(Date.UTC(dm[0]!, dm[1]! - 1, dm[2]!, tm[0]!, tm[1]! + value.minutes));
  return {
    endDateStr: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`,
    endTime: `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`,
  };
}
