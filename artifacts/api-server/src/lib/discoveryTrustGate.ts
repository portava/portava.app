/**
 * Trust restrictions at Discovery's publishing doors (census-trust TRV2-08,
 * owner decision OD-TRUST-5: restrictions enforced "across all relevant APIs and
 * surfaces"; census-discovery §84).
 *
 * Discovery had none: a person restricted from hosting or from messaging could
 * still start a Trail — which publishes a `proposed` Trail to every user at once
 * — attach content to one, suggest to a curator, link Trails, submit a hidden
 * gem, add to one, or submit a community place.
 *
 * THE MAPPING — LANE C'S READING, FOR THE OWNER TO CONFIRM. There are four
 * restriction types (services/trust/TrustRestrictionService.ts) and none is
 * named for publishing, so each door is mapped to the one whose PURPOSE it
 * shares:
 *
 *   hosting  ("cannot create new group trips": convening a shared space other
 *            people join)
 *     - start a Trail                       POST /v1/discovery/trails
 *     - link two Trails                     POST /v1/discovery/trails/:id/relations
 *   messaging ("cannot initiate new conversations": reaching people who did
 *            not ask)
 *     - attach content to a Trail           POST /v1/discovery/trails/:id/content
 *     - suggest content to a Trail          POST /v1/discovery/trails/:id/suggestions
 *     - submit a hidden gem                 POST /hidden-gems
 *     - contribute to a hidden gem          POST /hidden-gems/:id/contribute
 *     - submit a community place            POST /discovery/community
 *
 * Not mapped, and why: saves, follows and collections are the person's own
 * (nothing reaches anyone else); reports go TO moderation and must never be
 * blocked by it; the gem share into a thread is a Telegraph send and already
 * holds Telegraph's gates. A fifth restriction type for publishing would be a
 * closer fit than either of the two used here; that is the owner's to add.
 *
 * TRIPS DOORS TOO (census-trips §84; the coordinator's addition after lane L's
 * Compass gate): the same seam guards the Trips doors that do what Compass now
 * refuses — see lib/tripTrustGate.ts.
 *
 * THE WORDS ARE THE RESTRICTION'S OWN. A refusal says the sentence the person
 * is shown for that restriction (services/trust/TrustPrivacyGuard.ts
 * RESTRICTION_MESSAGES — "You cannot host group trips at this time.", "You
 * cannot initiate new conversations at this time."), so nobody is refused more
 * than they were told; the test pins the two strings to that file.
 *
 * AN UNREADABLE STATE REFUSES, AND NEVER SAYS "RESTRICTED". getRestrictionState
 * answers `degraded` in two shapes — fail_closed (the read failed) and
 * fail_open (the table is not migrated) — and a throw is a third. All three
 * mean nobody could read this person's restrictions, and an action that
 * publishes or organises for them is not taken on a guess: 503
 * `degraded_unavailable`, retryable, worded as a check that could not be done.
 * This matches lane L's Compass gate, so the two surfaces cannot disagree about
 * the same person.
 */
import type { Response } from "express";

import { getRestrictionState, type RestrictionState } from "../services/trust/TrustRestrictionService.js";
import { sendError } from "./http.js";

export type GatedRestriction = "hosting" | "messaging";
/** Kept for the Discovery call sites. */
export type DiscoveryRestriction = GatedRestriction;

/** TrustPrivacyGuard's sentences, verbatim (pinned by test). */
export const RESTRICTION_SENTENCES: Readonly<Record<GatedRestriction, string>> = Object.freeze({
  hosting: "You cannot host group trips at this time.",
  messaging: "You cannot initiate new conversations at this time.",
});

export const RESTRICTION_UNVERIFIABLE_MESSAGE =
  "We could not verify your permissions right now, so nothing was changed. Please try again shortly.";

export type TrustVerdict =
  | { allowed: true }
  | { allowed: false; kind: "unverifiable" }
  | { allowed: false; kind: "restricted"; restrictionTypes: GatedRestriction[] };

/** The decision from a state already read. ANY listed restriction, if active, refuses. */
export function decideTrustAction(state: RestrictionState, restrictions: readonly GatedRestriction[]): TrustVerdict {
  if (state.degraded) return { allowed: false, kind: "unverifiable" };
  const can: Record<GatedRestriction, boolean> = { hosting: state.canHost, messaging: state.canMessage };
  const hit = restrictions.filter((r) => !can[r]);
  return hit.length === 0 ? { allowed: true } : { allowed: false, kind: "restricted", restrictionTypes: hit };
}

/** Read, decide, and answer. Returns true when it has refused (the caller returns). */
export async function refuseIfTrustRestricted(
  res: Response,
  sc: Parameters<typeof getRestrictionState>[0] | null,
  userId: string,
  restriction: GatedRestriction | readonly GatedRestriction[],
): Promise<boolean> {
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return true; }
  let verdict: TrustVerdict;
  try {
    verdict = decideTrustAction(await getRestrictionState(sc, userId), typeof restriction === "string" ? [restriction] : restriction);
  } catch {
    verdict = { allowed: false, kind: "unverifiable" };
  }
  if (verdict.allowed) return false;
  if (verdict.kind === "unverifiable") { sendError(res, "degraded_unavailable", RESTRICTION_UNVERIFIABLE_MESSAGE); return true; }
  res.status(403).json({
    error: "trust_restriction",
    message: verdict.restrictionTypes.map((t) => RESTRICTION_SENTENCES[t]).join(" "),
    restrictionTypes: verdict.restrictionTypes,
  });
  return true;
}
