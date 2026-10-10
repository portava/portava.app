/**
 * Telegraph §30A.1 — gathers the facts `deriveTelegraphRelationship` decides on
 * (domain/telegraph/contracts/telegraphRelationship.ts), from data that exists.
 *
 * NOT A FIFTH RESOLVER for what is already resolved: follows, friendship,
 * shared trips, shared circles and the block come from
 * lib/messagingPermissions.ts#canMessage — the resolver
 * services/telegraph/reachablePeople.ts already consumes — and the Trust
 * restriction from services/trust/TrustRestrictionService.ts#getRestrictionState.
 * This module reads only what neither of those reads: an accepted message
 * request (MANUAL), shared event attendance (EVENT), a Rent-a-Buddy booking
 * between the two (BUDDY) and an accepted shared meetup (PLAN).
 *
 * FAIL DIRECTION: any failed read returns `{ degraded: true }` and NO
 * relationship. A relationship is a statement about two people; a floor built
 * from a failed read would be published as a fact (the reachablePeople rule).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canMessage } from "../../lib/messagingPermissions.js";
import { getRestrictionState } from "../trust/TrustRestrictionService.js";
import { deriveTelegraphRelationship, type TelegraphRelationship } from "../../domain/telegraph/contracts/telegraphRelationship.js";

export const RELATIONSHIP_CONTEXT_FLAG = "telegraph_relationship_context_enabled";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A read that returns this many rows cannot prove it saw everything. */
const SCAN_CAP = 1000;

/** Booking states in which the two have an agreed, ongoing arrangement. */
export const LIVE_BUDDY_STATUSES = ["confirmed", "scheduled", "in_progress", "completed_pending_traveler_confirmation", "no_show_pending", "disputed"] as const;
/** A booking that happened and is over. Cancelled / declined / never-accepted bookings are no origin at all. */
export const ENDED_BUDDY_STATUSES = ["completed"] as const;
/** event_state values after which an event is over. */
const ENDED_EVENT_STATES = new Set(["completed", "cancelled", "archived"]);

export type RelationshipRead = { degraded: true } | { degraded: false; relationship: TelegraphRelationship };

const DEGRADED: RelationshipRead = { degraded: true };

export async function readTelegraphRelationship(
  sc: SupabaseClient,
  viewerId: string,
  otherId: string,
  nowMs: number = Date.now(),
): Promise<RelationshipRead> {
  if (!UUID.test(viewerId) || !UUID.test(otherId) || viewerId === otherId) return DEGRADED;

  const verdict = await canMessage(sc, viewerId, otherId);
  if (verdict.reason === "unavailable" || verdict.degraded === true) return DEGRADED;
  if (verdict.reason === "blocked") {
    return { degraded: false, relationship: deriveTelegraphRelationship({ ...EMPTY, blocked: true }) };
  }
  const restriction = await getRestrictionState(sc, viewerId);
  if (restriction.degradedReason === "fail_closed") return DEGRADED;

  // MANUAL — an accepted message request, either direction.
  const { data: reqs, error: reqErr } = await sc
    .from("message_requests")
    .select("id")
    .eq("status", "accepted")
    .or(`and(sender_id.eq.${viewerId},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${viewerId})`)
    .limit(1);
  if (reqErr) return DEGRADED;

  // EVENT — both attend the same event.
  const { data: myEvents, error: meErr } = await sc.from("event_attendees").select("event_id").eq("user_id", viewerId).limit(SCAN_CAP);
  if (meErr || (myEvents ?? []).length >= SCAN_CAP) return DEGRADED;
  const myEventIds = ((myEvents as Array<{ event_id: string }> | null) ?? []).map((r) => r.event_id);
  const events = { live: 0, ended: 0 };
  if (myEventIds.length > 0) {
    const { data: shared, error: shErr } = await sc.from("event_attendees").select("event_id").eq("user_id", otherId).in("event_id", myEventIds);
    if (shErr) return DEGRADED;
    const sharedIds = ((shared as Array<{ event_id: string }> | null) ?? []).map((r) => r.event_id);
    if (sharedIds.length > 0) {
      const { data: evs, error: evErr } = await sc.from("events").select("id, state").in("id", sharedIds);
      if (evErr) return DEGRADED;
      for (const e of (evs as Array<{ state?: string }> | null) ?? []) {
        if (ENDED_EVENT_STATES.has(String(e.state))) events.ended++;
        else events.live++;
      }
    }
  }

  // BUDDY — a booking between the two, either side the buddy.
  const { data: profiles, error: pErr } = await sc.from("rent_buddy_profiles").select("id, user_id").in("user_id", [viewerId, otherId]);
  if (pErr) return DEGRADED;
  const profileOf = new Map(((profiles as Array<{ id: string; user_id: string }> | null) ?? []).map((p) => [p.user_id, p.id]));
  const buddy = { live: 0, ended: 0 };
  const pairs: string[] = [];
  const otherProfile = profileOf.get(otherId);
  const myProfile = profileOf.get(viewerId);
  if (otherProfile && UUID.test(otherProfile)) pairs.push(`and(buddy_id.eq.${otherProfile},traveler_id.eq.${viewerId})`);
  if (myProfile && UUID.test(myProfile)) pairs.push(`and(buddy_id.eq.${myProfile},traveler_id.eq.${otherId})`);
  if (pairs.length > 0) {
    const { data: bookings, error: bErr } = await sc.from("rent_buddy_bookings").select("id, status").or(pairs.join(",")).limit(SCAN_CAP);
    if (bErr) return DEGRADED;
    for (const b of (bookings as Array<{ status?: string }> | null) ?? []) {
      if ((LIVE_BUDDY_STATUSES as readonly string[]).includes(String(b.status))) buddy.live++;
      else if ((ENDED_BUDDY_STATUSES as readonly string[]).includes(String(b.status))) buddy.ended++;
    }
  }

  // PLAN — a meetup both are IN: its creator, or an invitee who accepted.
  const participatingIn = async (userId: string): Promise<Set<string> | null> => {
    const [{ data: inv, error: iErr }, { data: own, error: oErr }] = await Promise.all([
      sc.from("meetup_invites").select("meetup_id").eq("user_id", userId).eq("status", "accepted").limit(SCAN_CAP),
      sc.from("meetups").select("id").eq("creator_id", userId).limit(SCAN_CAP),
    ]);
    if (iErr || oErr || (inv ?? []).length >= SCAN_CAP || (own ?? []).length >= SCAN_CAP) return null;
    return new Set([
      ...((inv as Array<{ meetup_id: string }> | null) ?? []).map((r) => r.meetup_id),
      ...((own as Array<{ id: string }> | null) ?? []).map((r) => r.id),
    ]);
  };
  const mine = await participatingIn(viewerId);
  const theirs = await participatingIn(otherId);
  if (!mine || !theirs) return DEGRADED;
  const sharedPlans = [...mine].filter((id) => theirs.has(id));
  const plans = { live: 0, ended: 0 };
  if (sharedPlans.length > 0) {
    const { data: ms, error: mErr } = await sc.from("meetups").select("id, status, starts_at, ends_at").in("id", sharedPlans);
    if (mErr) return DEGRADED;
    for (const m of (ms as Array<{ status?: string; starts_at?: string | null; ends_at?: string | null }> | null) ?? []) {
      if (m.status === "cancelled") continue; // a cancelled plan was never a connection
      const end = Date.parse(String(m.ends_at ?? m.starts_at ?? ""));
      if (!Number.isNaN(end) && end <= nowMs) plans.ended++;
      else plans.live++;
    }
  }

  const ctx = verdict.relationship_context;
  return {
    degraded: false,
    relationship: deriveTelegraphRelationship({
      blocked: false,
      viewerMessagingRestricted: !restriction.canMessage,
      isFriend: ctx.isFriend,
      viewerFollows: ctx.senderFollowsRecipient,
      otherFollows: ctx.recipientFollowsSender,
      sharedCircle: ctx.sharedCircle,
      sharedTrip: ctx.sharedTrip,
      acceptedRequest: ((reqs as unknown[]) ?? []).length > 0,
      events,
      buddy,
      plans,
    }),
  };
}

const EMPTY = {
  blocked: false, viewerMessagingRestricted: false, isFriend: false, viewerFollows: false, otherFollows: false,
  sharedCircle: false, sharedTrip: false, acceptedRequest: false,
  events: { live: 0, ended: 0 }, buddy: { live: 0, ended: 0 }, plans: { live: 0, ended: 0 },
};
