/**
 * Trips spec §6.1 — the policy functions, by their spec names.
 *
 *   canViewTrip(actor, trip)                 canManageBooking(actor, trip)
 *   canInviteParticipant(actor, trip)        canSeePresence(actor, subject, trip)
 *   canEditTrip(actor, trip)                 canSeePreciseLocation(actor, subject, trip)
 *   canCreatePlan(actor, trip)               canManageSafety(actor, trip)
 *   canModifyPlan(actor, plan)
 *
 * "Roles are coarse; capabilities are derived from role + trip policy + plan
 * membership + privacy scope. Application code calls policy functions rather
 * than scattering host checks."
 *
 * WHAT WAS MEASURED, AND WHAT THIS CHANGES
 * ========================================
 * census-trips TR101-TR111 found every one of these BEHAVIOURS in the routes
 * and only two of the nine as NAMED functions (canEditPlan / canEditPlanItem,
 * lib/http.ts). The rest were inline: `owner_id !== user.id` in seven places,
 * `["owner", "co_host"].includes(role)` in thirty-eight, a visibility ladder
 * written out in GET /trips/:tripId, a delete rule in the reservations route.
 * Each was right. None could be TESTED as a rule, only as a route, and a
 * second route needing the same rule copied it — which is how the thirty-eight
 * happened.
 *
 * This module is those rules, named. The routes call it; the rules are tested
 * here once, against every actor kind §6.2 lists, and
 * `check:trip-policy-callsites` ratchets the inline count DOWN so the copies
 * stop growing while they are converted.
 *
 * Every refusal carries an Appendix B reason (lib/tripReasonCodes.ts), which is
 * what turns "403" into "you are not on this trip" / "this trip is private" /
 * "this member is in ghost mode" at the client.
 *
 * FAIL-CLOSED, AND "UNREADABLE" IS NOT "NO"
 * =========================================
 * An input that could not be read THROWS TripAccessUnavailableError, exactly
 * as requireTripMember does. A policy that answered "not permitted" because
 * the membership table was down would be a correct-looking refusal produced by
 * a query that did not run; every function here refuses to answer instead.
 *
 * WHAT IS NOT HERE
 * ================
 * Feature flags. Whether a surface is switched on is a deployment question,
 * not a capability of the actor, and stays at the route.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireTripMember, canEditPlan, canEditPlanItem,
  TripAccessUnavailableError,
  type CanEditPlanItemResult,
} from "./http.js";
import { isBlockedBetween } from "./blockGuard.js";
import type { TripReasonCode } from "./tripReasonCodes.js";

// ── Actors and decisions ─────────────────────────────────────────────────────

/** The caller. `userId: null` is an anonymous caller — a real actor kind, not an error. */
export interface PolicyActor {
  userId: string | null;
}

export type PolicyDecision =
  | { allowed: true; via: string }
  | { allowed: false; reason: TripReasonCode; message: string };

const deny = (reason: TripReasonCode, message: string): PolicyDecision => ({ allowed: false, reason, message });
const allow = (via: string): PolicyDecision => ({ allowed: true, via });

/** The membership rows requireTripMember accepts as crew (lib/http.ts). */
export const CREW_ROLES = ["owner", "co_host", "member", "viewer"] as const;
/** §6.1 "host": the owner or an accepted co-host (kernel capability `host`, 2500). */
export const HOST_ROLES = ["owner", "co_host"] as const;

export interface TripRow { id: string; owner_id: string; visibility?: string | null }

/**
 * Inputs a route has ALREADY read. Passing them skips the read here — the
 * rule is still this module's, the fact just arrives pre-fetched. `role` is
 * the accepted-crew role (null = not crew), exactly as requireTripMember
 * reports it; `undefined` means "not looked up, look it up".
 */
export interface PolicyInputs {
  trip?: TripRow | null;
  role?: string | null;
}

function describe(error: any): string {
  return String(error?.message ?? error?.code ?? "db_error");
}

async function readTrip(client: SupabaseClient, tripId: string, given?: PolicyInputs): Promise<TripRow | null> {
  if (given && given.trip !== undefined) return given.trip;
  const { data, error } = await client
    .from("trips")
    .select("id, owner_id, visibility")
    .eq("id", tripId)
    .maybeSingle();
  if (error) throw new TripAccessUnavailableError("trips", describe(error));
  return (data as TripRow | null) ?? null;
}

/**
 * Accepted membership, with the owner's implicit row. `null` for anonymous,
 * for a non-member, for an `invited` row and for a non-accepted status —
 * requireTripMember's rule, reused rather than restated.
 */
async function crewRole(client: SupabaseClient, tripId: string, actor: PolicyActor, given?: PolicyInputs): Promise<string | null> {
  if (!actor.userId) return null;
  if (given && given.role !== undefined) return given.role;
  const m = await requireTripMember(client, tripId, actor.userId);
  return m?.role ?? null;
}

// ── canViewTrip ──────────────────────────────────────────────────────────────

export type TripView = "authorized" | "preview";

export type ViewDecision =
  | { allowed: true; view: TripView; via: string; trip: TripRow }
  | { allowed: false; reason: TripReasonCode; message: string; trip: TripRow | null };

/**
 * §6.3's visibility ladder, as GET /trips/:tripId has always applied it:
 *
 *   blocked (either direction)   → refused, TRIP_AUTH_BLOCKED — INTERNAL ONLY.
 *                                  The route MUST render this as 404 "not found";
 *                                  the reason is for the route, never the client.
 *   crew or owner                → authorized, the full view
 *   public                       → preview, the stripped shape — anonymous too
 *   buddies + mutual follow      → preview
 *   buddies, no mutual follow    → refused, TRIP_PRIVACY_BUDDIES_ONLY
 *   invite / private / anything  → refused, TRIP_PRIVACY_NOT_VISIBLE
 *
 * Block is checked FIRST because blocking overrides every other relationship,
 * membership included — a blocked member does not get the member view.
 */
export async function canViewTrip(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<ViewDecision> {
  const trip = await readTrip(client, tripId, given);
  if (!trip) return { allowed: false, reason: "TRIP_PRIVACY_NOT_VISIBLE", message: "Trip not found", trip: null };

  if (actor.userId) {
    if (await isBlockedBetween(client, actor.userId, trip.owner_id)) {
      return { allowed: false, reason: "TRIP_AUTH_BLOCKED", message: "Trip not found", trip };
    }
    if (trip.owner_id === actor.userId) return { allowed: true, view: "authorized", via: "owner", trip };
    const role = await crewRole(client, tripId, actor, given);
    if (role) return { allowed: true, view: "authorized", via: `crew:${role}`, trip };
  }

  const vis = trip.visibility ?? "private";
  if (vis === "public") return { allowed: true, view: "preview", via: "public", trip };

  if (vis === "buddies") {
    if (!actor.userId) {
      return { allowed: false, reason: "TRIP_PRIVACY_BUDDIES_ONLY", message: "This trip is visible to buddies only", trip };
    }
    const [a, b] = await Promise.all([
      client.from("user_follows").select("follower_id").eq("follower_id", actor.userId).eq("following_id", trip.owner_id).maybeSingle(),
      client.from("user_follows").select("follower_id").eq("follower_id", trip.owner_id).eq("following_id", actor.userId).maybeSingle(),
    ]);
    if (a.error) throw new TripAccessUnavailableError("trips", describe(a.error));
    if (b.error) throw new TripAccessUnavailableError("trips", describe(b.error));
    if (a.data && b.data) return { allowed: true, view: "preview", via: "buddies:mutual", trip };
    return { allowed: false, reason: "TRIP_PRIVACY_BUDDIES_ONLY", message: "This trip is visible to buddies only", trip };
  }

  return { allowed: false, reason: "TRIP_PRIVACY_NOT_VISIBLE", message: "This trip is private", trip };
}

// ── canInviteParticipant / canManageJoinRequests / canEditTrip ───────────────

/**
 * Inviting is the OWNER's: both invite routes (POST /trips/:id/invite and
 * POST /trips/:id/members) require it, and the kernel's INVITE_PARTICIPANT
 * capability is `owner` (2450). A co-host may approve a join REQUEST (see
 * canManageJoinRequests) and may not initiate an invitation; the two are kept
 * apart because the kernel keeps them apart.
 */
export async function canInviteParticipant(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to invite members");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id !== actor.userId) return deny("TRIP_AUTH_NOT_OWNER", "Only the trip owner can invite members");
  return allow("owner");
}

/** §6.1 host: the owner or an accepted co-host (kernel `host`, 2500). */
export async function canManageJoinRequests(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to manage join requests");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id === actor.userId) return allow("owner");
  const role = await crewRole(client, tripId, actor, given);
  if (role && (HOST_ROLES as readonly string[]).includes(role)) return allow(`host:${role}`);
  return deny("TRIP_AUTH_NOT_HOST", "Only the owner or co-host can manage join requests");
}

/** Trip settings are the owner's (PATCH /trips/:id; kernel UPDATE_TRIP capability `owner`). */
export async function canEditTrip(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to edit this trip");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id !== actor.userId) return deny("TRIP_AUTH_NOT_OWNER", "Only the trip owner can update this trip");
  return allow("owner");
}

// ── The vocabulary the routes were spelling inline (census-trips TR102) ─────
//
// §6.1 says application code calls policy functions rather than scattering
// host checks. Thirty-eight inline copies of "is this the owner / a host / a
// member / the row's own creator" lived in three route files; each is one
// of the five decisions below now, with the Appendix B reason a refusal
// carries. Every function takes `given` so a route that has already read the
// trip and the membership pays no second read.

/** The owner, or any accepted crew role: may read the trip's shared content. */
export async function canAccessTripContent(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to view this trip");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id === actor.userId) return allow("owner");
  const role = await crewRole(client, tripId, actor, given);
  if (role && (CREW_ROLES as readonly string[]).includes(role)) return allow(`crew:${role}`);
  return deny("TRIP_AUTH_NOT_CREW", "Not a trip member");
}

/** The owner or a co-host: the trip's hosts (§6.1). */
export async function canHostTrip(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to manage this trip");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id === actor.userId) return allow("owner");
  const role = await crewRole(client, tripId, actor, given);
  if (role && (HOST_ROLES as readonly string[]).includes(role)) return allow(`host:${role}`);
  return deny("TRIP_AUTH_NOT_HOST", "Only the trip owner or co-host may do this");
}

/** Owner, co-host or member — a contributing role. A viewer reads and does not contribute. */
export const CONTRIBUTING_ROLES = ["owner", "co_host", "member"] as const;
export async function canContributeToTrip(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to contribute to this trip");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id === actor.userId) return allow("owner");
  const role = await crewRole(client, tripId, actor, given);
  if (role && (CONTRIBUTING_ROLES as readonly string[]).includes(role)) return allow(`crew:${role}`);
  if (role) return deny("TRIP_AUTH_ROLE_NOT_PERMITTED", "A viewer cannot contribute to this trip");
  return deny("TRIP_AUTH_NOT_CREW", "Not a trip member");
}

/** The owner, or the person who created the row (a document, a note, a saved place, a checklist). */
export async function canEditOwnOrAsOwner(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  creatorId: string | null | undefined,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to edit this");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id === actor.userId) return allow("owner");
  if (creatorId && creatorId === actor.userId) return allow("creator");
  return deny("TRIP_AUTH_NOT_CREATOR", "Only the trip owner or the person who created this may change it");
}

/** The owner sees private contributions (documents, notes marked private) whoever wrote them. */
export async function canSeePrivateContributions(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to view this trip");
  const trip = await readTrip(client, tripId, given);
  if (!trip) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  if (trip.owner_id === actor.userId) return allow("owner");
  return deny("TRIP_AUTH_NOT_OWNER", "Private contributions are the owner's to see");
}

/** The actor's role on the trip — "owner" for the owner, else the accepted crew role, else null. */
export async function tripRoleOf(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<string | null> {
  if (!actor.userId) return null;
  const trip = await readTrip(client, tripId, given);
  if (!trip) return null;
  if (trip.owner_id === actor.userId) return "owner";
  return crewRole(client, tripId, actor, given);
}

/** PURE: whether the actor owns the trip row — for the branch picks that are not refusals. */
export function isTripOwner(trip: { owner_id?: string | null } | null | undefined, actor: PolicyActor): boolean {
  return Boolean(actor.userId && trip && trip.owner_id === actor.userId);
}

/**
 * PURE: the §6.2 plan-edit rule over a trip row and the trip's named editors —
 * the owner always; `all_members` everyone; `owner_only` nobody else;
 * `selected_members` the named editors.
 */
export function planEditPermits(
  trip: { owner_id?: string | null; plan_edit_permission?: string | null },
  userId: string,
  editors: readonly string[],
): boolean {
  if (trip.owner_id === userId) return true;
  const perm = trip.plan_edit_permission ?? "all_members";
  if (perm === "all_members") return true;
  if (perm === "owner_only") return false;
  return editors.includes(userId);
}

// ── canCreatePlan / canModifyPlan ────────────────────────────────────────────
// These two already existed under their lib/http.ts names (census TR106,
// TR107 — C). Re-exported under the spec's names so the nine §6.1 functions
// live in one module, and so a caller reaching for the spec name finds it.

export async function canCreatePlan(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to add plans");
  const r = await canEditPlan(client, tripId, actor.userId);
  if (r === null) return deny("TRIP_PRIVACY_NOT_VISIBLE", "Trip not found");
  return r ? allow("plan_edit_permission") : deny("TRIP_AUTH_NOT_CREW", "You cannot add plans to this trip");
}

export async function canModifyPlan(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  planItemId: string,
  opts: { ownerOnly?: boolean } = {},
): Promise<PolicyDecision & { detail?: CanEditPlanItemResult }> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to edit plans");
  const r = await canEditPlanItem(client, tripId, planItemId, actor.userId, opts.ownerOnly ?? false);
  if (r.permitted) return { ...allow(`plan:${r.role}`), detail: r };
  const reason: TripReasonCode =
    r.code === "not_found" ? "TRIP_PRIVACY_NOT_VISIBLE"
    : r.code === "not_member" ? "TRIP_AUTH_NOT_CREW"
    : "TRIP_AUTH_NOT_CREATOR";
  return { ...deny(reason, r.message), detail: r };
}

// ── canManageBooking ─────────────────────────────────────────────────────────

export type BookingAction = "read" | "write" | "delete";

/**
 * Reservations (§15): any accepted crew member may read and edit; DELETE is
 * stricter — the reservation's creator or the trip owner — which is the rule
 * routes/tripReservations.ts has applied since it was written. Passing the
 * creator is the caller's job because it is on the reservation row, which the
 * caller has already fetched; refetching it here would be a second read of the
 * same fact.
 */
export async function canManageBooking(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  action: BookingAction,
  opts: { reservationCreatorId?: string | null } & PolicyInputs = {},
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to manage reservations");
  const role = await crewRole(client, tripId, actor, opts);
  if (!role) return deny("TRIP_BOOKING_NOT_MEMBER", "Not a trip member");
  if (action !== "delete") return allow(`crew:${role}`);
  if (role === "owner") return allow("owner");
  if (opts.reservationCreatorId && opts.reservationCreatorId === actor.userId) return allow("creator");
  return deny("TRIP_BOOKING_NOT_CREATOR_OR_OWNER", "Only the reservation creator or trip owner can delete it");
}

// ── canSeePresence ───────────────────────────────────────────────────────────
// Pure, and in its own module (lib/tripPresencePolicy.ts) because
// lib/tripCrewLocation.ts calls it for buildCrewCard's fork and this file
// imports tripCrewLocation — see that module's header. Re-exported here so
// the nine §6.1 names resolve from one place.
export { canSeePresence, type PresenceSubject, type PresenceDecision } from "./tripPresencePolicy.js";

// ── canManageSafety ──────────────────────────────────────────────────────────

/**
 * §17.4 / §6.2: Safe Return may attach to a trip (solo, subgroup or full crew)
 * — and a session that names a trip is a statement that its owner is ON that
 * trip, because `notify_trip_crew_enabled` then notifies that trip's crew.
 * Measured 2026-09-12: POST /safe-return wrote `trip_id` from the request body
 * with no membership check, so any signed-in user could attach a session to
 * any trip id. This is the check.
 *
 * Only accepted crew may attach safety to a trip. The session itself stays the
 * owner's (SafeReturnPrivacyGuard gates it by session ownership); this decides
 * the TRIP half, which nothing did.
 */
export async function canManageSafety(
  client: SupabaseClient,
  actor: PolicyActor,
  tripId: string,
  given?: PolicyInputs,
): Promise<PolicyDecision> {
  if (!actor.userId) return deny("TRIP_AUTH_UNAUTHENTICATED", "Sign in to use Safe Return");
  const role = await crewRole(client, tripId, actor, given);
  if (!role) return deny("TRIP_AUTH_NOT_CREW", "You can only attach Safe Return to a trip you are on");
  return allow(`crew:${role}`);
}

// ── canSeePreciseLocation ────────────────────────────────────────────────────
// Already built and graded C (census TR110): lib/tripCrewLocation.ts
// resolveExactCoords releases exact coordinates only under an active,
// unexpired live-share grant with hotel blur off and a current position. It is
// not duplicated here; the name is exported so the §6.1 set is complete in one
// place, and it delegates.
export { resolveExactCoords as canSeePreciseLocation } from "./tripCrewLocation.js";
