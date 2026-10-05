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
 *                         person has never written in, and which no booking
 *                         owns (a booking is contact both parties entered into).
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
 * needed". THIS MAPPING IS A READING, NOT AN OWNER DECISION, and it is listed
 * for confirmation in the lane T2 report. The broader alternative — messaging
 * restriction refuses EVERY non-safety send — is one line here
 * (`initiatesContact` → true for every direct and group send), and would also
 * need the sentence the person is shown to change.
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
import type { TelegraphReason } from "../contracts/telegraphReasonCodes.js";

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

/** The thread types whose roster a source domain decides: writing there never initiates contact. */
const SOURCE_DOMAIN_ROSTERS: readonly string[] = ["trip", "circle"];

/**
 * Establish the facts `decideRestrictedSend` needs, reading only what it can
 * use. A safety send reads nothing. A send that cannot initiate contact — a
 * trip or circle thread, or a thread with anything but exactly one other
 * active member — reads nothing either, because no restriction type refuses it.
 * Otherwise: the restriction state (unless the caller already holds it), and
 * only when a contact-scoped restriction is active, whether the other person
 * has ever written in this thread or owns a booking that this thread belongs to.
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

  const { data: booking, error: bookingErr } = await sc
    .from("rent_buddy_bookings")
    .select("id")
    .eq("telegraph_thread_id", input.threadId)
    .limit(1);
  if (bookingErr) return { restriction, initiatesContact: null };
  return { restriction, initiatesContact: ((booking as unknown[]) ?? []).length === 0 };
}
