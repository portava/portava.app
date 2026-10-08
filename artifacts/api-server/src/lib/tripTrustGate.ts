/**
 * Trust restrictions at the Trips doors that do what Compass now refuses
 * (census-trips §84; census-trust TRV2-08; OD-TRUST-5: "Enforce restrictions on
 * the server across all relevant APIs and surfaces"). Found by the independent
 * check of lane L's Compass gate: an account restricted from hosting could
 * still add, rewrite or remove a shared trip's plans through the plain Trips
 * routes, and one restricted from hosting or messaging could still put a
 * proposal in front of the whole crew through /commands or /replan.
 *
 * THE MAPPING — confirmed by lead ruling D-24 (2026-10-06, as amended); the
 * refusal says the restriction's own sentence, RESTRICTION_SENTENCES in
 * lib/discoveryTrustGate.ts, which reads services/trust/TrustPrivacyGuard.ts
 * restrictionSentence() and keeps no copy of its own (lane L's patch, #640):
 *
 *   change_shared_plan  hosting — adding, editing, removing or reordering a
 *                       plan item of a GROUP trip is organising that group
 *                       trip. Doors: POST/PATCH/DELETE /trips/:id/plan/items…,
 *                       /remove, /reorder (routes/trips.ts); POST
 *                       /places/:id/add-to-trip-plan and
 *                       /meetups/:id/add-to-trip-plan (routes/plan.ts); POST
 *                       /hidden-gems/:id/plan (routes/hiddenGems.ts); POST
 *                       /trips/:id/reservations/:id/confirm with addToPlan
 *                       (routes/tripReservations.ts — refused before the
 *                       confirm, so a restricted person can still confirm
 *                       without adding).
 *   create_proposal     hosting OR messaging — it organises a change every
 *                       member must act on, and it puts its rationale text on
 *                       every member's screen in this person's name. Doors:
 *                       POST /trips/:id/commands type CREATE_PROPOSAL
 *                       (server/trips/commandRoute.ts); POST /trips/:id/replan
 *                       with createProposals (readRoutes/tripProjections.ts).
 *                       The same reading as lane L's Compass gate, so the two
 *                       doors to the same act cannot disagree.
 *
 * A SOLO TRIP IS NOT A GROUP TRIP (lead ruling D-24a, 2026-10-06). Each gate
 * applies only when someone other than the actor is an accepted member, decided
 * by readTripShape below — the ONE solo/group test, which lane L's Compass gate
 * calls too. An unreadable trip shape refuses with "try again".
 *
 * NOT GATED, deliberately (OD-TRUST-5: limit a restriction to the actions it is
 * needed for): reading anything; voting on, accepting or rejecting a
 * proposal; attendance (JOIN_PLAN / LEAVE_PLAN); presence; and every safety
 * path — DECLARE_DISRUPTION / RESOLVE_DISRUPTION, meeting checkpoints and
 * arrivals, rescue, Safe Return, stopping a location share.
 *
 * Unreadable membership, or an unreadable restriction state, refuses with the
 * retryable 503 and no "restricted" wording (lib/discoveryTrustGate.ts).
 */
import type { Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getRestrictionState } from "../services/trust/TrustRestrictionService.js";
import {
  decideTrustAction, RESTRICTION_SENTENCES, RESTRICTION_UNVERIFIABLE_MESSAGE, type GatedRestriction,
} from "./discoveryTrustGate.js";
import { sendError } from "./http.js";

export type TripRestrictedAction = "change_shared_plan" | "create_proposal";

export const TRIP_ACTION_RESTRICTIONS: Readonly<Record<TripRestrictedAction, readonly GatedRestriction[]>> = Object.freeze({
  change_shared_plan: Object.freeze(["hosting"]) as readonly GatedRestriction[],
  create_proposal: Object.freeze(["hosting", "messaging"]) as readonly GatedRestriction[],
});

// ── THE solo/group test (lead ruling D-24a, 2026-10-06) ──────────────────────
//
// ONE function decides whether a trip is the actor's alone. Every Trips door
// and lane L's Compass gate call it, so no two doors to the same act can answer
// differently (the verifier found Compass gating solo trips while Trips did not).
//
//   solo        the trip row was read and nobody but the actor is an accepted
//               member — the same rule requireTripMember applies (owner,
//               co_host, member, viewer; status accepted or unset; the trip's
//               owner counts even without a trip_members row).
//   group       someone other than the actor is an accepted member.
//   unreadable  either read failed, threw, or the trip row is not there. D-24a:
//               "If whether a trip is solo cannot be read, treat it as a group
//               trip and refuse with 'try again', never with 'restricted'."
//
// Invited (not yet accepted) people do not make a trip a group trip: nothing of
// the plan is theirs until they accept.

const ACCEPTED_TRIP_ROLES: ReadonlySet<string> = new Set(["owner", "co_host", "member", "viewer"]);

/**
 * `actorAccess`: "retained_record_only" when the actor's membership was
 * restored by an upheld appeal AFTER the trip ended (3974 stamps
 * trip_members.permissions.access). The owner's ruling (2026-10-04): "if a
 * trip has ended, restore access to its retained record only" — they may read
 * the trip, not change it (census-trips §85, verifier R5).
 */
export type TripActorAccess = "full" | "retained_record_only";

export type TripShape =
  | { kind: "solo"; actorAccess: TripActorAccess }
  | { kind: "group"; otherAcceptedMembers: number; actorAccess: TripActorAccess }
  | { kind: "unreadable"; reason: string };

/** What a retained-record-only member is told. Not a Trust restriction, so not "restricted". */
export const RETAINED_RECORD_ONLY_MESSAGE =
  "This trip has ended and your access was restored to its record only. You can see it, but not change it.";

export async function readTripShape(sc: SupabaseClient | null | undefined, tripId: string, actorId: string): Promise<TripShape> {
  if (!sc) return { kind: "unreadable", reason: "no service client" };
  try {
    const [members, trip] = await Promise.all([
      sc.from("trip_members").select("user_id, status, role, permissions").eq("trip_id", tripId),
      sc.from("trips").select("id, owner_id").eq("id", tripId).maybeSingle(),
    ]);
    if (members?.error) return { kind: "unreadable", reason: `trip_members: ${members.error.message ?? "read failed"}` };
    if (trip?.error) return { kind: "unreadable", reason: `trips: ${trip.error.message ?? "read failed"}` };
    if (!trip?.data) return { kind: "unreadable", reason: "trip not found" };
    const accepted = new Set<string>();
    const withRow = new Set<string>();
    let actorAccess: TripActorAccess = "full";
    for (const m of (members.data ?? []) as Array<{ user_id: unknown; status?: unknown; role?: unknown; permissions?: unknown }>) {
      withRow.add(String(m.user_id));
      if (ACCEPTED_TRIP_ROLES.has(String(m.role)) && (m.status == null || m.status === "accepted")) accepted.add(String(m.user_id));
      if (String(m.user_id) === actorId) {
        const perms = m.permissions && typeof m.permissions === "object" ? (m.permissions as Record<string, unknown>) : null;
        if (perms?.access === "retained_record_only") actorAccess = "retained_record_only";
      }
    }
    const owner = (trip.data as { owner_id?: unknown }).owner_id;
    if (typeof owner === "string" && !withRow.has(owner)) accepted.add(owner);
    accepted.delete(actorId);
    return accepted.size === 0 ? { kind: "solo", actorAccess } : { kind: "group", otherAcceptedMembers: accepted.size, actorAccess };
  } catch (e) {
    return { kind: "unreadable", reason: e instanceof Error ? e.message : "read threw" };
  }
}

/**
 * The whole decision without Express, for any caller (lane L's Compass gate
 * and tools call this). `unverifiable` → answer 503 with
 * RESTRICTION_UNVERIFIABLE_MESSAGE and no "restricted" wording; `restricted` →
 * 403 trust_restriction with `message` (the restrictions' own sentences).
 * A solo trip is allowed WITHOUT reading the restriction state.
 */
export type TripActionVerdict =
  | { allowed: true; shape: "solo" | "group" }
  | { allowed: false; kind: "unverifiable"; message: string; reason: string }
  | { allowed: false; kind: "read_only"; message: string }
  | { allowed: false; kind: "restricted"; restrictionTypes: GatedRestriction[]; message: string };

export async function decideTripActionRestriction(
  sc: SupabaseClient | null | undefined,
  tripId: string,
  userId: string,
  action: TripRestrictedAction,
): Promise<TripActionVerdict> {
  const shape = await readTripShape(sc, tripId, userId);
  if (shape.kind === "unreadable") return { allowed: false, kind: "unverifiable", message: RESTRICTION_UNVERIFIABLE_MESSAGE, reason: shape.reason };
  if (shape.actorAccess === "retained_record_only") return { allowed: false, kind: "read_only", message: RETAINED_RECORD_ONLY_MESSAGE };
  if (shape.kind === "solo") return { allowed: true, shape: "solo" };
  let verdict: ReturnType<typeof decideTrustAction>;
  try {
    verdict = decideTrustAction(await getRestrictionState(sc as Parameters<typeof getRestrictionState>[0], userId), TRIP_ACTION_RESTRICTIONS[action]);
  } catch {
    verdict = { allowed: false as const, kind: "unverifiable" as const };
  }
  if (verdict.allowed) return { allowed: true, shape: "group" };
  if (verdict.kind === "unverifiable") return { allowed: false, kind: "unverifiable", message: RESTRICTION_UNVERIFIABLE_MESSAGE, reason: "restriction state unreadable" };
  return {
    allowed: false,
    kind: "restricted",
    restrictionTypes: verdict.restrictionTypes,
    message: verdict.restrictionTypes.map((t) => RESTRICTION_SENTENCES[t]).join(" "),
  };
}

/** True when it has refused (the caller returns). The Express face of decideTripActionRestriction. */
export async function refuseTripActionIfRestricted(
  res: Response,
  sc: SupabaseClient | null | undefined,
  tripId: string,
  userId: string,
  action: TripRestrictedAction,
): Promise<boolean> {
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return true; }
  const v = await decideTripActionRestriction(sc, tripId, userId, action);
  if (v.allowed) return false;
  if (v.kind === "unverifiable") { sendError(res, "degraded_unavailable", RESTRICTION_UNVERIFIABLE_MESSAGE); return true; }
  if (v.kind === "read_only") { res.status(403).json({ error: "trip_record_read_only", message: v.message }); return true; }
  res.status(403).json({ error: "trust_restriction", message: v.message, restrictionTypes: v.restrictionTypes });
  return true;
}

/**
 * For a door that changes a trip but is not a Trust-gated act (every other
 * command through POST /trips/:id/commands): refuse a retained-record-only
 * member (verifier R5). True when it has refused. An unreadable membership is
 * "try again", never a silent pass.
 */
export async function refuseIfRetainedRecordOnly(
  res: Response,
  sc: SupabaseClient | null | undefined,
  tripId: string,
  userId: string,
): Promise<boolean> {
  const shape = await readTripShape(sc, tripId, userId);
  if (shape.kind === "unreadable") { sendError(res, "degraded_unavailable", RESTRICTION_UNVERIFIABLE_MESSAGE); return true; }
  if (shape.actorAccess === "retained_record_only") { res.status(403).json({ error: "trip_record_read_only", message: RETAINED_RECORD_ONLY_MESSAGE }); return true; }
  return false;
}

/** What a person redeeming an invite is told when it cannot be used now. Says nothing about why (the inviter's restriction is theirs). */
export const INVITE_UNAVAILABLE_MESSAGE = "This invite isn't available right now.";
/** The inviter's state could not be read: retryable, and still says nothing about a restriction. */
export const INVITE_UNCHECKABLE_MESSAGE = "We couldn't check this invite right now. Please try again shortly.";

/**
 * Lead ruling (2026-10-06, on verifier R2 of 1867c97df): while an inviter is
 * restricted from hosting, their outstanding invites and invite links cannot be
 * redeemed — otherwise a restricted host's trip keeps growing on invites made
 * before the restriction. The REDEEMER sees "This invite isn't available right
 * now", with no reason and nothing that reveals the inviter's restriction. An
 * unreadable restriction state is a retryable 503 in the same neutral words.
 * True when it has refused.
 */
export async function refuseIfInviterCannotHost(
  res: Response,
  sc: SupabaseClient | null | undefined,
  inviterId: string | null,
): Promise<boolean> {
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return true; }
  if (!inviterId) { res.status(403).json({ error: "invite_unavailable", message: INVITE_UNAVAILABLE_MESSAGE }); return true; }
  let verdict: ReturnType<typeof decideTrustAction>;
  try {
    verdict = decideTrustAction(await getRestrictionState(sc as Parameters<typeof getRestrictionState>[0], inviterId), ["hosting"]);
  } catch {
    verdict = { allowed: false, kind: "unverifiable" };
  }
  if (verdict.allowed) return false;
  if (verdict.kind === "unverifiable") { sendError(res, "degraded_unavailable", INVITE_UNCHECKABLE_MESSAGE); return true; }
  res.status(403).json({ error: "invite_unavailable", message: INVITE_UNAVAILABLE_MESSAGE });
  return true;
}
