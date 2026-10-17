import type { SupabaseClient } from "@supabase/supabase-js";
import { shareableFor, type TelegraphShareProjection } from "./shareables.js";

export interface EventAttendeeIdentity {
  userId: string;
  label: string;
}

export interface EventAttendanceRead {
  eventAccess: "allowed" | "denied" | "unavailable";
  attendance: EventAttendeeIdentity[] | null;
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
      if (!state.available) return { eventAccess: state.reason === "unknown" ? "unavailable" : "denied", attendance: null };
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
