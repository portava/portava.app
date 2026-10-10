/**
 * OD-TRUST-5 — a Trust restriction, enforced on the SEND, as one decision.
 *
 * Owner ruling OD-TRUST-5 (docs/ops/owner-decisions-20261004.md), verbatim:
 *   "Enforce restrictions on the server across all relevant APIs and surfaces;
 *    hiding controls in the interface is not enough. Limit each restriction to
 *    the actions and duration needed, and preserve access to appeals and
 *    permitted data exports."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Trust restrictions were consulted on exactly one Telegraph write — the
 * message REQUEST (routes/messaging.ts, `getRestrictionState`) — and on none of
 * the doors that write into `messages`. Meanwhile the capabilities projection
 * (conversationCapabilityPolicy) reported `canSendMessage: false` for every
 * messaging-restricted person in every thread: a refusal the projection
 * announced and no door performed, and broader than what the person is TOLD
 * the restriction means. Both now read this module, so they cannot disagree
 * (src/test/telegraphRestrictionSendGate.test.ts drives both and compares).
 *
 * ── WHAT EACH RESTRICTION TYPE STOPS AT A SEND — LANE T2's READING ───────────
 * The four types and what the Trust service says each restricts
 * (services/trust/TrustRestrictionService.ts header, and the sentence the person
 * is shown, services/trust/TrustPrivacyGuard.ts RESTRICTION_MESSAGES):
 *
 *   messaging           "cannot initiate new conversations"
 *                       → refuses a send that would INITIATE contact: a message
 *                         in a person-to-person (`direct`) thread the other
 *                         person has never written in, has not engaged with by
 *                         ACCEPTING a message request between the two (either
 *                         direction — the accept route writes only the
 *                         requester's preview, so the recipient may not have
 *                         written yet; census-telegraph §45d), and which no
 *                         booking owns (a booking is contact both parties
 *                         entered into).
 *                         Replying to someone who has written
 *                         to you, and writing in a trip or circle thread whose
 *                         roster the source domain decided, is continuing a
 *                         conversation, not starting one, and is not refused.
 *                         Opening a thread and requesting one are refused
 *                         elsewhere already (resolveInteractionPermissions).
 *   hosting             "cannot host group trips"            → no send refused
 *   private_plan_access "cannot join private plans"          → no send refused
 *   location_plan_join  "cannot join location-based plans"   → no send refused
 *
 * The last three restrict actions that are not messages and are enforced where
 * those actions live (routes/trips.ts, routes/tripCrewLocation.ts). Refusing a
 * chat message under them would extend a restriction past "the actions …
 * needed". DECIDED: lead ruling D-24 (2026-10-06) confirmed this mapping — "the
 * sentence a restricted person is shown must name every capability that
 * restriction stops. Anything not named in that sentence must not be refused."
 * The same rule now decides calls, plans, seen state and exact location (the
 * capability table below, and "D-24 on the other capabilities" at the foot).
 *
 * ── NEVER SUPPRESSIBLE ──────────────────────────────────────────────────────
 * A send the caller marks `safety` is admitted whatever the restriction and
 * WITHOUT reading it, so not even an unreadable restriction state can stop it:
 * the §6.2 SAFETY kind and the §9.1 NEED_HELP quick state. The other safety
 * paths the ruling names do not write through this gate at all and are not
 * touched by it: safe-return check-ins and alerts (routes/safeReturn.ts),
 * the need-help alert (routes/circle.ts POST …/need-help), blocking
 * (routes/blocks.ts), reporting (routes/moderation.ts, /messages/:id/report,
 * /threads/:id/report) and appeals (routes/appeals.ts). No moderation or
 * appeals THREAD type exists — `message_threads.thread_type` is
 * direct | trip | circle — so there is no such reply to exempt.
 *
 * ── FAIL DIRECTION ──────────────────────────────────────────────────────────
 * An unreadable restriction state (getRestrictionState's `fail_closed`), or an
 * unreadable fact the decision needs, REFUSES with a retryable answer and never
 * with the restriction's sentence: "we could not check" is not "you are
 * restricted". `fail_open` (the table was never migrated) is not a restriction
 * and admits, which is the service's own contract.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getRestrictionState,
  type RestrictionState,
  type RestrictionType,
} from "../../../services/trust/TrustRestrictionService.js";
import type { TelegraphReason } from "../contracts/telegraphReasonCodes.js"; import { readTripShape } from "../../../lib/tripTrustGate.js"; // D-24a: the ONE solo/group test

/** What each restriction type refuses at a SEND (see header). */
export const RESTRICTION_SEND_SCOPE: Readonly<Record<RestrictionType, "initiating_contact" | "none">> = {
  messaging: "initiating_contact",
  hosting: "none",
  private_plan_access: "none",
  location_plan_join: "none",
};

/** The sentence the person is shown for a messaging restriction refusal. */
export const RESTRICTED_SEND_MESSAGE =
  "Your account can't start new conversations right now. You can still reply to people who have written " +
  "to you, and you can appeal this decision.";

/** The sentence for a restriction state we could not read. Never the restriction's own sentence. */
export const RESTRICTION_UNKNOWN_MESSAGE =
  "We could not check your account's messaging status right now. Please try again shortly.";

export interface RestrictionSendFacts {
  /** The sender's restriction state, or null when it was not needed (and so not read). */
  readonly restriction: Pick<RestrictionState, "activeRestrictions" | "degraded" | "degradedReason"> | null;
  /**
   * Whether this send would initiate contact. `null` = the facts it rests on
   * could not be read. Only meaningful when a messaging restriction is active.
   */
  readonly initiatesContact: boolean | null;
}

export type RestrictionSendVerdict =
  | { readonly allowed: true; readonly reason: null }
  | {
      readonly allowed: false;
      readonly refusal: "restricted";
      readonly restrictionType: RestrictionType;
      readonly reason: TelegraphReason;
      readonly message: string;
    }
  | { readonly allowed: false; readonly refusal: "unknown"; readonly reason: TelegraphReason; readonly message: string };

/** The ONE decision. Pure. The guard and the capabilities projection both call it. */
export function decideRestrictedSend(facts: RestrictionSendFacts, opts: { safety: boolean }): RestrictionSendVerdict {
  if (opts.safety) return { allowed: true, reason: null };
  const r = facts.restriction;
  if (r === null) return { allowed: true, reason: null };
  if (r.degraded && r.degradedReason === "fail_closed") {
    return { allowed: false, refusal: "unknown", reason: "TELEGRAPH_DEGRADED_TRUST_UNREADABLE", message: RESTRICTION_UNKNOWN_MESSAGE };
  }
  for (const type of r.activeRestrictions) {
    if (RESTRICTION_SEND_SCOPE[type] !== "initiating_contact") continue;
    if (facts.initiatesContact === null) {
      return { allowed: false, refusal: "unknown", reason: "TELEGRAPH_DEGRADED_TRUST_UNREADABLE", message: RESTRICTION_UNKNOWN_MESSAGE };
    }
    if (facts.initiatesContact) {
      return {
        allowed: false,
        refusal: "restricted",
        restrictionType: type,
        reason: "TELEGRAPH_SAFETY_TRUST_RESTRICTED",
        message: RESTRICTED_SEND_MESSAGE,
      };
    }
  }
  return { allowed: true, reason: null };
}

/**
 * The OTHER Telegraph capabilities a restriction reaches, in the same place as
 * the send scope so the whole OD-TRUST-5 reading is one table (census-telegraph
 * §45d, re-verification 5). DECIDED by lead ruling D-24 (2026-10-06): a
 * capability no restriction sentence names is not refused.
 *   canCall                none of its own. A call is refused under messaging
 *                          exactly where a SEND is — where it would start a new
 *                          conversation, which is what the sentence names. The
 *                          projection derives it from canSendMessage, and the
 *                          call gateway asks decideRestrictedSendInThread (foot).
 *   canCreatePlan          hosting — "change a group trip's shared plan" — and
 *                          ONLY for a group trip: never a direct or circle
 *                          conversation's plan, never a solo trip (D-24a). Applied
 *                          to the plan's target by decidePlanCreation (foot);
 *                          Compass's plan draft is the enforcing consumer.
 *   canShareExactLocation  none: D-24's table, a location-plan restriction stops
 *                          "nothing in Compass or messaging". Never true (§15.1).
 *
 * Same fail direction as a send: an unreadable state refuses a capability some
 * restriction could reach, retryably; a capability no restriction reaches is
 * decided without it.
 */
export const RESTRICTION_CAPABILITY_SCOPE: Readonly<Record<"canCall" | "canCreatePlan" | "canShareExactLocation", readonly RestrictionType[]>> = {
  canCall: [],
  canCreatePlan: ["hosting"],
  canShareExactLocation: [],
};

export function decideRestrictedCapability(
  capability: keyof typeof RESTRICTION_CAPABILITY_SCOPE,
  restriction: Pick<RestrictionState, "activeRestrictions" | "degraded" | "degradedReason">,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: TelegraphReason } {
  const scope = RESTRICTION_CAPABILITY_SCOPE[capability];
  if (scope.length === 0) return { allowed: true };
  if (restriction.degraded && restriction.degradedReason === "fail_closed") {
    return { allowed: false, reason: "TELEGRAPH_DEGRADED_TRUST_UNREADABLE" };
  }
  if (restriction.activeRestrictions.some((t) => scope.includes(t))) {
    return { allowed: false, reason: "TELEGRAPH_SAFETY_TRUST_RESTRICTED" };
  }
  return { allowed: true };
}

/** A participant id that is safe to place inside a PostgREST `or()` filter. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The thread types whose roster a source domain decides: writing there never initiates contact. */
const SOURCE_DOMAIN_ROSTERS: readonly string[] = ["trip", "circle"];

/**
 * Establish the facts `decideRestrictedSend` needs, reading only what it can
 * use. A safety send reads nothing. A send that cannot initiate contact — a
 * trip or circle thread, or a thread with anything but exactly one other
 * active member — reads nothing either, because no restriction type refuses it.
 * Otherwise: the restriction state (unless the caller already holds it), and
 * only when a contact-scoped restriction is active, whether the other person
 * has ever written in this thread, accepted (or sent) a message request between
 * the two, or owns a booking that this thread belongs to. Any of those reads
 * failing is `initiatesContact: null` — a retryable refusal, never a guess.
 */
export async function readRestrictionSendFacts(
  sc: SupabaseClient,
  input: {
    threadId: string;
    senderId: string;
    /** `message_threads.thread_type`; null when not known (read as `direct`, the side that checks). */
    threadType: string | null;
    otherMemberIds: readonly string[];
    safety: boolean;
    /** Pass the state if the caller already read it, so it is read once. */
    restriction?: RestrictionState;
  },
): Promise<RestrictionSendFacts> {
  if (input.safety) return { restriction: null, initiatesContact: false };
  const counterpartId = input.otherMemberIds.length === 1 ? input.otherMemberIds[0]! : null;
  if (counterpartId === null || SOURCE_DOMAIN_ROSTERS.includes(input.threadType ?? "direct")) {
    return { restriction: null, initiatesContact: false };
  }
  const restriction = input.restriction ?? (await getRestrictionState(sc, input.senderId));
  const contactScoped = restriction.activeRestrictions.some((t) => RESTRICTION_SEND_SCOPE[t] === "initiating_contact");
  if (!contactScoped) return { restriction, initiatesContact: false };

  const { data: theirs, error: theirsErr } = await sc
    .from("messages")
    .select("id")
    .eq("thread_id", input.threadId)
    .eq("sender_id", counterpartId)
    .limit(1);
  if (theirsErr) return { restriction, initiatesContact: null };
  if (((theirs as unknown[]) ?? []).length > 0) return { restriction, initiatesContact: false };

  // An ACCEPTED request between the two, either way round, is the other person
  // having engaged. Both ids are interpolated into a PostgREST filter, so a
  // value that is not a UUID is refused as unknown rather than built into one.
  if (!UUID_SHAPE.test(input.senderId) || !UUID_SHAPE.test(counterpartId)) return { restriction, initiatesContact: null };
  const { data: accepted, error: acceptedErr } = await sc
    .from("message_requests")
    .select("id")
    .eq("status", "accepted")
    .or(
      `and(sender_id.eq.${input.senderId},recipient_id.eq.${counterpartId}),` +
        `and(sender_id.eq.${counterpartId},recipient_id.eq.${input.senderId})`,
    )
    .limit(1);
  if (acceptedErr) return { restriction, initiatesContact: null };
  if (((accepted as unknown[]) ?? []).length > 0) return { restriction, initiatesContact: false };

  const { data: booking, error: bookingErr } = await sc
    .from("rent_buddy_bookings")
    .select("id")
    .eq("telegraph_thread_id", input.threadId)
    .limit(1);
  if (bookingErr) return { restriction, initiatesContact: null };
  return { restriction, initiatesContact: ((booking as unknown[]) ?? []).length === 0 };
}

// ── D-24 on the other capabilities (lane T, 2026-10-07) ─────────────────────
// Appended at the foot so every line cited above keeps its number.
//
// Lead ruling D-24 (docs/ops/lead-rulings-20261006.md): "The sentence a
// restricted person is shown must name every capability that restriction
// stops. Anything not named in that sentence must not be refused." The
// sentences (services/trust/TrustPrivacyGuard.ts, as amended):
//   hosting    "You cannot host group trips, change a group trip's shared plan,
//               or start or link public Trails. You also cannot be booked as a
//               Buddy."
//   messaging  "You cannot start new conversations, propose changes to a group
//               trip, submit public content (…), or have your posts boosted."
// Before this, the Telegraph projection refused three things no sentence names:
// a plan in a direct or circle conversation (and on a solo trip) under hosting,
// a call in an established conversation or a crew room under messaging, and
// group seen state under ANY restriction. The send rule above already followed
// the sentence; these now follow it the same way.

/** Where a plan made in a conversation would land. */
export type PlanTarget = "conversation" | "solo_trip" | "group_trip" | "unknown_trip";

/**
 * May a plan be created here, as far as a Trust restriction is concerned?
 *
 *   conversation   a direct or circle conversation's plan: no sentence names
 *                  it, so no restriction refuses it — not even an unreadable
 *                  state (a capability no restriction reaches is decided
 *                  without it).
 *   solo_trip      D-24a: a hosting restriction does not stop changes to a solo
 *                  trip. Allowed without consulting the restriction.
 *   group_trip     hosting refuses ("change a group trip's shared plan");
 *                  an unreadable state refuses retryably.
 *   unknown_trip   D-24a: "If whether a trip is solo cannot be read, treat it
 *                  as a group trip and refuse with 'try again', never with
 *                  'restricted'." Unrestricted, a group trip is allowed.
 */
export function decidePlanCreation(
  restriction: Pick<RestrictionState, "activeRestrictions" | "degraded" | "degradedReason">,
  target: PlanTarget,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: TelegraphReason } {
  if (target === "conversation" || target === "solo_trip") return { allowed: true };
  const verdict = decideRestrictedCapability("canCreatePlan", restriction);
  if (verdict.allowed || target === "group_trip") return verdict;
  return { allowed: false, reason: "TELEGRAPH_DEGRADED_TRUST_UNREADABLE" };
}

/** True when some restriction on this state could reach canCreatePlan — only then is the trip's shape read. */
export function planRestrictionMayApply(
  restriction: Pick<RestrictionState, "activeRestrictions" | "degradedReason">,
): boolean {
  return restriction.degradedReason === "fail_closed" ||
    restriction.activeRestrictions.some((t) => RESTRICTION_CAPABILITY_SCOPE.canCreatePlan.includes(t));
}

// (The accepted-role list now lives in lib/tripTrustGate.ts with the solo/group test itself.)

/**
 * The solo/group test, D-24a. Solo: nobody but the actor is an accepted
 * member — an accepted role (owner, co_host, member, viewer) with status
 * accepted or unset, and the trip's owner counts even without a trip_members
 * row. Invited people do not make a trip a group trip. Either read failing,
 * throwing, or the trip row being absent is `unknown_trip`.
 *
 * D-24a asks every Compass and Trips door to apply ONE test, so this is now a
 * call to lane C's lib/tripTrustGate.ts `readTripShape` (on main through #650),
 * the function every Trips door and lane L's Compass gate call — no second copy
 * of the rule (census-telegraph §61; telegraphPlanTargetOneTest.test.ts).
 */
export async function readPlanTarget(
  sc: SupabaseClient,
  input: { tripId: string | null; threadType: string; actorId: string },
): Promise<PlanTarget> {
  if (!input.tripId) return input.threadType === "trip" ? "unknown_trip" : "conversation";
  const shape = await readTripShape(sc, input.tripId, input.actorId);
  return shape.kind === "solo" ? "solo_trip" : shape.kind === "group" ? "group_trip" : "unknown_trip";
}

/**
 * The restriction term of a SEND in one thread, read end to end — the thread's
 * type, its other active members, then `readRestrictionSendFacts` and
 * `decideRestrictedSend`. For a caller that is not a send door and holds only
 * a thread id: the call gateway, so a 1:1 call is refused under messaging
 * exactly where a message would be. A failed read is `unknown`, never allowed.
 */
export async function decideRestrictedSendInThread(
  sc: SupabaseClient,
  threadId: string,
  senderId: string,
  /** Pass the state if the caller already read it, so it is read once. */
  alreadyRead?: RestrictionState,
): Promise<RestrictionSendVerdict> {
  const restriction = alreadyRead ?? (await getRestrictionState(sc, senderId));
  const mayApply =
    restriction.degradedReason === "fail_closed" ||
    restriction.activeRestrictions.some((t) => RESTRICTION_SEND_SCOPE[t] !== "none");
  if (!mayApply) return { allowed: true, reason: null };
  const [{ data: thread, error: threadErr }, { data: others, error: othersErr }] = await Promise.all([
    sc.from("message_threads").select("thread_type").eq("id", threadId).maybeSingle(),
    sc.from("message_thread_members").select("user_id").eq("thread_id", threadId).is("left_at", null).neq("user_id", senderId),
  ]);
  if (threadErr || othersErr) {
    return { allowed: false, refusal: "unknown", reason: "TELEGRAPH_DEGRADED_TRUST_UNREADABLE", message: RESTRICTION_UNKNOWN_MESSAGE };
  }
  return decideRestrictedSend(
    await readRestrictionSendFacts(sc, {
      threadId,
      senderId,
      threadType: ((thread as { thread_type?: unknown } | null)?.thread_type as string | undefined) ?? null,
      otherMemberIds: ((others as Array<{ user_id?: unknown }>) ?? []).map((m) => String(m.user_id)),
      safety: false,
      restriction,
    }),
    { safety: false },
  );
}
