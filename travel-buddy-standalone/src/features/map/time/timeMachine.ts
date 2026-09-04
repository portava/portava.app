/**
 * timeMachine — Map spec §15 (Time Machine), the temporal layer of the map.
 *
 * WHAT THIS IS
 * ============
 * §15 gives the map temporal intelligence: it must "support historical
 * observation and future prediction, with unmistakably different visual
 * treatment", driven by a primary control (NOW, +30m, +60m, +120m) and a set of
 * later controls (Yesterday, Tonight, Tomorrow, Last Friday), optionally
 * accompanied by "a compact city timeline [showing] expected peaks and cooling
 * periods".
 *
 * §15 also states the two definitions this module exists to keep apart:
 *
 *     "Historical means observed or reconstructed from qualified historical
 *      evidence."
 *     "Forecast means predicted and must carry forecast confidence."
 *
 * and §37 states the same rule as a hard non-goal:
 *
 *     "Do not make predictions look like observations."
 *
 * WHY THE TYPES ARE SHAPED LIKE THIS
 * ==================================
 * A convention ("remember to set forecastConfidence") is not a guarantee — it
 * is a code review that has to succeed forever. So the distinction is carried
 * by the TYPE SYSTEM instead:
 *
 *   • `TemporalObject` is a three-arm discriminated union on `temporalMode`.
 *   • The forecast arm REQUIRES `forecastConfidence`, so a forecast without
 *     confidence does not compile.
 *   • The forecast arm pins `kind: 'prediction'`, so `isForecastKind()` is true
 *     downstream and the §6 "dashed boundary / predicted state" treatment is
 *     reached structurally rather than by remembering to ask for it.
 *   • The forecast arm EXCLUDES `freshness: 'live'` from its type, so
 *     "a prediction is never live" cannot be written down.
 *   • The observed arms declare `forecastConfidence?: never` and exclude
 *     `'prediction'` from `kind`, so a prediction cannot be laundered into an
 *     observation and an observation cannot borrow a forecast's confidence.
 *
 * Types stop at the wire, so `assertTemporalIntegrity()` re-checks the same
 * invariants at runtime for anything that arrives as JSON.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure. No I/O, no React, no clock reads other than the `now` a caller passes
 * (defaulted, never captured at module scope). It does not SCORE forecast
 * confidence — that is the server's job, exactly as §19 requires of every other
 * intelligence rule; this module only refuses to render a forecast that arrived
 * without one.
 *
 * @see src/types/mapObjects.ts — the canonical Map Object contract (§18).
 */

import {
  isForecastKind,
  mayRenderAsLive,
  CONFIDENCE_LABELS,
  ACTIVITY_LABELS,
  ACTIVITY_LEVELS,
  type MapObject,
  type MapObjectKind,
  type ConfidenceState,
  type FreshnessState,
  type ActivityLevel,
  type TrendState,
} from '../../../types/mapObjects.ts';

// ── Named constants (§15 tuning surface) ──────────────────────────────────────

/**
 * How far either side of `now` still reads as "now" rather than as past or
 * future. Without a tolerance, `resolveOffset(NOW)` classifies as 'historical'
 * the instant the caller's clock ticks past the value it captured.
 */
export const NOW_TOLERANCE_MS = 60_000;

/** Local hour the "Tonight" window opens. */
export const TONIGHT_START_HOUR = 18;

/** Local hour (of the FOLLOWING day) the "Tonight" window closes. */
export const TONIGHT_END_HOUR = 2;

/**
 * The instant "Tonight" stands for when the user asks before the evening has
 * begun — the middle of the going-out band, not its first minute, because
 * 18:00 answers a different question than "what will tonight be like".
 */
export const TONIGHT_ANCHOR_HOUR = 21;

/**
 * Half-width of the window a relative forecast covers. "+60m" is a claim about
 * a period around T+60, not about one instant of it; stating the width stops
 * the UI implying minute-level precision it was never given.
 */
export const RELATIVE_WINDOW_HALF_WIDTH_MINUTES = 15;

/**
 * Minimum number of QUALIFYING objects before `cityTimeline` will draw a band.
 * §15's timeline is an aggregate claim about a city; one report is an anecdote,
 * and §37 forbids letting weak claims read as established state.
 */
export const MIN_BAND_SUPPORT = 2;

/**
 * An object below this confidence band does not count toward band support at
 * all. Together with MIN_BAND_SUPPORT this makes the rule "never emit a band
 * from a single unconfirmed object" strictly stronger: unconfirmed objects
 * contribute zero support no matter how many of them there are.
 */
export const BAND_SUPPORT_MIN_CONFIDENCE: ConfidenceState = 'provisional';

/** How long a derived peak/cooling band is presented as lasting. */
export const BAND_DURATION_MINUTES = 60;

/** Most bands a compact timeline will show. Beyond this it stops being compact. */
export const MAX_TIMELINE_BANDS = 5;

/** Default look-ahead for the timeline horizon when no band reaches further. */
export const TIMELINE_HORIZON_MINUTES = 180;

/**
 * Lead time from the anchor instant to the start of the band a trend implies.
 * Faster-moving trends land sooner. `stable` has no lead because a stable zone
 * implies neither a peak nor a cooling period, and §15's timeline shows only
 * those two.
 */
export const TREND_BAND_LEAD_MINUTES: Record<TrendState, number | null> = {
  increasing_quickly: 30,
  getting_busier: 60,
  stable: null,
  cooling: 60,
  getting_quieter: 45,
  rapidly_dispersing: 20,
};

/** Which side of the timeline a trend contributes to. */
export const TREND_BAND_KIND: Record<TrendState, TimelineBandKind | null> = {
  increasing_quickly: 'peak',
  getting_busier: 'peak',
  stable: null,
  cooling: 'cooling',
  getting_quieter: 'cooling',
  rapidly_dispersing: 'cooling',
};

const MS_PER_MINUTE = 60_000;

// ── TimeOffset (the §15 control) ──────────────────────────────────────────────

/** The §15 "later controls", as a closed set rather than free-text. */
export const NAMED_OFFSETS = ['yesterday', 'tonight', 'tomorrow', 'last_friday'] as const;
export type NamedOffsetName = (typeof NAMED_OFFSETS)[number];

/**
 * What the Time Machine control is currently pointing at.
 *
 * Modelled as a discriminated union rather than a string so that "+90m" and
 * "Last Friday" cannot be confused for each other, an unknown control value
 * cannot be invented by a caller, and `resolveOffset` is total.
 */
export type TimeOffset =
  | { kind: 'now' }
  | { kind: 'relative'; minutes: number }
  | { kind: 'named'; name: NamedOffsetName };

export const NOW_OFFSET: TimeOffset = { kind: 'now' };

/** The §15 primary control row, in the order the spec lists it. */
export const PRIMARY_OFFSETS: readonly TimeOffset[] = [
  NOW_OFFSET,
  { kind: 'relative', minutes: 30 },
  { kind: 'relative', minutes: 60 },
  { kind: 'relative', minutes: 120 },
];

/** The §15 "later controls" row, in the order the spec lists it. */
export const SECONDARY_OFFSETS: readonly TimeOffset[] = NAMED_OFFSETS.map((name) => ({
  kind: 'named' as const,
  name,
}));

/** Stable identity for an offset — React keys, telemetry, equality. */
export function offsetKey(offset: TimeOffset): string {
  switch (offset.kind) {
    case 'now':
      return 'now';
    case 'relative':
      return `rel:${offset.minutes}`;
    case 'named':
      return `named:${offset.name}`;
  }
}

export function offsetsEqual(a: TimeOffset, b: TimeOffset): boolean {
  return offsetKey(a) === offsetKey(b);
}

/**
 * The §15 control's WIRE encoding for GET /api/map/projection/temporal.
 *
 * The client owns the timezone and the DST-safe calendar arithmetic, so a NAMED
 * offset (Yesterday / Tonight / Tomorrow / Last Friday) is resolved HERE into an
 * explicit [windowStartsAt, windowEndsAt] plus `at` — the server must never
 * re-derive "Last Friday" in a second, possibly-divergent place (§19: the client
 * does not reconstruct Portava's rules, but it DOES own its own clock). A NOW or
 * relative offset needs no calendar and goes as a plain `offsetMinutes`.
 *
 * Pure — kept beside the offset model rather than in the RN-coupled service so it
 * is unit-testable without a network stack.
 */
export function temporalQueryParams(offset: TimeOffset, now: Date = new Date(), tz?: string): Record<string, string> {
  if (offset.kind === 'now') return { offsetMinutes: '0' };
  if (offset.kind === 'relative') return { offsetMinutes: String(offset.minutes) };
  const resolved = resolveOffset(offset, now, tz);
  return {
    windowStartsAt: resolved.windowStartsAt.toISOString(),
    windowEndsAt: resolved.windowEndsAt.toISOString(),
    at: resolved.at.toISOString(),
  };
}

/** Display text for the control. */
export function offsetLabel(offset: TimeOffset): string {
  switch (offset.kind) {
    case 'now':
      return 'NOW';
    case 'relative': {
      const m = offset.minutes;
      if (m === 0) return 'NOW';
      const sign = m > 0 ? '+' : '−';
      const abs = Math.abs(m);
      // The spec's own vocabulary is minutes up to +120m; only beyond that does
      // an hour label read better than a four-digit minute count.
      if (abs > 120 && abs % 60 === 0) return `${sign}${abs / 60}h`;
      return `${sign}${abs}m`;
    }
    case 'named':
      switch (offset.name) {
        case 'yesterday':
          return 'Yesterday';
        case 'tonight':
          return 'Tonight';
        case 'tomorrow':
          return 'Tomorrow';
        case 'last_friday':
          return 'Last Friday';
      }
  }
}

// ── TemporalMode ──────────────────────────────────────────────────────────────

/**
 * The single source of truth for §15's distinction.
 *
 *   historical — observed, or reconstructed from qualified historical evidence
 *   now        — the present state
 *   forecast   — predicted; MUST carry forecast confidence
 */
export type TemporalMode = 'historical' | 'now' | 'forecast';

// ── Zoned calendar arithmetic ─────────────────────────────────────────────────
//
// "Tonight" and "Last Friday" are LOCAL CALENDAR questions, so they cannot be
// answered by adding milliseconds. They are answered on wall-clock fields and
// converted back to an instant afterwards, which is also what makes them
// correct across a DST transition (the wall clock is preserved; the elapsed
// milliseconds are not, and should not be).

export interface ZonedFields {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (dtfCache.has(tz)) return dtfCache.get(tz) ?? null;
  let dtf: Intl.DateTimeFormat | null = null;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Probe it: some runtimes accept the option and then ignore the zone.
    dtf.format(new Date(0));
  } catch {
    // Hermes without full-ICU, or a bad zone id. Fall back to device-local,
    // which is the honest degradation: a wrong zone would silently mis-date
    // every historical claim.
    dtf = null;
  }
  dtfCache.set(tz, dtf);
  return dtf;
}

/** Day-of-week for a calendar date, independent of any timezone. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The wall-clock fields of `date` as seen in `tz` (or device-local if absent). */
export function zonedFields(date: Date, tz?: string): ZonedFields {
  const dtf = tz ? formatterFor(tz) : null;
  if (!dtf) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      ms: date.getMilliseconds(),
      weekday: date.getDay(),
    };
  }
  const parts = dtf.formatToParts(date);
  const get = (t: string): number => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : 0;
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // 'h23' still renders midnight as 24 in some ICU versions.
  const hour = get('hour') % 24;
  return {
    year,
    month,
    day,
    hour,
    minute: get('minute'),
    second: get('second'),
    ms: date.getMilliseconds(),
    weekday: weekdayOf(year, month, day),
  };
}

/** The zone's UTC offset, in ms, at a given instant. */
function zoneOffsetMs(utcMs: number, dtf: Intl.DateTimeFormat): number {
  const f = zonedFieldsFromFormatter(new Date(utcMs), dtf);
  const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUTC - Math.floor(utcMs / 1000) * 1000;
}

function zonedFieldsFromFormatter(date: Date, dtf: Intl.DateTimeFormat): ZonedFields {
  const parts = dtf.formatToParts(date);
  const get = (t: string): number => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : 0;
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    ms: date.getMilliseconds(),
    weekday: weekdayOf(year, month, day),
  };
}

/**
 * The instant at which `tz`'s wall clock reads these fields.
 *
 * Two correction passes, which is what makes it exact across a DST boundary:
 * the first guess uses the offset at the wrong instant, the second uses the
 * offset at (very nearly) the right one.
 */
export function fromZonedFields(f: ZonedFields, tz?: string): Date {
  const dtf = tz ? formatterFor(tz) : null;
  if (!dtf) {
    return new Date(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms);
  }
  const wallAsUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms);
  let utc = wallAsUTC - zoneOffsetMs(wallAsUTC, dtf);
  utc = wallAsUTC - zoneOffsetMs(utc, dtf);
  return new Date(utc);
}

/**
 * Move a calendar date by whole days, PRESERVING the wall-clock time. Month,
 * year and leap-day boundaries come free because the date arithmetic is done in
 * UTC on the date part only.
 */
export function addCalendarDays(f: ZonedFields, days: number): ZonedFields {
  const shifted = new Date(Date.UTC(f.year, f.month - 1, f.day) + days * 86_400_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return { ...f, year, month, day, weekday: weekdayOf(year, month, day) };
}

/** Number of days to step BACK from `weekday` to reach the previous `target`. */
export function daysBackToWeekday(weekday: number, target: number): number {
  const delta = (weekday - target + 7) % 7;
  // 0 would mean "today". "Last Friday" asked ON a Friday means the previous
  // one — today is not "last" anything.
  return delta === 0 ? 7 : delta;
}

const FRIDAY = 5;

// ── resolveOffset ─────────────────────────────────────────────────────────────

/**
 * What a Time Machine control resolves to.
 *
 * `at` is the concrete instant the map should be rendered for. `windowStartsAt`
 * / `windowEndsAt` are the period that instant stands for — a named control
 * such as "Tonight" is a band, not a moment, and the UI must not imply
 * otherwise.
 */
export interface ResolvedOffset {
  offset: TimeOffset;
  at: Date;
  windowStartsAt: Date;
  windowEndsAt: Date;
  mode: TemporalMode;
  /** Display text for the resolved control, e.g. "Tonight". */
  label: string;
}

/**
 * Resolve a control to a concrete instant.
 *
 * Calendar rules, stated so they can be argued with:
 *
 *   NOW          → `now`. Window is the NOW_TOLERANCE_MS band around it.
 *   +Nm          → `now + N minutes`. Window is ±RELATIVE_WINDOW_HALF_WIDTH_MINUTES,
 *                  because a "+60m" claim covers a period, not a minute.
 *   Yesterday    → the SAME LOCAL WALL-CLOCK TIME, one calendar day earlier.
 *                  ("What was it like here at this hour yesterday" is the
 *                  question a traveler is actually asking.) Window = that whole
 *                  local day.
 *   Tomorrow     → same wall-clock time, one calendar day later. Window = that
 *                  whole local day.
 *   Last Friday  → same wall-clock time on the most recent Friday STRICTLY
 *                  BEFORE today. Asked on a Friday, that is seven days back —
 *                  today is not "last Friday". Window = that whole local day.
 *   Tonight      → the evening band [TONIGHT_START_HOUR, TONIGHT_END_HOUR next
 *                  day). If `now` already falls inside that band the control
 *                  resolves to `now` (you are in tonight; it is not a forecast).
 *                  Otherwise it resolves to TONIGHT_ANCHOR_HOUR of the evening
 *                  that is still ahead. After the band closes (02:00-18:00) the
 *                  band ahead is tonight's; before it opens on a small-hours
 *                  clock (00:00-02:00) you are still inside YESTERDAY'S band.
 *
 * `tz` is an IANA zone id. Omit it to use the device's local zone. If the
 * runtime cannot honour the zone (Hermes without full ICU) this degrades to
 * device-local rather than silently mis-dating history.
 */
export function resolveOffset(offset: TimeOffset, now: Date = new Date(), tz?: string): ResolvedOffset {
  const label = offsetLabel(offset);

  if (offset.kind === 'now') {
    return {
      offset,
      at: new Date(now.getTime()),
      windowStartsAt: new Date(now.getTime() - NOW_TOLERANCE_MS),
      windowEndsAt: new Date(now.getTime() + NOW_TOLERANCE_MS),
      mode: 'now',
      label,
    };
  }

  if (offset.kind === 'relative') {
    const at = new Date(now.getTime() + offset.minutes * MS_PER_MINUTE);
    const half = RELATIVE_WINDOW_HALF_WIDTH_MINUTES * MS_PER_MINUTE;
    return {
      offset,
      at,
      windowStartsAt: new Date(at.getTime() - half),
      windowEndsAt: new Date(at.getTime() + half),
      mode: classify(at, now),
      label,
    };
  }

  const f = zonedFields(now, tz);

  if (offset.name === 'tonight') {
    return resolveTonight(offset, f, now, tz, label);
  }

  const days = offset.name === 'yesterday' ? -1 : offset.name === 'tomorrow' ? 1 : -daysBackToWeekday(f.weekday, FRIDAY);
  const target = addCalendarDays(f, days);
  const at = fromZonedFields(target, tz);
  const dayStart = fromZonedFields({ ...target, hour: 0, minute: 0, second: 0, ms: 0 }, tz);
  const dayEnd = fromZonedFields(
    { ...addCalendarDays(target, 1), hour: 0, minute: 0, second: 0, ms: 0 },
    tz,
  );

  return {
    offset,
    at,
    windowStartsAt: dayStart,
    windowEndsAt: dayEnd,
    mode: classify(at, now),
    label,
  };
}

function resolveTonight(
  offset: TimeOffset,
  f: ZonedFields,
  now: Date,
  tz: string | undefined,
  label: string,
): ResolvedOffset {
  // Which evening band are we talking about? Before TONIGHT_END_HOUR the band
  // in progress is the one that opened YESTERDAY evening.
  const inSmallHours = f.hour < TONIGHT_END_HOUR;
  const bandDay = inSmallHours ? addCalendarDays(f, -1) : f;

  const windowStartsAt = fromZonedFields(
    { ...bandDay, hour: TONIGHT_START_HOUR, minute: 0, second: 0, ms: 0 },
    tz,
  );
  const windowEndsAt = fromZonedFields(
    { ...addCalendarDays(bandDay, 1), hour: TONIGHT_END_HOUR, minute: 0, second: 0, ms: 0 },
    tz,
  );

  const anchor = fromZonedFields(
    { ...bandDay, hour: TONIGHT_ANCHOR_HOUR, minute: 0, second: 0, ms: 0 },
    tz,
  );

  const inside = now.getTime() >= windowStartsAt.getTime() && now.getTime() < windowEndsAt.getTime();
  // Inside the band, "tonight" IS now — presenting it as a forecast would be
  // exactly the §37 confusion in reverse.
  const at = inside ? new Date(now.getTime()) : anchor;

  return { offset, at, windowStartsAt, windowEndsAt, mode: classify(at, now), label };
}

function classify(at: Date, now: Date): TemporalMode {
  const delta = at.getTime() - now.getTime();
  if (delta > NOW_TOLERANCE_MS) return 'forecast';
  if (delta < -NOW_TOLERANCE_MS) return 'historical';
  return 'now';
}

/**
 * The §15 distinction, in one call. Delegates to `resolveOffset` so there is
 * exactly one place that decides what "forecast" means.
 */
export function temporalModeOf(offset: TimeOffset, now: Date = new Date(), tz?: string): TemporalMode {
  return resolveOffset(offset, now, tz).mode;
}

// ── TemporalObject ────────────────────────────────────────────────────────────

/**
 * Every kind that is NOT a forecast. Used to make it structurally impossible
 * for a `prediction` to be carried on an observed arm of the union.
 */
export type ObservedKind = Exclude<MapObjectKind, 'prediction'>;

/** Freshness values a prediction may carry — never a live-renderable one. */
export type ForecastFreshness = Exclude<FreshnessState, 'live' | 'recent'>;

interface TemporalCommon {
  /** ISO instant this view of the object represents (`ResolvedOffset.at`). */
  resolvedAt: string;
  /** The control that produced this view, for telemetry and re-resolution. */
  temporalOffsetKey: string;
}

/** The present. Ordinary observation; no forecast confidence exists to carry. */
export type LiveTemporalObject<T = unknown> = Omit<MapObject<T>, 'kind'> &
  TemporalCommon & {
    temporalMode: 'now';
    kind: ObservedKind;
    forecastConfidence?: never;
  };

/**
 * §15: "Historical means observed or reconstructed from qualified historical
 * evidence." Freshness is pinned to 'historical' so a past view can never be
 * left wearing a live badge (§37: "Do not let stale claims remain visually
 * live").
 */
export type HistoricalTemporalObject<T = unknown> = Omit<MapObject<T>, 'kind' | 'freshness'> &
  TemporalCommon & {
    temporalMode: 'historical';
    kind: ObservedKind;
    freshness: 'historical';
    forecastConfidence?: never;
  };

/**
 * §15: "Forecast means predicted and must carry forecast confidence."
 *
 * `forecastConfidence` is REQUIRED — a forecast without it does not compile.
 * `kind` is pinned to 'prediction' so `isForecastKind()` is true downstream and
 * the §6 dashed-boundary treatment is reached structurally.
 * `observedAt` is removed outright: a prediction was never observed.
 */
export type ForecastTemporalObject<T = unknown> = Omit<
  MapObject<T>,
  'kind' | 'freshness' | 'observedAt'
> &
  TemporalCommon & {
    temporalMode: 'forecast';
    kind: 'prediction';
    forecastConfidence: ConfidenceState;
    freshness?: ForecastFreshness;
    /** ISO instant the prediction is FOR. Never an observation timestamp. */
    predictedFor: string;
  };

export type TemporalObject<T = unknown> =
  | LiveTemporalObject<T>
  | HistoricalTemporalObject<T>
  | ForecastTemporalObject<T>;

export function isForecastObject<T>(obj: TemporalObject<T>): obj is ForecastTemporalObject<T> {
  return obj.temporalMode === 'forecast';
}

export function isObservedObject<T>(
  obj: TemporalObject<T>,
): obj is LiveTemporalObject<T> | HistoricalTemporalObject<T> {
  return obj.temporalMode !== 'forecast';
}

/** Thrown by `assertTemporalIntegrity`. */
export class TemporalIntegrityError extends Error {
  readonly objectId: string | undefined;
  constructor(message: string, objectId?: string) {
    super(message);
    this.name = 'TemporalIntegrityError';
    this.objectId = objectId;
  }
}

/**
 * The runtime half of the guarantee, for the wire boundary where types do not
 * reach. Anything crossing `JSON.parse` has no type; this re-establishes the
 * same five invariants and throws rather than rendering a mislabelled object.
 *
 * Throwing is deliberate. §37's "do not make predictions look like
 * observations" is not satisfied by rendering a best-effort guess.
 */
export function assertTemporalIntegrity(obj: unknown): asserts obj is TemporalObject {
  if (obj == null || typeof obj !== 'object') {
    throw new TemporalIntegrityError('TemporalObject must be an object');
  }
  const o = obj as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : undefined;
  const mode = o.temporalMode;

  if (mode !== 'now' && mode !== 'historical' && mode !== 'forecast') {
    throw new TemporalIntegrityError(`temporalMode must be now|historical|forecast, got ${String(mode)}`, id);
  }
  if (typeof o.resolvedAt !== 'string' || Number.isNaN(Date.parse(o.resolvedAt))) {
    throw new TemporalIntegrityError('resolvedAt must be an ISO instant', id);
  }

  const kind = o.kind as MapObjectKind;

  if (mode === 'forecast') {
    if (kind !== 'prediction') {
      throw new TemporalIntegrityError(
        `a forecast must carry kind 'prediction' so it renders as a forecast, got '${String(kind)}'`,
        id,
      );
    }
    if (o.forecastConfidence == null) {
      throw new TemporalIntegrityError(
        'spec §15: a forecast must carry forecast confidence',
        id,
      );
    }
    if (mayRenderAsLive(o.freshness as FreshnessState | undefined)) {
      throw new TemporalIntegrityError(
        `a prediction is never live (freshness '${String(o.freshness)}')`,
        id,
      );
    }
    if (o.observedAt != null) {
      throw new TemporalIntegrityError('a prediction carries no observedAt — it was never observed', id);
    }
    if (typeof o.predictedFor !== 'string' || Number.isNaN(Date.parse(o.predictedFor))) {
      throw new TemporalIntegrityError('a forecast must state predictedFor', id);
    }
    return;
  }

  // Observed arms.
  if (typeof kind === 'string' && isForecastKind(kind)) {
    throw new TemporalIntegrityError(
      `a '${kind}' object cannot be presented as an observation (temporalMode '${mode}')`,
      id,
    );
  }
  if (o.forecastConfidence != null) {
    throw new TemporalIntegrityError(
      'an observation must not carry forecastConfidence — it predicts nothing',
      id,
    );
  }
  if (mode === 'historical' && o.freshness !== 'historical') {
    throw new TemporalIntegrityError(
      `a historical view must read as historical, got freshness '${String(o.freshness)}'`,
      id,
    );
  }
}

// ── toTemporalObject ──────────────────────────────────────────────────────────

export interface ToTemporalOptions {
  now?: Date;
  tz?: string;
  /**
   * Forecast confidence supplied by the projection. When absent, the object's
   * own confidence band is used; when that is absent too, the conversion
   * fails CLOSED to 'unverified' rather than implying certainty it never had.
   */
  forecastConfidence?: ConfidenceState;
}

/**
 * THE conversion point. Nothing else in the app may construct a
 * `TemporalObject`, because everything §15 and §37 promise is enforced here.
 *
 * An object becomes a forecast when EITHER the offset points into the future OR
 * the source kind is already a forecast kind — kind wins at every offset, so a
 * `prediction` viewed at "Yesterday" is still a prediction (a prediction that
 * was made about the past is a reconstruction, not an observation).
 *
 * On the forecast path:
 *   • `kind` is coerced to 'prediction', which is what makes `isForecastKind()`
 *     true downstream and gets the §6 dashed boundary from zone styling.
 *   • any live-renderable freshness is DROPPED (`mayRenderAsLive` is the test,
 *     so this tracks the contract rather than a local copy of it) — a
 *     prediction is never live.
 *   • `observedAt` is dropped — nothing observed it.
 *   • `forecastConfidence` is always present.
 *
 * On the historical path freshness is pinned to 'historical'.
 *
 * `renderingPriority` is deliberately left alone: the §31 ladder position is
 * the projection's decision (§19), and time travel is not a reason to re-rank.
 */
export function toTemporalObject<T>(
  obj: MapObject<T>,
  offset: TimeOffset,
  opts: ToTemporalOptions = {},
): TemporalObject<T> {
  const now = opts.now ?? new Date();
  const resolved = resolveOffset(offset, now, opts.tz);
  const resolvedAt = resolved.at.toISOString();
  const common: TemporalCommon = { resolvedAt, temporalOffsetKey: offsetKey(offset) };

  const forecast = resolved.mode === 'forecast' || isForecastKind(obj.kind);

  if (forecast) {
    const { observedAt: _dropped, freshness, kind: _kind, ...rest } = obj;
    void _dropped;
    void _kind;
    return {
      ...rest,
      ...common,
      temporalMode: 'forecast',
      kind: 'prediction',
      predictedFor: resolvedAt,
      forecastConfidence: opts.forecastConfidence ?? obj.confidence ?? 'unverified',
      // A prediction is never live. Anything the contract would render as live
      // is removed rather than downgraded — there is no observation to age.
      ...(mayRenderAsLive(freshness) || freshness == null
        ? {}
        : { freshness: freshness as ForecastFreshness }),
    };
  }

  if (resolved.mode === 'historical') {
    const { freshness: _f, kind, ...rest } = obj;
    void _f;
    return {
      ...rest,
      ...common,
      temporalMode: 'historical',
      kind: kind as ObservedKind,
      freshness: 'historical',
    };
  }

  const { kind, ...rest } = obj;
  return {
    ...rest,
    ...common,
    temporalMode: 'now',
    kind: kind as ObservedKind,
  };
}

/** Convenience: convert a whole projection, dropping nothing. */
export function toTemporalObjects<T>(
  objects: readonly MapObject<T>[],
  offset: TimeOffset,
  opts: ToTemporalOptions = {},
): TemporalObject<T>[] {
  return objects.map((o) => toTemporalObject(o, offset, opts));
}

// ── City timeline (§15) ───────────────────────────────────────────────────────

export type TimelineBandKind = 'peak' | 'cooling';

/**
 * One band of §15's "compact city timeline". Times are explicit ISO instants —
 * a band that only knew its offset could not be laid out honestly against a
 * historical view.
 */
export interface TimelineBand {
  id: string;
  kind: TimelineBandKind;
  startsAt: string;
  endsAt: string;
  level: ActivityLevel;
  /**
   * True when the band lies ahead of `now`. This is the §37 flag the renderer
   * hangs its dashed/hatched treatment on.
   */
  isForecast: boolean;
  /** How many qualifying objects backed this band. Always >= MIN_BAND_SUPPORT. */
  support: number;
  /** Weakest confidence among the supporting objects — fail-closed. */
  confidence: ConfidenceState;
  /** Human-readable, e.g. "Peak expected · Very Busy". */
  label: string;
}

export interface CityTimeline {
  bands: TimelineBand[];
  /** Left edge of the timeline. */
  horizonStartsAt: string;
  /** Right edge. */
  horizonEndsAt: string;
  mode: TemporalMode;
  offsetKey: string;
  /**
   * Objects that passed the confidence floor. Exposed so the UI can say
   * "not enough signal yet" instead of silently rendering an empty strip.
   */
  qualifyingObjects: number;
}

const CONFIDENCE_RANK: Record<ConfidenceState, number> = {
  unverified: 0,
  provisional: 1,
  likely_current: 2,
  live: 3,
  strong: 4,
};

/** Whether an object is strong enough to count toward a timeline band. */
export function qualifiesAsBandSupport(obj: Pick<MapObject, 'confidence' | 'trend'>): boolean {
  if (obj.confidence == null) return false;
  if (CONFIDENCE_RANK[obj.confidence] < CONFIDENCE_RANK[BAND_SUPPORT_MIN_CONFIDENCE]) return false;
  if (obj.trend == null) return false;
  return TREND_BAND_KIND[obj.trend] != null;
}

/**
 * §15: "A compact city timeline can show expected peaks and cooling periods."
 *
 * Derived from the objects' own activity + trend axes (§7) — this module scores
 * nothing, it only aggregates what the projection already decided.
 *
 * The support floor is the point of the function as much as the bands are: a
 * band is an aggregate claim about a city, so one object never makes one, and
 * an object below BAND_SUPPORT_MIN_CONFIDENCE contributes no support at all.
 */
export function cityTimeline<T>(
  objects: readonly MapObject<T>[],
  offset: TimeOffset,
  now: Date = new Date(),
  tz?: string,
): CityTimeline {
  const resolved = resolveOffset(offset, now, tz);
  const anchor = resolved.at.getTime();

  const groups = new Map<
    string,
    { kind: TimelineBandKind; lead: number; levels: ActivityLevel[]; confs: ConfidenceState[] }
  >();

  let qualifying = 0;
  for (const obj of objects) {
    if (!qualifiesAsBandSupport(obj)) continue;
    const trend = obj.trend as TrendState;
    const kind = TREND_BAND_KIND[trend];
    const lead = TREND_BAND_LEAD_MINUTES[trend];
    if (kind == null || lead == null) continue;
    qualifying += 1;
    const key = `${kind}:${lead}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind, lead, levels: [], confs: [] };
      groups.set(key, g);
    }
    if (obj.activity) g.levels.push(obj.activity);
    g.confs.push(obj.confidence as ConfidenceState);
  }

  const bands: TimelineBand[] = [];
  for (const [key, g] of groups) {
    // The support floor. Stated once, here.
    if (g.confs.length < MIN_BAND_SUPPORT) continue;

    const startsAt = new Date(anchor + g.lead * MS_PER_MINUTE);
    const endsAt = new Date(startsAt.getTime() + BAND_DURATION_MINUTES * MS_PER_MINUTE);
    const level = bandLevel(g.kind, g.levels);
    const confidence = g.confs.reduce((lo, c) => (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[lo] ? c : lo));
    const isForecast = startsAt.getTime() > now.getTime() + NOW_TOLERANCE_MS;

    bands.push({
      id: key,
      kind: g.kind,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      level,
      isForecast,
      support: g.confs.length,
      confidence,
      label: bandLabel(g.kind, level, isForecast),
    });
  }

  bands.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id < b.id ? -1 : 1));
  const shown = bands.slice(0, MAX_TIMELINE_BANDS);

  const defaultEnd = anchor + TIMELINE_HORIZON_MINUTES * MS_PER_MINUTE;
  const lastEnd = shown.reduce((mx, b) => Math.max(mx, Date.parse(b.endsAt)), defaultEnd);

  return {
    bands: shown,
    horizonStartsAt: new Date(anchor).toISOString(),
    horizonEndsAt: new Date(lastEnd).toISOString(),
    mode: resolved.mode,
    offsetKey: offsetKey(offset),
    qualifyingObjects: qualifying,
  };
}

/**
 * A peak band takes the HIGHEST level its supporters reported (that is what the
 * peak will feel like); a cooling band takes the LOWEST (that is where it is
 * heading). With no activity reported at all, 'moderate' is the neutral middle
 * rather than an implied claim in either direction.
 */
function bandLevel(kind: TimelineBandKind, levels: ActivityLevel[]): ActivityLevel {
  if (levels.length === 0) return 'moderate';
  const ranks = levels.map((l) => ACTIVITY_LEVELS.indexOf(l));
  const rank = kind === 'peak' ? Math.max(...ranks) : Math.min(...ranks);
  return ACTIVITY_LEVELS[rank];
}

function bandLabel(kind: TimelineBandKind, level: ActivityLevel, isForecast: boolean): string {
  const noun = kind === 'peak' ? 'Peak' : 'Cooling';
  const verb = isForecast ? 'expected' : 'observed';
  return `${noun} ${verb} · ${ACTIVITY_LABELS[level]}`;
}

// ── Presentation helpers ──────────────────────────────────────────────────────

/**
 * The §15 forecast badge: "Forecast · <confidence>". The confidence half is
 * NOT optional — it is what separates a forecast from an observation in the
 * spec's own definition, so the label cannot be built without it.
 */
export function forecastBadgeLabel(confidence: ConfidenceState): string {
  return `Forecast · ${CONFIDENCE_LABELS[confidence]}`;
}

/**
 * 12-hour clock text, computed from zoned fields rather than
 * `toLocaleTimeString` so the output is identical on every device locale (a
 * timeline whose two ends disagree about format is worse than one that ignores
 * locale).
 */
export function formatClock(date: Date, tz?: string): string {
  const f = zonedFields(date, tz);
  const suffix = f.hour < 12 ? 'AM' : 'PM';
  const h12 = f.hour % 12 === 0 ? 12 : f.hour % 12;
  return `${h12}:${String(f.minute).padStart(2, '0')} ${suffix}`;
}

/** One-line description of the temporal state, for the control's status row. */
export function temporalStatusLine(
  resolved: ResolvedOffset,
  forecastConfidence?: ConfidenceState,
  tz?: string,
): string {
  switch (resolved.mode) {
    case 'now':
      return 'Live · observed now';
    case 'historical':
      return `Historical · observed ${formatClock(resolved.at, tz)}`;
    case 'forecast':
      return forecastConfidence
        ? `${forecastBadgeLabel(forecastConfidence)} · ${formatClock(resolved.at, tz)}`
        : `Forecast · ${formatClock(resolved.at, tz)}`;
  }
}
