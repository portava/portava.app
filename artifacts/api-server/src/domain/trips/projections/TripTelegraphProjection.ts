/**
 * Trips spec §1 / §19.1 — the Trip context a CONVERSATION may consume
 * (census-trips TR5).
 *
 * WHY THIS FILE EXISTS
 * ====================
 * TR5 says Trips owns context distribution, as *"stable typed projections for
 * Compass, Map, Telegraph, Discovery, Safety, Passport, Memory"*. Six of those
 * seven have had one since §40–§54 — `TripCompassProjection`,
 * `TripMapProjection`, `tripDiscoveryProjection`, `TripSafetyProjection`,
 * `TripPassportProjection`, `TripMemoryProjection`. Telegraph had none, and the
 * row has read BUILT-BUT-WRONG since the first census for that reason.
 *
 * WHAT A CONVERSATION IS ALLOWED TO KNOW
 * ======================================
 * A thread attached to a trip needs four things and no more: whether the
 * viewer may see the trip at all, WHICH PEOPLE IN THIS CONVERSATION are on it
 * (so the thread can address them without leaking the rest of the crew), what
 * is happening now and next (so a suggestion can be judged against the day),
 * and whether the §17.2 switch says a commercial suggestion is unwelcome right
 * now. It carries NO coordinates, no presence, no member the caller did not
 * already name, and no plan detail beyond title, time and place name.
 *
 * IT IS USABLE ON EVERY DEPLOYMENT, WHICH IS THE POINT
 * ===================================================
 * The trip, its members and its plan are tables every deployment has. The
 * §17.2 mode and the next commitment come from the operational batch (2761,
 * 2778) that no database has yet, so they are read SOFTLY: `unread` with the
 * reason rather than a refusal. A conversation that cannot be told the mode
 * still gets a trip; a projection that refused the whole context because one
 * gated table is missing would have been useless until the owner deploys.
 *
 * NOT PURE. Four reads. The route calls it; no Telegraph file is touched here
 * — `routes/telegraphChat.ts` still reads `trip_members` itself, and TR5 stays
 * W until that consumer switches.
 */
import { logger } from "../../../lib/logger.js";
import { liveEnvelope, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { ok, unread, type Layer } from "./TripMapProjection.js";
import { readTripAttention } from "../policies/TripAttentionFilter.js";

const log = logger.child({ mod: "tripTelegraphProjection" });

/** How many of the conversation's people the context names. A thread is not a crew list. */
export const TELEGRAPH_PARTICIPANT_CAP = 50;

export interface TelegraphTripSummary {
  id: string;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
}

/** One person the CALLER named who is also on the trip. Never anyone else. */
export interface TelegraphParticipant {
  userId: string;
  role: string;
  /** `accepted`, `invited`, … — a thread may want to say "not yet joined". */
  membershipStatus: string | null;
}

export interface TelegraphPlanItem {
  id: string;
  title: string | null;
  category: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  locationName: string | null;
}

export interface TripTelegraphProjection extends TripProjectionEnvelope {
  tripId: string;
  trip: TelegraphTripSummary;
  /** The intersection of the conversation's people and the trip's crew. */
  participants: TelegraphParticipant[];
  /** People the caller named who are NOT on this trip. Counted, never named back. */
  nonParticipantCount: number;
  /** The plan running now, if one is. */
  currentPlan: TelegraphPlanItem | null;
  /** The next plan that has not started. */
  nextPlan: TelegraphPlanItem | null;
  /** §17.2's switch: whether a commercial or discovery suggestion is welcome. Soft. */
  attention: Layer<{ mode: string; suppressed: boolean; reason: string | null; detail: string | null }>;
  /** What a conversation may do with this, said once. */
  reading: string;
}

export type TelegraphProjectionResult =
  | { ok: true; projection: TripTelegraphProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_AUTH_NOT_CREW" | "TRIP_PROJECTION_UNAVAILABLE"; message: string };

const TRIP_COLUMNS = "id, title, destination_city, destination_country, start_date, end_date, status, version";
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export const TELEGRAPH_CONTEXT_READING =
  "§1: the trip context a conversation may consume — the trip, the people in THIS conversation who are on it, " +
  "what is running now and what is next, and whether §17.2 says a commercial suggestion is unwelcome. " +
  "No coordinates, no presence, and no member the caller did not already name.";

/**
 * @param viewerId  who is asking. Must be an accepted member, or the context is refused.
 * @param conversationUserIds  the people in the thread. The participant list is
 *        the INTERSECTION with the crew — passing none yields none, which is
 *        the honest answer for a thread whose membership the caller did not state.
 */
export async function buildTripTelegraphProjection(
  sc: any,
  tripId: string,
  viewerId: string,
  conversationUserIds: readonly string[] = [],
  opts: { now?: Date } = {},
): Promise<TelegraphProjectionResult> {
  const now = opts.now ?? new Date();

  const { data: trip, error: tripErr } = await sc.from("trips").select(TRIP_COLUMNS).eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "telegraph context: trip unreadable");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const t = trip as any;
  const version = typeof t.version === "number" ? (t.version as number) : null;

  const { data: members, error: mErr } = await sc
    .from("trip_members").select("user_id, role, status").eq("trip_id", tripId);
  if (mErr) {
    // The crew decides whether the VIEWER may see anything, so an unreadable
    // crew is a refusal, not a soft read: answering without it would answer
    // without checking who is asking.
    log.warn({ err: mErr.message, tripId }, "telegraph context: crew unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The crew could not be read, so the viewer could not be checked" };
  }
  const rows = ((members ?? []) as any[]);
  const viewer = rows.find((r) => String(r.user_id) === viewerId);
  const accepted = (r: any) => r.status == null || r.status === "accepted";
  if (!viewer || !accepted(viewer)) {
    return { ok: false, reason: "TRIP_AUTH_NOT_CREW", message: "You must be an accepted trip member to read this trip's context" };
  }

  const named = new Set(conversationUserIds.map(String));
  const onTrip = new Set(rows.map((r) => String(r.user_id)));
  const participants: TelegraphParticipant[] = rows
    .filter((r) => named.has(String(r.user_id)))
    .slice(0, TELEGRAPH_PARTICIPANT_CAP)
    .map((r) => ({ userId: String(r.user_id), role: String(r.role ?? "member"), membershipStatus: r.status ?? null }));
  const nonParticipantCount = [...named].filter((id) => !onTrip.has(id)).length;

  const { data: items, error: iErr } = await sc
    .from("trip_plan_items")
    .select("id, title, category, status, starts_at, ends_at, location_name")
    .eq("trip_id", tripId)
    .is("removed_at", null);
  let currentPlan: TelegraphPlanItem | null = null;
  let nextPlan: TelegraphPlanItem | null = null;
  if (iErr) {
    log.warn({ err: iErr.message, tripId }, "telegraph context: plan unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The plan could not be read" };
  }
  const plan = ((items ?? []) as any[])
    .filter((p) => p.status !== "cancelled" && p.status !== "removed")
    .map((p): TelegraphPlanItem => ({
      id: String(p.id), title: p.title ?? null, category: p.category ?? null, status: p.status ?? null,
      startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, locationName: p.location_name ?? null,
    }));
  const nowMs = now.getTime();
  currentPlan = plan.find((p) => p.status === "in_progress")
    ?? plan.find((p) => { const s = ms(p.startsAt); const e = ms(p.endsAt); return s !== null && s <= nowMs && (e === null || e >= nowMs); })
    ?? null;
  nextPlan = plan
    .filter((p) => p.id !== currentPlan?.id)
    .filter((p) => { const s = ms(p.startsAt); return s !== null && s > nowMs; })
    .sort((a, b) => ms(a.startsAt)! - ms(b.startsAt)!)[0] ?? null;

  // §17.2, soft: `readTripAttention` never throws and says when it could not
  // be consulted. A conversation that cannot be told the mode is told that.
  let attention: TripTelegraphProjection["attention"];
  const reading = await readTripAttention(sc, tripId, viewerId, { now });
  attention = reading.consulted
    ? ok([{ mode: reading.mode ?? "NORMAL", suppressed: reading.suppressed, reason: reading.reason, detail: reading.detail }])
    : unread(reading.info ?? reading.detail ?? "the §17.2 switch could not be consulted");

  return {
    ok: true,
    projection: {
      ...liveEnvelope(version, now),
      tripId,
      trip: {
        id: String(t.id), title: t.title ?? null,
        destinationCity: t.destination_city ?? null, destinationCountry: t.destination_country ?? null,
        startDate: t.start_date ?? null, endDate: t.end_date ?? null, status: t.status ?? null,
      },
      participants,
      nonParticipantCount,
      currentPlan,
      nextPlan,
      attention,
      reading: TELEGRAPH_CONTEXT_READING,
    },
  };
}
