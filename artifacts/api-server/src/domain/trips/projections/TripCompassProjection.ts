/**
 * Trips spec §19.1 — `TripCompassProjection`; §19.2 `GET /trips/:id/context`.
 *
 * WHAT EXISTED
 * ============
 * census-trips TR360: "Compass reads raw tables (CompassTools.ts:405-452)."
 * TR202: `get_current_trip` "selects raw rows (trip_members, trips,
 * trip_plan_items) rather than consuming a typed Trip context". The tool
 * read three tables itself, ignored every error (`{ data: items }` with no
 * `error` bound — an unreadable plan became an empty plan), and handed the
 * assistant a shape nothing else in the system produced or checked.
 *
 * THIS IS THE ONE TRIP CONTEXT
 * ============================
 * One builder, one shape, one envelope. `GET /trips/:id/context` serves it to
 * clients and compass/CompassTools.ts consumes it in-process — through
 * acceptTripProjection, the same §19.1 consumer rule a client applies — so
 * the assistant and the app describe the trip from the same object.
 *
 * The version and the trip row come from ONE read. That makes this the one
 * projection whose `sourceTripVersion` is exactly the version of the row it
 * describes, rather than a version read just before the rows; the plan items
 * are a second read and can still race a command, as everywhere.
 *
 * WHAT IT SAYS ABOUT ITSELF
 * =========================
 * `planItems` is three-valued like a map layer: `ok` with items, or `unread`
 * with the reason. The old tool could not tell "no plan" from "could not read
 * the plan", and told the assistant the first either way. `planItemsTruncated`
 * says when the cap cut the list, so "ten items" is never read as "the plan".
 *
 * NOT PURE. Two reads; the route and the Compass tool both call it.
 */
import { logger } from "../../../lib/logger.js";
import { todayInTimezone } from "../invariants/tripStatus.js";
import { liveEnvelope, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { ok, unread, type Layer } from "./TripMapProjection.js";

const log = logger.child({ mod: "tripCompassProjection" });

/**
 * How many plan items the context carries. The assistant's window is the reason
 * for a cap at all.
 *
 * A CAP IS NOT THE BUG; WHERE IT IS ANCHORED IS. Until 2026-09-14 the plan was
 * read `order(day_date asc)` from the trip's FIRST row and cut at this number,
 * so on a twenty-day trip with two items a day the tenth row is on day five —
 * and a traveller standing in day seven got a context made entirely of a
 * finished past. `planItemsTruncated` said the list was cut; nothing said that
 * what was cut was today. The window is now anchored on the focus day (see
 * `CompassPlanWindow`), so the cap spends itself on what is ahead.
 */
export const COMPASS_PLAN_ITEM_CAP = 10;

/**
 * How many plan rows the projection READS before windowing them. Distinct from
 * the cap: the cap is how many reach the assistant, this is how far the window
 * can see. A plan longer than this still truncates from the trip's start, and
 * `planWindow.scanTruncated` says so rather than letting it pass as a complete
 * window — which is exactly the shape of the defect this window exists to fix,
 * one order of magnitude further out.
 */
export const PLAN_SCAN_CAP = 400;

export interface CompassTripSummary {
  id: string;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  /**
   * The trip's IANA zone, `trips.timezone` (0077), or null when the trip has
   * none. On the projection because every day boundary in this domain is
   * decided in it (`domain/trips/invariants/tripStatus.ts` exists because two
   * copies of that rule disagreed), and the one projection whose job is to tell
   * an assistant what day it is used to carry no zone at all — so the consumer
   * guessed, and a guess at a day boundary is wrong for a few hours every day.
   */
  timezone: string | null;
}

export interface CompassPlanItem {
  id: string;
  title: string | null;
  category: string | null;
  dayDate: string | null;
  status: string | null;
}

/**
 * WHICH SLICE OF THE PLAN THE CAP WAS SPENT ON — stated, never implied.
 *
 * `focusDate` is the day the window is anchored on: "today" in the trip's own
 * zone, or an explicit `opts.focusDate`. `from` is the earliest `day_date` the
 * window admits, and `basis` says how it was chosen:
 *
 *   focus_day   the traveller is inside the trip; the window opens on today
 *   trip_start  the focus day is outside the trip (not begun, or over), so the
 *               window opens on the trip's own first day — "today" would admit
 *               nothing before the trip and everything after it
 *   all         the trip has no start date; there is no window to compute
 *
 * Undated items (`day_date IS NULL`) are ALWAYS admitted. The old ordering
 * sorted them last, which made them the first thing the cap cut; a date window
 * that excluded them would turn that into a silent drop, and "book the ryokan"
 * with no date on it is exactly the kind of open item an assistant should see.
 */
export interface CompassPlanWindow {
  focusDate: string | null;
  from: string | null;
  basis: "focus_day" | "trip_start" | "all";
  /**
   * True when the READ hit `PLAN_SCAN_CAP` — items beyond it were never
   * considered for the window, so a plan longer than that can still hide its
   * own tail. Distinct from `planItemsTruncated`, which is the cap doing its
   * job on a window that WAS fully scanned.
   */
  scanTruncated: boolean;
}

export interface TripCompassProjection extends TripProjectionEnvelope {
  tripId: string;
  trip: CompassTripSummary;
  planItems: Layer<CompassPlanItem>;
  /**
   * True when more than COMPASS_PLAN_ITEM_CAP items exist IN THE WINDOW and the
   * list was cut. It has never meant "the plan is longer than this" and means
   * it less now: `planWindow` is what says which part of the plan was read.
   */
  planItemsTruncated: boolean;
  planWindow: CompassPlanWindow;
}

export type CompassProjectionResult =
  | { ok: true; projection: TripCompassProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE"; message: string };

const TRIP_COLUMNS = "id, title, destination_city, destination_country, start_date, end_date, status, timezone, version";

export async function buildTripCompassProjection(
  sc: any,
  tripId: string,
  opts: { maxItems?: number; now?: Date; focusDate?: string } = {},
): Promise<CompassProjectionResult> {
  const cap = opts.maxItems ?? COMPASS_PLAN_ITEM_CAP;

  const { data: trip, error: tripErr } = await sc.from("trips").select(TRIP_COLUMNS).eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "compass projection: trip unreadable");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };

  const version = typeof (trip as any).version === "number" ? (trip as any).version as number : null;
  const envelope = liveEnvelope(version, opts.now);

  const t0 = trip as any;
  const startDate: string | null = t0.start_date ? String(t0.start_date).slice(0, 10) : null;
  const endDate:   string | null = t0.end_date   ? String(t0.end_date).slice(0, 10)   : null;
  const timezone:  string | null = t0.timezone ?? null;

  // The focus day, in the TRIP's zone — not the server's and not UTC.
  const focusDate = opts.focusDate ?? todayInTimezone(timezone, opts.now ?? new Date());
  const planWindow: CompassPlanWindow = !startDate
    ? { focusDate, from: null, basis: "all", scanTruncated: false }
    : focusDate < startDate || (endDate !== null && focusDate > endDate)
      ? { focusDate, from: startDate, basis: "trip_start", scanTruncated: false }
      : { focusDate, from: focusDate, basis: "focus_day", scanTruncated: false };

  // THE QUERY IS DELIBERATELY UNCHANGED — same columns, same filters, same
  // order, only a wider `limit`. The window is applied in JS afterwards.
  //
  // It was first written as `.or("day_date.gte.<from>,day_date.is.null")`,
  // which is the natural PostgREST form and which broke a Compass suite inside
  // the hour: its fake client implements `eq`/`is`/`order`/`limit` and not
  // `or`, so `q.or is not a function` came out of a projection the test was not
  // about. A shared projection that introduces a new operator breaks every fake
  // in the repository that never needed it, and the operator buys nothing here:
  // the scan is bounded either way and the window is three comparisons.
  const { data: items, error: itemsErr } = await sc
    .from("trip_plan_items")
    .select("id, title, category, day_date, status")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false })
    .limit(PLAN_SCAN_CAP + 1);

  let planItems: Layer<CompassPlanItem>;
  let planItemsTruncated = false;
  if (itemsErr) {
    log.warn({ err: itemsErr.message, tripId }, "compass projection: plan items unread");
    planItems = unread("trip_plan_items could not be read");
  } else {
    const scanned = ((items ?? []) as any[]);
    planWindow.scanTruncated = scanned.length > PLAN_SCAN_CAP;
    // Undated items are ALWAYS admitted: the old ordering sorted them last,
    // which made them the first thing the cap cut, and a date window that
    // excluded them would turn that into a silent drop.
    // `dayOf` FIRST, then compare. Writing this as
    // `r.day_date == null || String(r.day_date) >= from` also works, and works
    // BY ACCIDENT: `String(null)` is "null", which sorts after every
    // "2026-.."" date, so deleting the null guard changed no behaviour and no
    // test went red when that mutation was run. A guard that cannot be shown to
    // matter is not a guard. Narrowed to a real `null` so the intent and the
    // behaviour are the same thing.
    const dayOf = (r: any): string | null => (r.day_date == null ? null : String(r.day_date).slice(0, 10));
    const from = planWindow.from;
    const rows = from === null
      ? scanned.slice(0, PLAN_SCAN_CAP)
      : scanned.slice(0, PLAN_SCAN_CAP).filter((r) => { const d = dayOf(r); return d === null || d >= from; });
    planItemsTruncated = rows.length > cap;
    planItems = ok(rows.slice(0, cap).map((r) => ({
      id: String(r.id), title: r.title ?? null, category: r.category ?? null,
      dayDate: r.day_date ?? null, status: r.status ?? null,
    })));
  }

  const t = trip as any;
  return {
    ok: true,
    projection: {
      ...envelope,
      tripId,
      trip: {
        id: String(t.id), title: t.title ?? null,
        destinationCity: t.destination_city ?? null, destinationCountry: t.destination_country ?? null,
        startDate: t.start_date ?? null, endDate: t.end_date ?? null, status: t.status ?? null,
        timezone,
      },
      planItems,
      planItemsTruncated,
      planWindow,
    },
  };
}
