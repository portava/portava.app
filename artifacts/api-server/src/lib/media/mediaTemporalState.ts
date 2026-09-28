/**
 * mediaTemporalState — the §11 `MediaTemporalState` contract.
 *
 *   interface MediaTemporalState {
 *     socialExpiresAt?: string;
 *     intelligenceExpiresAt?: string;
 *     locationDisclosureExpiresAt?: string;
 *   }
 *
 *   "A media item can remain social or memorial content after its operational
 *    intelligence value expires."
 *
 * PURE. The three lifetimes are INDEPENDENT by construction — each member is
 * derived from its own input and none reads another — which is the whole point
 * of §11: a photograph whose intelligence lifetime has ended is still a post,
 * and nothing here can end the post because the intelligence ended.
 *
 * WHAT EACH MEMBER IS TODAY, STATED RATHER THAN IMPLIED:
 *
 *   intelligenceExpiresAt  PRODUCED. The §10 `expiresAt` of the asset's
 *                          IntelligenceEligibility (capture + 24 h, eligible
 *                          assets only — mediaEvidenceEligibility). Absent for
 *                          an asset with no operational intelligence value
 *                          (ineligible source, generative edit, no capture
 *                          time), because there is nothing to expire.
 *   socialExpiresAt        NOT PRODUCED. No media-bearing object in the §6.1
 *                          entity set has a social expiry: posts, postcards,
 *                          memories and gems are permanent until deleted.
 *                          (Stories expire, but a story is not a §6.1 entity.)
 *                          Absent therefore means "no social expiry", which is
 *                          true — not "unknown". Producing one is a product
 *                          decision about ephemeral media, census-media MD77.
 *   locationDisclosureExpiresAt
 *                          NOT PRODUCED. Location disclosure in this product
 *                          only BEGINS (delayed publishing, lib/delayedPostPublisher);
 *                          nothing ends it. Absent is again the truth. Making it
 *                          end is census-media MD79, and needs a decided policy.
 *
 * The object is serialised ONLY with the members that exist — an absent member
 * is omitted, never `null`, so a client cannot read `null` as "expired".
 */
import type { IntelligenceEligibility } from "./mediaEvidenceEligibility.js";

/** §11 MediaTemporalState. Every member optional, exactly as the spec types it. */
export interface MediaTemporalState {
  socialExpiresAt?: string;
  intelligenceExpiresAt?: string;
  locationDisclosureExpiresAt?: string;
}

export interface MediaTemporalInput {
  /**
   * The asset's §10 eligibility, when one could be computed. Null for media
   * served from a legacy store, which carries no provenance and so has no
   * operational intelligence value to expire.
   */
  eligibility: Pick<IntelligenceEligibility, "eligible" | "expiresAt"> | null; /** §11 location-disclosure end, when a producer has one (census-media §36, MD79). NONE does yet; absent ⇒ the member is omitted, as before. */ locationDisclosureExpiresAt?: string | null;
}

function validIso(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * Resolve the §11 state for one media item. The intelligence member comes ONLY
 * from an eligible asset's own expiry; an ineligible asset carrying a stale
 * `expiresAt` (a row written before a generative edit, say) yields none.
 */
export function resolveMediaTemporalState(input: MediaTemporalInput): MediaTemporalState {
  const out: MediaTemporalState = {};
  const e = input.eligibility;
  if (e && e.eligible === true) {
    const at = validIso(e.expiresAt);
    if (at) out.intelligenceExpiresAt = at;
  }
  // §11 locationDisclosureExpiresAt — served only when a producer supplies a
  // valid instant (census-media §36). The disclosure itself is capped at the
  // choke point (mediaLocationVisibility.resolveMediaPlaceDisclosure), not here.
  const disclosureEnds = validIso(input.locationDisclosureExpiresAt);
  if (disclosureEnds) out.locationDisclosureExpiresAt = disclosureEnds;
  return out;
}

/**
 * Is the intelligence lifetime over at `nowMs`? An item with no intelligence
 * lifetime is treated as expired (it has no operational value), which is the
 * fail-closed reading for any caller asking "may this back a current claim".
 * It says NOTHING about social use — §11.
 */
export function intelligenceExpired(state: MediaTemporalState, nowMs: number): boolean {
  if (!state.intelligenceExpiresAt) return true;
  return nowMs >= new Date(state.intelligenceExpiresAt).getTime();
}
