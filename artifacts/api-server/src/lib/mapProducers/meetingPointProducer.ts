/**
 * meetingPointProducer — the `meeting_point` kind (Map spec §6 "Checkpoint pin
 * = Meeting point", §11 Trip Map "meeting points", §12 "temporary and
 * auto-expiring").
 *
 * WHERE A MEETING POINT'S GEOMETRY COMES FROM — AND WHERE IT CANNOT
 * ==================================================================
 * Three records in this repository describe a meeting, and only one of them
 * carries a coordinate:
 *
 *   meetups (routes/meetups.ts)        NO. Hard rule in that file's header:
 *                                      "No lat/lng on meetups — text
 *                                      location_name only". POST /api/meetups
 *                                      persists a title, a time and a label,
 *                                      and that is why it "never projects
 *                                      back": there is nothing to place.
 *   circle_meeting_points (0108)       NO. Labels only in V1 — the GET route's
 *                                      own comment: "public_lat / public_lng
 *                                      columns not yet in schema — always
 *                                      null."
 *   trip_plan_items (0010)             YES. POST /api/meetups/:id/add-to-trip-
 *                                      plan (routes/plan.ts) writes a plan item
 *                                      with category='meeting_point' and
 *                                      source_type='meetup', and a plan item
 *                                      carries lat/lng + location_is_private
 *                                      (trips.ts CreatePlanItemSchema). Members
 *                                      can also create a meeting_point item by
 *                                      hand.
 *
 * So THIS is the meeting-point record the map projects: a trip plan item of
 * category `meeting_point`. A meetup that has not been placed on a trip plan
 * has no coordinate and is not projected. Nothing here geocodes
 * `location_name` — putting a pin where a string says "the fountain" is the
 * invented location §19 forbids, and a wrong meeting point is worse than none.
 *
 * PARTICIPANTS ONLY
 * =================
 * The read is scoped to the trips the viewer belongs to, using the predicate
 * trip_plan_items' OWN row-level policy uses (0010 plan_items_select:
 * `tm.role IN ('owner','member')`), tightened to accepted membership where a
 * status is recorded, plus the trip's owner_id — the owner is not always given
 * a trip_members row (lib/http.requireTripMember explains). The result is the
 * set of people who can already read the plan item through PostgREST; this
 * producer widens nothing. A non-member sees no object, not a coarse one.
 *
 * PRIVACY CLASS
 * =============
 * `place_level`. The coordinate is a venue the organiser chose — not a
 * person's position — and the audience is the trip's own members, which is
 * exactly §23's "Trip Crew" rung. `location_is_private` items are DROPPED, not
 * coarsened: routes/trips.ts already nulls their coordinate for every reader,
 * and the map must not disagree with the trip surface about a private spot.
 *
 * TTL
 * ===
 * `expiresAt` is `ends_at`, or `starts_at` + MEETING_POINT_GRACE_MINUTES when
 * no end is recorded (a late arrival still needs the pin). An item with no
 * `starts_at` has no meeting time to expire to and is not a temporary object
 * (§12) — it is skipped and counted, never served open-ended. Expired items are
 * dropped here rather than left for the client to age out.
 *
 * A CANCELLED MEETUP IS NOT A MEETING POINT. Cancelling a meetup (DELETE
 * /api/meetups/:id) flips meetups.status and leaves the plan item standing, so
 * meetup-sourced items are cross-checked against the meetup row and dropped
 * when it is cancelled. If that check cannot be read, every meetup-sourced item
 * is withheld — fail-closed, and reported.
 */
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import type { BBox } from "../mapAggregation.js";

export const MEETING_POINT_PRIVACY_CLASS: PrivacyClass = "place_level";

/** How long after `starts_at` a meeting point with no `ends_at` stays on the map. */
export const MEETING_POINT_GRACE_MINUTES = 60;

/** Roles that may read a trip's plan items (0010 plan_items_select). */
export const MEETING_POINT_MEMBER_ROLES: readonly string[] = ["owner", "member"];

/** Bounded: a viewer with more meeting points in one viewport than this has a different problem. */
const MAX_MEETING_POINT_ROWS = 200;

/** The trip_plan_items columns this producer reads. */
export interface MeetingPointItemLike {
  id: string;
  trip_id: string;
  title?: string | null;
  category?: string | null;
  status?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  location_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  location_is_private?: boolean | null;
  lock_type?: string | null;
  removed_at?: string | null;
}

export type MeetingPointSkipReason =
  | "not_meeting_point"
  | "removed"
  | "cancelled"
  | "private_location"
  | "no_coordinate"
  | "undated"
  | "expired";

function toMs(v: unknown): number | null {
  if (v == null) return null;
  const ms = new Date(String(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The instant a meeting point stops being current, or null when it has no time. */
export function meetingPointExpiryMs(item: MeetingPointItemLike): number | null {
  const start = toMs(item.starts_at);
  if (start === null) return null;
  const end = toMs(item.ends_at);
  if (end !== null && end > start) return end;
  return start + MEETING_POINT_GRACE_MINUTES * 60_000;
}

/** "2026-09-04T18:00:00" → "2026-09-04 18:00". The stored value, not a re-zoned one. */
function whenLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const s = String(iso);
  if (s.length < 16) return s;
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}

/**
 * Project one plan item the caller has ALREADY scoped to the viewer's trips.
 * Pure. Returns the object, or the reason it must not render.
 */
export function projectMeetingPoint(
  item: MeetingPointItemLike,
  opts: { now: number },
): { object: MapObject; skipped?: undefined } | { object?: undefined; skipped: MeetingPointSkipReason } {
  if (!item || item.category !== "meeting_point") return { skipped: "not_meeting_point" };
  if (item.removed_at != null) return { skipped: "removed" };
  if (item.status === "cancelled") return { skipped: "cancelled" };
  if (item.location_is_private === true) return { skipped: "private_location" };
  const lat = item.lat;
  const lng = item.lng;
  if (
    typeof lat !== "number" || typeof lng !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180
  ) {
    return { skipped: "no_coordinate" };
  }
  const expiresMs = meetingPointExpiryMs(item);
  if (expiresMs === null) return { skipped: "undated" };
  if (expiresMs <= opts.now) return { skipped: "expired" };

  return {
    object: {
      id: `meeting_point:${item.id}`,
      kind: "meeting_point",
      geometry: point(lat, lng),
      title: item.title && String(item.title).trim() !== "" ? String(item.title) : "Meeting point",
      subtitle: joinParts([item.location_name, whenLabel(item.starts_at)], " · ") ?? undefined,
      // A plan is not an observation of conditions at the place: no observedAt,
      // no freshness, no confidence (§37). The TTL is the plan's own clock.
      expiresAt: new Date(expiresMs).toISOString(),
      privacyClass: MEETING_POINT_PRIVACY_CLASS,
      renderingPriority: KIND_DEFAULT_PRIORITY.meeting_point,
      interaction: {
        actions: ["view", "navigate", "share"],
        detailRoute: `/trip/${item.trip_id}`,
        opensSheet: true,
      },
      payload: {
        tripId: item.trip_id,
        planItemId: item.id,
        sourceType: item.source_type ?? null,
        // The meetup id when the item came from POST /meetups/:id/add-to-trip-plan.
        meetupId: item.source_type === "meetup" ? (item.source_id ?? null) : null,
        startsAt: item.starts_at ?? null,
        endsAt: item.ends_at ?? null,
        status: item.status ?? null,
        locationName: item.location_name ?? null,
        lockType: item.lock_type ?? null,
      },
    },
  };
}

export interface MeetingPointReport {
  /** Trips the viewer may read plan items for. */
  trips: number;
  /** meeting_point rows read for those trips inside the viewport. */
  candidates: number;
  skipped: Record<MeetingPointSkipReason, number>;
  /** Meetup-sourced items dropped because the meetup itself is cancelled. */
  cancelledMeetups: number;
  /** True when the meetup cross-check could not be read (its items withheld). */
  meetupReadFailed: boolean;
}

export type MeetingPointReadResult =
  | { ok: true; points: MapObject[]; report: MeetingPointReport }
  | { ok: false; reason: "membership_read_failed" | "items_read_failed" };

function emptyReport(): MeetingPointReport {
  return {
    trips: 0,
    candidates: 0,
    skipped: {
      not_meeting_point: 0, removed: 0, cancelled: 0, private_location: 0,
      no_coordinate: 0, undated: 0, expired: 0,
    },
    cancelledMeetups: 0,
    meetupReadFailed: false,
  };
}

/**
 * The trips whose plan items this viewer may read. Null on a read failure —
 * an unreadable membership table is not an empty one, and the layer must say
 * so rather than serve an empty trip list as fact.
 */
async function loadParticipantTripIds(sc: any, viewerId: string): Promise<string[] | null> {
  const { data: memberRows, error: memErr } = await sc
    .from("trip_members")
    .select("trip_id, role, status")
    .eq("user_id", viewerId)
    .in("role", MEETING_POINT_MEMBER_ROLES as string[]);
  if (memErr) return null;

  const { data: ownedRows, error: ownErr } = await sc
    .from("trips")
    .select("id")
    .eq("owner_id", viewerId);
  if (ownErr) return null;

  const ids = new Set<string>();
  for (const r of (memberRows ?? []) as any[]) {
    // Accepted membership where a status is recorded (lib/http.requireTripMember).
    if (r.status != null && r.status !== "accepted") continue;
    if (typeof r.trip_id === "string" && r.trip_id !== "") ids.add(r.trip_id);
  }
  for (const r of (ownedRows ?? []) as any[]) {
    if (typeof r.id === "string" && r.id !== "") ids.add(r.id);
  }
  return [...ids];
}

/**
 * Read the viewer's meeting points inside a viewport. The ONE privacy-complete
 * meeting-point read; routes/mapProjection.ts is its only approved caller
 * (src/test/gatewayBypassGuard.test.ts).
 */
export async function readMeetingPoints(
  sc: any,
  viewerId: string,
  opts: { bbox: BBox; now: number },
): Promise<MeetingPointReadResult> {
  const report = emptyReport();

  const tripIds = await loadParticipantTripIds(sc, viewerId);
  if (tripIds === null) return { ok: false, reason: "membership_read_failed" };
  report.trips = tripIds.length;
  if (tripIds.length === 0) return { ok: true, points: [], report };

  const { bbox } = opts;
  const { data, error } = await sc
    .from("trip_plan_items")
    .select(
      "id, trip_id, title, category, status, source_type, source_id, starts_at, ends_at, location_name, lat, lng, location_is_private, lock_type, removed_at",
    )
    .in("trip_id", tripIds)
    .eq("category", "meeting_point")
    .is("removed_at", null)
    .neq("status", "cancelled")
    .not("lat", "is", null)
    .not("lng", "is", null)
    .gte("lat", bbox.south)
    .lte("lat", bbox.north)
    .gte("lng", bbox.west)
    .lte("lng", bbox.east)
    .limit(MAX_MEETING_POINT_ROWS);
  if (error || !Array.isArray(data)) return { ok: false, reason: "items_read_failed" };

  const items = data as MeetingPointItemLike[];
  report.candidates = items.length;

  // A cancelled meetup leaves its plan item standing — cross-check the source.
  const meetupIds = [
    ...new Set(
      items
        .filter((i) => i.source_type === "meetup" && typeof i.source_id === "string" && i.source_id !== "")
        .map((i) => i.source_id as string),
    ),
  ];
  let cancelledMeetups = new Set<string>();
  let meetupReadFailed = false;
  if (meetupIds.length > 0) {
    const { data: meetupRows, error: meetupErr } = await sc
      .from("meetups")
      .select("id, status")
      .in("id", meetupIds);
    if (meetupErr || !Array.isArray(meetupRows)) {
      meetupReadFailed = true;
    } else {
      cancelledMeetups = new Set(
        (meetupRows as any[]).filter((m) => m.status === "cancelled").map((m) => String(m.id)),
      );
    }
  }
  report.meetupReadFailed = meetupReadFailed;

  const points: MapObject[] = [];
  for (const item of items) {
    if (item.source_type === "meetup") {
      // Fail-closed: when the meetup table could not be read, a meetup-sourced
      // item might be cancelled and cannot be shown.
      if (meetupReadFailed) { report.skipped.cancelled += 1; continue; }
      if (item.source_id && cancelledMeetups.has(String(item.source_id))) {
        report.cancelledMeetups += 1;
        report.skipped.cancelled += 1;
        continue;
      }
    }
    const projected = projectMeetingPoint(item, { now: opts.now });
    if (projected.skipped) { report.skipped[projected.skipped] += 1; continue; }
    points.push(projected.object);
  }

  return { ok: true, points, report };
}
