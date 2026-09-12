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
import { logger } from "../../lib/logger.js";
import { liveEnvelope, type TripProjectionEnvelope } from "./TripProjectionEnvelope.js";
import { ok, unread, type Layer } from "./TripMapProjection.js";

const log = logger.child({ mod: "tripCompassProjection" });

/** How many plan items the context carries. The assistant's window is the reason for a cap at all. */
export const COMPASS_PLAN_ITEM_CAP = 10;

export interface CompassTripSummary {
  id: string;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
}

export interface CompassPlanItem {
  id: string;
  title: string | null;
  category: string | null;
  dayDate: string | null;
  status: string | null;
}

export interface TripCompassProjection extends TripProjectionEnvelope {
  tripId: string;
  trip: CompassTripSummary;
  planItems: Layer<CompassPlanItem>;
  /** True when more than COMPASS_PLAN_ITEM_CAP items exist and the list was cut. */
  planItemsTruncated: boolean;
}

export type CompassProjectionResult =
  | { ok: true; projection: TripCompassProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE"; message: string };

const TRIP_COLUMNS = "id, title, destination_city, destination_country, start_date, end_date, status, version";

export async function buildTripCompassProjection(
  sc: any,
  tripId: string,
  opts: { maxItems?: number; now?: Date } = {},
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

  // cap + 1 so truncation is observed, not guessed.
  const { data: items, error: itemsErr } = await sc
    .from("trip_plan_items")
    .select("id, title, category, day_date, status")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false })
    .limit(cap + 1);

  let planItems: Layer<CompassPlanItem>;
  let planItemsTruncated = false;
  if (itemsErr) {
    log.warn({ err: itemsErr.message, tripId }, "compass projection: plan items unread");
    planItems = unread("trip_plan_items could not be read");
  } else {
    const rows = ((items ?? []) as any[]);
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
      },
      planItems,
      planItemsTruncated,
    },
  };
}
