/**
 * SafetyReviewService — the authorized principal behind a safety assertion.
 *
 * WHAT THIS CLOSES
 * ================
 * `unsafe_density` was carved out of the crowd vocabulary as "specialist review
 * only", and the Map producer has always read exactly that value — but the
 * specialist was never built. The only enforcement was a client-side refusal in
 * quickSignal's validator, so the level was unreachable rather than reviewed.
 * This service is the review station: the one place a safety claim can be moved
 * through its lifecycle, by an authorized person, with the decision recorded.
 *
 * WHY IT IS NOT `approveClaim`
 * ============================
 * IntelCaptureService.approveClaim already promotes candidate -> active under
 * requireAdmin, and it is correct for ordinary intel. It is NOT sufficient for a
 * safety assertion, for two reasons that matter:
 *
 *   1. It does not consult safety policy. It would activate an `unsafe_density`
 *      claim exactly as it activates a `queue.wait` claim — no check that the
 *      assertion is place-anchored, no check that the status transition is one
 *      safety permits, no distinction between a reviewed assertion and a
 *      corroborated one.
 *   2. Its provenance is `promotion_source = 'admin'` — a literal, not an
 *      identity. For "how busy is this bar" that is proportionate. For "people
 *      here are in danger" it is not: the decision has to be explainable later
 *      from the evidence AND the principal who approved it.
 *
 * So safety transitions go through here, and every one of them writes an
 * intel_claim_reviews row. approveClaim is left untouched for ordinary intel.
 *
 * AUTHORIZATION IS ENFORCED HERE, NOT AT THE ROUTE
 * ================================================
 * The owner's ruling is explicit: admin is the v1 reviewer, but "do not interpret
 * admin as meaning every admin-facing endpoint automatically gets safety mutation
 * power — the safety service itself must authorize the transition." So this
 * module takes a resolved reviewer identity and re-checks the capability itself.
 * A caller that has merely passed some other admin gate cannot mutate safety
 * state by reaching this function.
 *
 * The capability is expressed as `canReviewSafety(role)` rather than as a role
 * comparison inline, so that when a dedicated reviewer role or capability table
 * replaces "admin" later, exactly one function changes and the safety domain
 * model does not.
 */
import {
  evaluateSafetyPublication,
  isSafetyAssertion,
  type SafetyAuthority,
} from "../../lib/safetyPolicy.js";
import { logger as rootLogger } from "../../lib/logger.js";

export const safetyReviewLogger = rootLogger.child({ service: "SafetyReviewService" });

/** The policy identifier written into every review row, so an activation stays explainable. */
export const SAFETY_REVIEW_POLICY_REF = "safetyPolicy.v1";

/**
 * Roles that may review safety claims.
 *
 * v1 reuses the existing global admin identity rather than adding a
 * `safety_reviewer` value to profiles_role_check, which is a security surface.
 * This is the ONE place that decision is expressed: replacing it with a
 * capability lookup later changes this function and nothing else.
 */
export type ReviewerRole = string | null | undefined;

export function canReviewSafety(role: ReviewerRole): boolean {
  return role === "admin" || role === "owner";
}

export type SafetyReviewAction = "approve" | "reject" | "retract" | "reconfirm" | "supersede";

/**
 * The transitions safety review permits, as data.
 *
 * A transition absent from this table is not merely unimplemented — it is
 * refused. That matters most for `conflicting`: an ordinary intel claim in
 * conflict is served at a lowered confidence band, but a safety claim in
 * conflict must not be force-published. There is deliberately NO
 * conflicting -> active entry. Resolving a conflict means superseding the claim
 * with a new reviewed one, which leaves both the old assertion and the decision
 * inspectable, rather than flipping a disputed row to active and losing the
 * dispute.
 */
export const PERMITTED_TRANSITIONS: Readonly<Record<SafetyReviewAction, Readonly<Record<string, string>>>> = {
  approve:   { candidate: "active" },
  reject:    { candidate: "rejected" },
  retract:   { active: "retracted", conflicting: "retracted" },
  reconfirm: { active: "active" },
  supersede: { active: "superseded", conflicting: "superseded" },
};

export type SafetyReviewResult =
  | { ok: true; claimId: string; priorStatus: string; newStatus: string; reviewId: string | null }
  | { ok: false; reason: SafetyReviewRefusal; detail?: string };

export type SafetyReviewRefusal =
  | "not_authorized"
  | "claim_not_found"
  | "not_a_safety_claim"
  | "transition_not_permitted"
  | "policy_refused"
  | "conflict"
  | "db_error";

export interface SafetyReviewInput {
  claimId: string;
  /** The resolved reviewer. Identity is required — a review with no principal is not a review. */
  reviewerId: string;
  reviewerRole: ReviewerRole;
  action: SafetyReviewAction;
  reason?: string | null;
}

/**
 * Move a safety claim through its lifecycle under review.
 *
 * FAILURE SEMANTICS. Every refusal names its own cause and NONE of them is
 * silent. A caller must be able to tell "this claim is not a safety claim" from
 * "you are not authorized" from "the database read failed" — because the
 * downstream consequence of collapsing those is a map that shows no warning and
 * a system that cannot say whether that means safety or ignorance.
 */
export async function reviewSafetyClaim(
  db: any,
  input: SafetyReviewInput,
): Promise<SafetyReviewResult> {
  // 1. AUTHORIZATION, re-checked here rather than trusted from the caller.
  if (!canReviewSafety(input.reviewerRole)) {
    return { ok: false, reason: "not_authorized" };
  }
  if (typeof input.reviewerId !== "string" || input.reviewerId === "") {
    // A transition with no attributable principal cannot be audited, so it is
    // not permitted — even for an authorized role.
    return { ok: false, reason: "not_authorized", detail: "no reviewer identity" };
  }

  // 2. Load the claim. A read failure is NOT "no such claim".
  let claim: any;
  try {
    const { data, error } = await db
      .from("intel_claims")
      .select("id, claim_type, value, status, subject_id")
      .eq("id", input.claimId)
      .maybeSingle();
    if (error) {
      safetyReviewLogger.warn({ err: error, claimId: input.claimId }, "safety review: claim read failed");
      return { ok: false, reason: "db_error", detail: String(error?.message ?? "read failed") };
    }
    if (!data) return { ok: false, reason: "claim_not_found" };
    claim = data;
  } catch (err) {
    safetyReviewLogger.warn({ err, claimId: input.claimId }, "safety review: claim read threw");
    return { ok: false, reason: "db_error" };
  }

  // 3. This service governs SAFETY claims only. An ordinary claim keeps taking
  //    the ordinary path — routing it here would quietly give it safety
  //    semantics it never earned.
  if (!isSafetyAssertion(claim.claim_type, claim.value)) {
    return { ok: false, reason: "not_a_safety_claim" };
  }

  // 4. The transition must be one safety permits, from this exact prior status.
  const priorStatus = String(claim.status ?? "");
  const newStatus = PERMITTED_TRANSITIONS[input.action]?.[priorStatus];
  if (!newStatus) {
    return {
      ok: false,
      reason: "transition_not_permitted",
      detail: `${input.action} from '${priorStatus}' is not a permitted safety transition`,
    };
  }

  // 5. Activating means publishing. Ask the policy, with the authority this
  //    review actually carries — never a stronger one. A reviewer approving a
  //    claim does not make it officially sourced.
  if (newStatus === "active") {
    const decision = evaluateSafetyPublication({
      claimType: claim.claim_type,
      value: claim.value,
      status: newStatus,
      authority: "admin_review" as SafetyAuthority,
      subjectPlaceId: typeof claim.subject_id === "string" ? claim.subject_id : null,
      distinctActors: 1,
    });
    if (!decision.publishable) {
      return { ok: false, reason: "policy_refused", detail: decision.reason };
    }
  }

  // 6. Compare-and-set on the prior status, so two concurrent reviews collapse
  //    into one instead of racing to overwrite each other's decision.
  let updated: any;
  try {
    const { data, error } = await db
      .from("intel_claims")
      .update({ status: newStatus })
      .eq("id", input.claimId)
      .eq("status", priorStatus)
      .select("id, status")
      .maybeSingle();
    if (error) {
      safetyReviewLogger.warn({ err: error, claimId: input.claimId }, "safety review: transition failed");
      return { ok: false, reason: "db_error", detail: String(error?.message ?? "update failed") };
    }
    if (!data) {
      // The claim left `priorStatus` between the read and the write. Say so
      // rather than reporting a transition that did not happen.
      return { ok: false, reason: "conflict", detail: "claim changed state during review" };
    }
    updated = data;
  } catch (err) {
    safetyReviewLogger.warn({ err, claimId: input.claimId }, "safety review: transition threw");
    return { ok: false, reason: "db_error" };
  }

  // 7. Record the decision. The reviewer identity and reason are written HERE
  //    and nowhere else — they are restricted moderation data and must never
  //    reach a projection. A failed audit write does not roll the transition
  //    back (the claim has already moved and pretending otherwise would be a
  //    worse lie), but it IS surfaced, and reviewId comes back null so the
  //    caller can see the trail is incomplete rather than assuming it is not.
  let reviewId: string | null = null;
  try {
    const { data, error } = await db
      .from("intel_claim_reviews")
      .insert({
        claim_id:     input.claimId,
        reviewer_id:  input.reviewerId,
        action:       input.action,
        prior_status: priorStatus,
        new_status:   newStatus,
        reason:       input.reason ?? null,
        policy_ref:   SAFETY_REVIEW_POLICY_REF,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      safetyReviewLogger.warn(
        { err: error, claimId: input.claimId, action: input.action },
        "safety review: AUDIT WRITE FAILED — the transition happened but is unattributed",
      );
    } else {
      reviewId = (data as any)?.id ?? null;
    }
  } catch (err) {
    safetyReviewLogger.warn({ err, claimId: input.claimId }, "safety review: audit write threw");
  }

  return {
    ok: true,
    claimId: input.claimId,
    priorStatus,
    newStatus: String(updated.status ?? newStatus),
    reviewId,
  };
}
