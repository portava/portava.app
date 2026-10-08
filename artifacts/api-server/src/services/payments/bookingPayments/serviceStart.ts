/**
 * serviceStart — WHEN a booked service begins, as an instant, for the owner's
 * refund rule (OD-PAY-5): "Give a full refund for cancellations before service
 * begins."
 *
 * A booking stores `booking_date` (date) and `start_time` (time without zone):
 * a LOCAL wall-clock time at the service location, with no zone recorded on the
 * booking. Schema truth (baseline + migrations): no `rent_buddy_bookings`,
 * `rent_buddy_profiles` or city table records the booking's zone; the one
 * city→zone source in the tree is `compass/CompassGraphEngine.ts
 * cityTimezone` — a CURATED city map first, then zones learned in this process
 * from real coordinates.
 *
 *   city zone known   the local start converted in that IANA zone (DST-correct)
 *                     — basis `city_timezone`
 *   zone unknown      the EARLIEST instant that local time can be anywhere
 *                     (read as UTC+14) — basis `earliest_possible`. Answering
 *                     "before the start" automatically only when it is true in
 *                     every zone; anything closer goes to support. Conservative
 *                     toward the buddy, so it is the fallback, not the rule.
 * Bookings created by the current routes carry `city` (required at creation)
 * and so take the first branch whenever their city is in the curated map — all
 * six launch cities are (test/rentBuddyServiceStart.test.ts).
 */
import { cityTimezone } from "../../../compass/CompassGraphEngine.js";

export type StartBasis = "city_timezone" | "earliest_possible";

export interface ServiceStart {
  readonly instant: string;
  readonly basis: StartBasis;
  readonly timezone: string | null;
}

/** The offset (ms, local − UTC) of `zone` at the UTC instant `utcMs`. Null for an unknown zone. */
export function zoneOffsetMs(zone: string, utcMs: number): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
  } catch {
    return null;
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Number.isFinite(asUtc) ? asUtc - Math.floor(utcMs / 1000) * 1000 : null;
}

/** A local wall-clock time in `zone` as a UTC instant (ms). Two passes, so a DST change between guess and answer is honoured. */
export function localToUtcMs(localAsUtcMs: number, zone: string): number | null {
  const o1 = zoneOffsetMs(zone, localAsUtcMs);
  if (o1 === null) return null;
  const guess = localAsUtcMs - o1;
  const o2 = zoneOffsetMs(zone, guess);
  if (o2 === null) return null;
  return localAsUtcMs - o2;
}

/** When the service begins, or null when the date or time is missing or malformed. */
export function serviceStartInstant(bookingDate: unknown, startTime: unknown, city: unknown): ServiceStart | null {
  if (typeof bookingDate !== "string" || typeof startTime !== "string") return null;
  const d = /^(\d{4}-\d{2}-\d{2})$/.exec(bookingDate.slice(0, 10));
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(startTime);
  if (!d || !t) return null;
  const localAsUtc = Date.parse(`${d[1]}T${t[1]}:${t[2]}:${t[3] ?? "00"}.000Z`);
  if (!Number.isFinite(localAsUtc)) return null;
  const zone = typeof city === "string" && city.trim().length > 0 ? cityTimezone(city) : null;
  if (zone) {
    const utc = localToUtcMs(localAsUtc, zone);
    if (utc !== null) return { instant: new Date(utc).toISOString(), basis: "city_timezone", timezone: zone };
  }
  return { instant: new Date(localAsUtc - 14 * 3600 * 1000).toISOString(), basis: "earliest_possible", timezone: null };
}
