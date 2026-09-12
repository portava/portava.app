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
