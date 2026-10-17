import type { SupabaseClient } from "@supabase/supabase-js";
import { shareableFor, type TelegraphShareProjection } from "./shareables.js"; import { readEventViewAccess } from "../../lib/eventViewAccess.js"; import { checkEventEligibility } from "../../routes/events.js"; import { isBlockedBetween } from "../../lib/blockGuard.js"; // census-telegraph T264 (readEventCancellation, at the foot); one line so the cited line below keeps its number

export interface EventAttendeeIdentity {
  userId: string;
  label: string;
}

export interface EventAttendanceRead {
  eventAccess: "allowed" | "denied" | "unavailable";
  attendance: EventAttendeeIdentity[] | null; /** census-telegraph T264: the §5.3 reason a DENIAL carried — `deleted` is the state gate, which the loader applies only after the block gate. */ deniedReason?: string;
}

export function createEventAttendanceReader(
  client: SupabaseClient,
  viewerId: string,
  participantIds: string[],
) {
  const participants = new Set(participantIds);
  const identities = new Map<string, Promise<TelegraphShareProjection | null>>();

  return async (eventId: string, hostId: unknown): Promise<EventAttendanceRead> => {
    let eventAccess: EventAttendanceRead["eventAccess"] = "unavailable";
    try {
      const event = shareableFor(client, "EVENT", eventId);
      if (!event) return { eventAccess, attendance: null };
      const state = await event.getCurrentState(viewerId);
      if (!state.available) return { eventAccess: state.reason === "unknown" ? "unavailable" : "denied", attendance: null, deniedReason: state.reason ?? undefined };
      eventAccess = "allowed";

      const { data, error } = await client
        .from("event_rsvps")
        .select("user_id, status")
        .eq("event_id", eventId)
        .in("user_id", participantIds);
      if (error || !Array.isArray(data)) return { eventAccess, attendance: null };
      if (data.some((row) => !row || typeof row.user_id !== "string" ||
        !participants.has(row.user_id) || !["going", "maybe", "interested", "cant_go"].includes(row.status))) return { eventAccess, attendance: null };
      if (new Set(data.map((row) => row.user_id)).size !== data.length) return { eventAccess, attendance: null };

      const viewerStatus = data.find((row) => row.user_id === viewerId)?.status;
      if (hostId !== viewerId && viewerStatus !== "going" && viewerStatus !== "maybe") {
        const role = await client.from("event_roles").select("role")
          .eq("event_id", eventId).eq("user_id", viewerId).maybeSingle();
        if (role.error || role.data?.role !== "co_host") return { eventAccess, attendance: null };
      }

      const going = new Set(data.filter((row) => row.status === "going").map((row) => row.user_id));
      const attendance: EventAttendeeIdentity[] = [];
      for (const userId of participantIds) {
        if (!going.has(userId)) continue;
        if (userId === viewerId) {
          attendance.push({ userId, label: "You" });
          continue;
        }
        if (!identities.has(userId)) {
          identities.set(userId, (async () => {
            const profile = shareableFor(client, "PROFILE", userId);
            if (!profile) return null;
            const state = await profile.getCurrentState(viewerId);
            if (state.reason === "unknown") throw new Error("Event attendee identity unavailable");
            return state.available ? profile.getSharePreview(viewerId) : null;
          })());
        }
        const identity = await identities.get(userId);
        if (identity) attendance.push({ userId, label: identity.title });
      }
      return { eventAccess, attendance };
    } catch {
      return { eventAccess, attendance: null };
    }
  };
}

// ── census-telegraph T264: the minimal authorized cancellation notice ─────────
//
// The canonical event loader withholds a cancelled event from everyone but its
// host, so the Shared Context Rail OMITS it — and an ordinary attendee, whose rail
// held the event yesterday, has nothing whose status can change: "called off while
// you were away" was never promoted to them. Restoring the card would disclose
// what a cancelled event no longer discloses (title, timing, place, host,
// attendance, actions). This is the separate contract the 2026-10-16 closure asked
// for instead: the attendee may be told the ONE fact that is theirs — that the
// event they were attending, named by the id their own rail already held, was
// cancelled. Nothing else is read out of the row into the answer.
//
// It is told only when every gate the loader applies to a live event would admit
// this viewer, with the state gate alone set aside: an attendee row (re-read
// here, so the gate stands on its own), no block either way (the shared
// fail-closed helper — an unreadable `blocks` denies), visibility as if the event
// were still on (`readEventViewAccess` with the state replaced, and only that),
// and `checkEventEligibility` (the ban and the trust / age / verified gates). And
// only while it is still news: once the event's end has passed — or six hours
// after a start with no end, the rail's own PAST rule — the cancellation is moot.
//
// "unavailable" is a gate that could not be read: the caller reports the rail
// INCOMPLETE rather than treating it as either answer.

/** Hours after a start with no end at which an event is past — `classifyBand`'s rule. */
export const CANCELLATION_NEWS_HOURS_WITHOUT_END = 6;

export type EventCancellationRead = "cancelled" | "withheld" | "unavailable";

export async function readEventCancellation(
  client: SupabaseClient,
  eventId: string,
  viewerId: string,
  nowMs: number,
): Promise<EventCancellationRead> {
  try {
    const { data, error } = await client
      .from("events")
      .select("id, host_id, state, visibility, circle_id, trip_id, age_min, age_max, trust_score_min, verified_only, starts_at, ends_at")
      .eq("id", eventId)
      .maybeSingle();
    if (error) return "unavailable";
    const r = data as Record<string, any> | null;
    if (!r || r.state !== "cancelled" || typeof r.host_id !== "string" || r.host_id.length === 0 || r.host_id === viewerId) return "withheld";
    const endMs = typeof r.ends_at === "string" ? Date.parse(r.ends_at) : NaN;
    const startMs = typeof r.starts_at === "string" ? Date.parse(r.starts_at) : NaN;
    if (Number.isFinite(endMs) ? endMs < nowMs : Number.isFinite(startMs) && startMs < nowMs - CANCELLATION_NEWS_HOURS_WITHOUT_END * 3600_000) return "withheld";

    const attendee = await client.from("event_attendees").select("user_id").eq("event_id", eventId).eq("user_id", viewerId).maybeSingle();
    if (attendee.error) return "unavailable";
    if (!attendee.data) return "withheld";

    if (await isBlockedBetween(client, viewerId, r.host_id)) return "withheld";

    // Visibility as if the event had not been cancelled — the state, and nothing else, set aside.
    const access = await readEventViewAccess(client, { id: eventId, host_id: r.host_id, state: "open", visibility: r.visibility ?? null, circle_id: r.circle_id ?? null, trip_id: r.trip_id ?? null }, viewerId);
    if (access === "unavailable") return "unavailable";
    if (access !== "allowed") return "withheld";

    const eligible = await checkEventEligibility(client, r, viewerId);
    if (!eligible.ok) return eligible.unavailable === true ? "unavailable" : "withheld";
    return "cancelled";
  } catch {
    return "unavailable";
  }
}
