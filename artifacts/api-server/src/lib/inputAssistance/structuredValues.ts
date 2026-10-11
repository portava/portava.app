/**
 * §7 `structured_value` — deterministic structured values parsed out of what the
 * person typed (census-input-intelligence G46).
 *
 * WHAT IT DOES. An event title such as "Rooftop drinks Fri 8-11pm for 6 people"
 * already CONTAINS a date, a time window and a party size. This module reads
 * them with fixed rules — no model, no provider, nothing guessed — and offers
 * each as a `structured_value` row whose action is the existing
 * `set_structured_value`. The creation screen applies the value to its own
 * date/time and capacity fields only when the person taps it; nothing is
 * filled in silently, and the typed title is never changed.
 *
 * WHAT IT REFUSES TO DO, by construction:
 *   - a bare number is never a time ("8" is not 8 PM) and never a party size;
 *   - "in 2 hours" is a relative time, not a duration;
 *   - an hour or minute out of range, a 13 PM, a 31 February → no value at all;
 *   - two different dates (or two time windows) in one text → no value of that
 *     kind (ambiguity is not resolved by picking one, §19);
 *   - party sizes outside 1–500 → none.
 * Values are WALL-CLOCK (date `YYYY-MM-DD`, time `HH:mm`) in the request's
 * timezone, because the form composes them in the event's own zone — an
 * instant here would be converted twice.
 *
 * GATES (gateway.ts): the field policy must declare `structured_value`, the
 * context must be one whose screen applies the value
 * ({@link STRUCTURED_VALUE_CONTEXTS}), and the flag
 * `input_structured_values_enabled` (migration 3690, seeded FALSE) must be ON.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../featureFlags';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';

export const INPUT_STRUCTURED_VALUES_FLAG = 'input_structured_values_enabled';

/** Contexts whose screen applies a structured value (app/events/create applies event_title's). */
export const STRUCTURED_VALUE_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['event_title']);

export interface EventTimeValue {
  kind: 'event_time';
  /** Local date, or null when only a time was typed. */
  date: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
}
export interface PartySizeValue { kind: 'party_size'; count: number }
export interface DurationValue { kind: 'duration'; minutes: number }
export type StructuredValue = EventTimeValue | PartySizeValue | DurationValue;

// ── Clock ─────────────────────────────────────────────────────────────────────

interface LocalToday { y: number; m: number; d: number; dow: number }

function localToday(now: Date, tz: string | null | undefined): LocalToday {
  let parts: Record<string, string> = {};
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
    parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  } catch {
    return localToday(now, 'UTC');
  }
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), dow: DOW[parts.weekday ?? 'Sun'] ?? 0 };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function addDays(t: LocalToday, days: number): string {
  const dt = new Date(Date.UTC(t.y, t.m - 1, t.d + days));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

const WEEKDAY_RE: Array<[RegExp, number]> = [
  // "sun" and "sat" are ordinary words ("beach and sun", "we sat"), so only the full names count.
  [/\bsunday\b/, 0], [/\b(?:monday|mon)\b/, 1], [/\b(?:tuesday|tues|tue)\b/, 2],
  [/\b(?:wednesday|weds|wed)\b/, 3], [/\b(?:thursday|thurs|thur|thu)\b/, 4],
  [/\b(?:friday|fri)\b/, 5], [/\bsaturday\b/, 6],
];
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g');
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\b`, 'g');

/** Every date the text names, as local `YYYY-MM-DD`. Distinct values only. */
function extractDates(text: string, today: LocalToday): string[] {
  const out = new Set<string>();
  if (/\b(?:today|tonight)\b/.test(text)) out.add(addDays(today, 0));
  if (/\btomorrow\b/.test(text)) out.add(addDays(today, 1));
  for (const [re, dow] of WEEKDAY_RE) {
    if (re.test(text)) out.add(addDays(today, (dow - today.dow + 7) % 7));
  }
  const monthDay = (mName: string, dStr: string) => {
    const m = MONTHS[mName.toLowerCase()];
    const d = Number(dStr);
    if (!m) return;
    // The next occurrence: this year unless it has already passed.
    let y = today.y;
    if (m < today.m || (m === today.m && d < today.d)) y += 1;
    if (validDate(y, m, d)) out.add(ymd(y, m, d));
    else out.add('invalid'); // a named but impossible date poisons the kind (no guessing)
  };
  for (const m of text.matchAll(MONTH_DAY_RE)) monthDay(m[1]!, m[2]!);
  for (const m of text.matchAll(DAY_MONTH_RE)) monthDay(m[2]!, m[1]!);
  return [...out];
}

// ── Times ─────────────────────────────────────────────────────────────────────

interface ClockTime { h: number; min: number; meridiem: 'am' | 'pm' | null; h24: boolean }

const T = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const RANGE_RE = new RegExp(String.raw`\b(?:from\s+)?${T}\s*(?:-|–|—|to|until|till)\s*${T}(?=$|[^\w:])`, 'g');
const SINGLE_RE = new RegExp(String.raw`\b(?:at\s+|@\s*)?${T}(?=$|[^\w:])`, 'g');

function readClock(hStr: string, mStr: string | undefined, mer: string | undefined): ClockTime | null {
  const h = Number(hStr);
  const min = mStr === undefined ? 0 : Number(mStr);
  if (!Number.isInteger(h) || !Number.isInteger(min) || min > 59) return null;
  const meridiem = mer ? (mer.startsWith('a') ? 'am' : 'pm') : null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    return { h, min, meridiem, h24: false };
  }
  // No meridiem: only an unmistakable 24-hour clock ("20:00", "08:30") is a time
  // on its own. "8:30" could be morning or evening, so it is not one.
  if (mStr === undefined || h > 23 || (h < 13 && hStr.length < 2)) return { h, min, meridiem: null, h24: false };
  return { h, min, meridiem: null, h24: true };
}

function to24(t: ClockTime, meridiem: 'am' | 'pm' | null): { h: number; min: number } | null {
  if (t.h24) return { h: t.h, min: t.min };
  const mer = t.meridiem ?? meridiem;
  if (!mer) return null;
  if (t.h < 1 || t.h > 12) return null;
  const h = mer === 'am' ? (t.h === 12 ? 0 : t.h) : (t.h === 12 ? 12 : t.h + 12);
  return { h, min: t.min };
}

const hm = (t: { h: number; min: number }) => `${pad(t.h)}:${pad(t.min)}`;

interface Window { start: { h: number; min: number }; end: { h: number; min: number } | null }

/** Every time or time window the text names. A bare number is never one. */
function extractTimes(text: string): { windows: Window[]; spans: Array<[number, number]>; implausible: boolean } {
  let implausible = false;
  const windows: Window[] = [];
  const spans: Array<[number, number]> = [];
  const taken = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(RANGE_RE)) {
    const a = readClock(m[1]!, m[2], m[3]);
    const b = readClock(m[4]!, m[5], m[6]);
    if (!a || !b) continue;
    let end = to24(b, null);
    if (!end) continue;
    // "8-11pm": the start inherits the end's meridiem unless that puts it after the end.
    let start = to24(a, b.meridiem);
    if (start && !a.meridiem && !a.h24 && b.meridiem && start.h * 60 + start.min > end.h * 60 + end.min) {
      start = to24(a, b.meridiem === 'pm' ? 'am' : 'pm');
    }
    if (!start) continue;
    // V-IN F8: a window that wraps past midnight is believable only when short ("10pm-2am");
    // "8pm-7pm" (23 h) or "8pm-8pm" says nothing we can trust, so the time is refused.
    const s0 = start.h * 60 + start.min, e0 = end.h * 60 + end.min;
    if (e0 <= s0 && (e0 + 1440 - s0 === 1440 || e0 + 1440 - s0 > 12 * 60)) {
      implausible = true;
      spans.push([m.index!, m.index! + m[0].length]);
      continue;
    }
    windows.push({ start, end });
    spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(SINGLE_RE)) {
    if (taken(m.index!)) continue;
    const c = readClock(m[1]!, m[2], m[3]);
    if (!c) continue;
    // "at 8" alone is still not a time: to24 refuses without a meridiem or a 24-hour clock.
    const t = to24(c, null);
    if (!t) continue;
    windows.push({ start: t, end: null });
    spans.push([m.index!, m.index! + m[0].length]);
  }
  if (/\bnoon\b/.test(text)) windows.push({ start: { h: 12, min: 0 }, end: null });
  if (/\bmidnight\b/.test(text)) windows.push({ start: { h: 0, min: 0 }, end: null });
  return { windows, spans, implausible };
}

// ── Duration and party size ──────────────────────────────────────────────────

// The lookbehind keeps "in 2 hours" (a time, not a length) out. A bare "m" is not a unit: "5 m" is as likely metres (V-IN F8).
const DURATION_RE = /(?<!\bin\s)\b(?:for\s+)?(\d{1,2}(?:\.\d)?|an?|one|two|three|four|five|six)\s*(hours?|hrs?|h|minutes?|mins?)\b(?!\s*(?:ago|from now))/g;
const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function extractDurations(text: string, timeSpans: Array<[number, number]>): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(DURATION_RE)) {
    if (timeSpans.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : WORD_NUM[m[1]!.toLowerCase()] ?? NaN;
    const unit = m[2]!.toLowerCase();
    const minutes = unit.startsWith('h') ? Math.round(n * 60) : Math.round(n);
    if (Number.isFinite(minutes) && minutes >= 5 && minutes <= 24 * 60) out.add(minutes);
  }
  return [...out];
}

const PARTY_RES: RegExp[] = [
  /\b(?:for\s+)?(\d{1,3})\s*(?:people|persons|ppl|guests|pax|travell?ers|friends)\b/g,
  /\b(?:party|group|table)\s+of\s+(\d{1,3})\b/g,
];

function extractPartySizes(text: string): number[] {
  const out = new Set<number>();
  for (const re of PARTY_RES) for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 500) out.add(n);
  }
  return [...out];
}

// ── The parse ─────────────────────────────────────────────────────────────────

/**
 * The structured values one text names, each kind at most once. A kind the text
 * names twice with different values is dropped (ambiguous, §19).
 */
export function parseStructuredValues(text: string, opts: { tz?: string | null; now?: Date } = {}): StructuredValue[] {
  const raw = (text ?? '').slice(0, 300).toLowerCase();
  if (!raw.trim()) return [];
  const today = localToday(opts.now ?? new Date(), opts.tz);
  const out: StructuredValue[] = [];

  const dates = extractDates(raw, today);
  const { windows, spans, implausible } = extractTimes(raw);
  const durations = extractDurations(raw, spans);
  const dateAmbiguous = dates.length > 1 || dates.includes('invalid');
  const date = dates[0] ?? null; // read only when !dateAmbiguous
  const win = windows.length === 1 ? windows[0]! : null;
  const timeAmbiguous = windows.length > 1 || implausible;

  if (!dateAmbiguous && !timeAmbiguous && (date || win)) {
    let endTime: string | null = win?.end ? hm(win.end) : null;
    let endDate: string | null = null;
    let usedDuration = false;
    if (win && !win.end && durations.length === 1) {
      const total = win.start.h * 60 + win.start.min + durations[0]!;
      endTime = hm({ h: Math.floor(total / 60) % 24, min: total % 60 });
      if (date && total >= 24 * 60) {
        const [y, m, d] = date.split('-').map(Number);
        endDate = addDays({ y: y!, m: m!, d: d!, dow: 0 }, 1);
      }
      usedDuration = true;
    }
    if (win?.end && date && win.end.h * 60 + win.end.min <= win.start.h * 60 + win.start.min) {
      const [y, m, d] = date.split('-').map(Number);
      endDate = addDays({ y: y!, m: m!, d: d!, dow: 0 }, 1); // "10pm-2am" ends the next day
    }
    if (date && endTime && !endDate) endDate = date;
    out.push({ kind: 'event_time', date, startTime: win ? hm(win.start) : null, endDate, endTime });
    if (!usedDuration && durations.length === 1) out.push({ kind: 'duration', minutes: durations[0]! });
  } else if (durations.length === 1) {
    out.push({ kind: 'duration', minutes: durations[0]! });
  }

  const sizes = extractPartySizes(raw);
  if (sizes.length === 1) out.push({ kind: 'party_size', count: sizes[0]! });
  return out;
}

// ── Labels ────────────────────────────────────────────────────────────────────

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return `${DOW_NAMES[dt.getUTCDay()]} ${d} ${MONTH_NAMES[m! - 1]}`;
}

function timeLabel(t: string): string {
  const [h, min] = t.split(':').map(Number);
  const mer = h! < 12 ? 'AM' : 'PM';
  const h12 = h! % 12 === 0 ? 12 : h! % 12;
  return `${h12}:${pad(min!)} ${mer}`;
}

function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

export function structuredValueLabel(v: StructuredValue): { label: string; subtitle: string } {
  if (v.kind === 'party_size') return { label: `${v.count} ${v.count === 1 ? 'person' : 'people'}`, subtitle: 'Set as the capacity' };
  if (v.kind === 'duration') return { label: durationLabel(v.minutes), subtitle: 'Set as the length' };
  const parts: string[] = [];
  if (v.date) parts.push(dateLabel(v.date));
  if (v.startTime) parts.push(v.endTime ? `${timeLabel(v.startTime)} – ${timeLabel(v.endTime)}` : timeLabel(v.startTime));
  return { label: parts.join(' · '), subtitle: v.date && v.startTime ? 'Set as the date and time' : v.date ? 'Set as the date' : 'Set as the time' };
}

/** Does this field's policy and context admit structured-value rows? (flag checked separately) */
export function policyAdmitsStructuredValues(context: InputContext, policy: InputFieldPolicy): boolean {
  return STRUCTURED_VALUE_CONTEXTS.has(context) && (policy.allowedSuggestionTypes ?? []).includes('structured_value');
}

/** The `structured_value` rows for one serve. Empty unless every gate passes. */
export async function buildStructuredValueRows(
  sc: SupabaseClient,
  opts: { context: InputContext; policy: InputFieldPolicy; text: string; tz?: string | null; policyVersion: string; now?: Date },
): Promise<InputSuggestion[]> {
  if (!policyAdmitsStructuredValues(opts.context, opts.policy)) return [];
  const values = parseStructuredValues(opts.text, { tz: opts.tz, now: opts.now });
  if (values.length === 0) return [];
  if (!(await isFlagEnabled(sc, INPUT_STRUCTURED_VALUES_FLAG))) return [];
  return values.map((value) => {
    const { label, subtitle } = structuredValueLabel(value);
    return {
      id: `${opts.context}:structured_value:${value.kind}:${JSON.stringify(value)}`,
      type: 'structured_value' as const,
      context: opts.context,
      label,
      subtitle,
      action: { type: 'set_structured_value' as const, value },
      structuredValue: value,
      confidence: 0.7,
      source: 'local' as const,
      reason: 'From what you typed',
      policyVersion: opts.policyVersion,
    };
  });
}
