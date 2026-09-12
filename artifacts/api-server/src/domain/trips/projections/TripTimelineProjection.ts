/**
 * Trips spec §19.1 — `TripTimelineProjection`, assembled on the server.
 *
 * WHAT EXISTED
 * ============
 * `GET /trips/:tripId/plan` returns the ordered plan items and the CLIENT
 * groups them into `TimelineDay[]` (travel-buddy-standalone/src/types/
 * models.ts, rendered by TripPage.tsx). census-trips TR357 says what that is:
 * "a client-assembled day list, not a server projection with a version and a
 * freshness". Two clients grouping the same plan can disagree about which day
 * an item belongs to — the client's local time zone decides — and neither can
 * say what version of the trip it grouped.
 *
 * THE DAYS ARE THE TRIP'S, NOT THE ITEMS'
 * =======================================
 * A timeline is a statement about every day of the trip, including the ones
 * with nothing on them: "day 3 is empty" is information a list of items
 * cannot carry. So the projection emits one day per calendar date from the
 * trip's start to its end, in order, empty or not, and then any day OUTSIDE
 * that range that has items (an item dated before the trip is still real and
 * still shown — with its `dateSub` saying "before trip"). Items with no
 * `dayDate` at all are not on the timeline; they are returned under
 * `undated`, stated rather than dropped.
 *
 * Dates are `YYYY-MM-DD` labels and are compared as labels. No time zone is
 * applied to them here or anywhere: a plan item's `day_date` is the day the
 * planner named, and the label formatting below is done in UTC on purpose so
 * the same input produces the same day on every server.
 *
 * PURE. The route reads; this file groups.
 */

/** A plan item as `GET /trips/:tripId/plan` serialises it (routes/plan.ts toCamel), narrowed to what grouping needs. */
export interface TimelineInput {
  id: string;
  /** `YYYY-MM-DD` or null. */
  dayDate: string | null;
}

export interface TimelineDay<T extends TimelineInput = TimelineInput> {
  /** `YYYY-MM-DD` */
  iso: string;
  /** e.g. "Fri 12 Sep" */
  dateLabel: string;
  /** "Day 3" inside the trip's range; "Before trip" / "After trip" outside it. */
  dateSub: string;
  /** In the order the plan read returned them (day, start time, sort order). */
  items: T[];
}

export interface TripTimeline<T extends TimelineInput = TimelineInput> {
  days: TimelineDay<T>[];
  /** Items with no `dayDate`. Not on the timeline; not dropped. */
  undated: T[];
  /** How many of `days` fall inside [tripStartDate, tripEndDate]. */
  tripDayCount: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** A trip longer than this is not given one empty day per date — only the dates that carry items. */
export const MAX_SYNTHESISED_DAYS = 400;

function toUtcMs(iso: string): number | null {
  if (!DATE_RE.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}
function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dateLabelOf(iso: string): string {
  const ms = toUtcMs(iso);
  if (ms === null) return iso;
  const d = new Date(ms);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

export function buildTripTimeline<T extends TimelineInput>(
  items: readonly T[],
  range: { tripStartDate: string | null; tripEndDate: string | null },
): TripTimeline<T> {
  const byDay = new Map<string, T[]>();
  const undated: T[] = [];
  for (const it of items) {
    const d = it.dayDate;
    if (typeof d !== "string" || !DATE_RE.test(d)) { undated.push(it); continue; }
    const list = byDay.get(d) ?? [];
    list.push(it);
    byDay.set(d, list);
  }

  const startMs = range.tripStartDate ? toUtcMs(range.tripStartDate) : null;
  const endMs = range.tripEndDate ? toUtcMs(range.tripEndDate) : null;
  const dates = new Set<string>(byDay.keys());
  let tripDayCount = 0;
  if (startMs !== null && endMs !== null && endMs >= startMs) {
    const span = Math.round((endMs - startMs) / DAY_MS) + 1;
    if (span <= MAX_SYNTHESISED_DAYS) {
      for (let i = 0; i < span; i += 1) dates.add(fromUtcMs(startMs + i * DAY_MS));
    }
  }

  const ordered = [...dates].sort();
  const days: TimelineDay<T>[] = ordered.map((iso) => {
    const ms = toUtcMs(iso)!;
    let dateSub: string;
    if (startMs !== null && ms < startMs) dateSub = "Before trip";
    else if (endMs !== null && ms > endMs) dateSub = "After trip";
    else if (startMs !== null) { tripDayCount += 1; dateSub = `Day ${Math.round((ms - startMs) / DAY_MS) + 1}`; }
    else dateSub = "";
    return { iso, dateLabel: dateLabelOf(iso), dateSub, items: byDay.get(iso) ?? [] };
  });

  return { days, undated, tripDayCount };
}

// ── §7 cross-timezone multi-city: stage local time and instant order ─────────
//
// census-trips TR424: a multi-city trip's days are lived in different zones.
// Instants (`starts_at`, timestamptz) order correctly on their own — an instant
// is an instant — and the day labels above are the planner's, compared as
// labels. What was missing was the third thing: the WALL CLOCK a plan item is
// experienced at, which is the zone of the STAGE the traveller is in when it
// happens. 2760's `trip_stages.timezone` is that zone; before it, a trip had
// one `trips.timezone` for all its cities and stage local time could not be
// computed (the row's own W reason).
//
// The rule: the stage whose interval contains the item's start instant gives
// the zone. No stage contains it → the trip's own zone, and the reading says
// so. No zone at all → no local time, stated rather than guessed. The instant
// is never changed by any of this; only its rendering is.

/** 2760's `trip_stages` row, narrowed to what local time needs. */
export interface TimelineStage {
  id: string;
  sequence: number | null;
  /** IANA zone (2760: NOT NULL). */
  timezone: string;
  /** ISO instants or null. A null `endsAt` is open-ended. */
  startsAt: string | null;
  endsAt: string | null;
}

export interface StageLocalTime {
  stageId: string | null;
  stageSequence: number | null;
  /** The zone the times below are rendered in; null when there was none. */
  timezone: string | null;
  /** Wall clock `YYYY-MM-DDTHH:MM` in `timezone`; null when there is no instant or no zone. */
  localStartsAt: string | null;
  localEndsAt: string | null;
  /** Which rule produced this, in one sentence. */
  reading: string;
}

export const STAGE_LOCAL_TIME_READINGS = {
  noInstant: "no start instant: nothing to render locally",
  stage: "the stage containing the start instant gives the zone",
  tripZone: "no stage contains the start instant; the trip's own zone is used",
  noZone: "no stage contains the start instant and the trip has no zone: the instant stands as-is",
  badZone: "the zone is not one this runtime knows; the instant stands as-is",
} as const;

function instantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The stage whose [startsAt, endsAt) contains the instant; the lowest sequence when several do. */
export function stageContaining(ms: number, stages: readonly TimelineStage[]): TimelineStage | null {
  let best: TimelineStage | null = null;
  for (const s of stages) {
    const from = instantMs(s.startsAt);
    if (from === null || from > ms) continue;
    const to = instantMs(s.endsAt);
    if (to !== null && ms >= to) continue;
    if (best === null || (s.sequence ?? Infinity) < (best.sequence ?? Infinity)) best = s;
  }
  return best;
}

/** `YYYY-MM-DDTHH:MM` wall clock of an instant in an IANA zone; null when the zone is unknown to this runtime. */
export function wallClock(ms: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? null;
    const y = get("year"), mo = get("month"), d = get("day"), h = get("hour"), mi = get("minute");
    if (!y || !mo || !d || !h || !mi) return null;
    return `${y}-${mo}-${d}T${h === "24" ? "00" : h}:${mi}`;
  } catch {
    return null;
  }
}

export function stageLocalTime(
  item: { startsAt?: string | null; endsAt?: string | null },
  stages: readonly TimelineStage[],
  tripTimezone: string | null,
): StageLocalTime {
  const none = (reading: string): StageLocalTime =>
    ({ stageId: null, stageSequence: null, timezone: null, localStartsAt: null, localEndsAt: null, reading });
  const start = instantMs(item.startsAt);
  if (start === null) return none(STAGE_LOCAL_TIME_READINGS.noInstant);
  const stage = stageContaining(start, stages);
  const zone = stage ? stage.timezone : tripTimezone;
  if (!zone) return none(STAGE_LOCAL_TIME_READINGS.noZone);
  const localStartsAt = wallClock(start, zone);
  if (localStartsAt === null) return { ...none(STAGE_LOCAL_TIME_READINGS.badZone), stageId: stage?.id ?? null, stageSequence: stage?.sequence ?? null, timezone: zone };
  const end = instantMs(item.endsAt);
  return {
    stageId: stage?.id ?? null,
    stageSequence: stage?.sequence ?? null,
    timezone: zone,
    localStartsAt,
    localEndsAt: end === null ? null : wallClock(end, zone),
    reading: stage ? STAGE_LOCAL_TIME_READINGS.stage : STAGE_LOCAL_TIME_READINGS.tripZone,
  };
}

/** Every item, unchanged, plus its `local` rendering. */
export function withStageLocalTimes<T extends { startsAt?: string | null; endsAt?: string | null }>(
  items: readonly T[],
  stages: readonly TimelineStage[],
  tripTimezone: string | null,
): Array<T & { local: StageLocalTime }> {
  return items.map((it) => ({ ...it, local: stageLocalTime(it, stages, tripTimezone) }));
}

/**
 * Instant order, stable: by `startsAt` as an instant, whatever zone each was
 * entered in; items with no instant keep their relative order after the rest.
 * A day's items from the plan read are already in this order (the SQL orders
 * by starts_at); this makes the projection state it rather than inherit it.
 */
export function orderByInstant<T extends { startsAt?: string | null }>(items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i, ms: instantMs(it.startsAt) }))
    .sort((a, b) => {
      if (a.ms === null && b.ms === null) return a.i - b.i;
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      return a.ms - b.ms || a.i - b.i;
    })
    .map((x) => x.it);
}
