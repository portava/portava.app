/**
 * creatorServedRecommendation — binding a CLAIMED recommendation id to the
 * served exposure it names, before an attribution may carry it. PURE.
 *
 * census-discovery DV-26 (`02` §17: a Trail attribution preserves
 * `recommendation_id`), DV-67 (`09` §11 "attribution is linked"), `08` §4
 * ("Every monetizable action should be able to link back to:
 * recommendation_id, user/session, …").
 *
 * ── WHERE THE ID COMES FROM, AND WHY IT IS NEVER TRUSTED ────────────────────
 * Every served Discovery item carries a `recommendationId` minted by
 * `lib/discoveryRecommendationRecord.ts#servedRecommendationId` over the ONE
 * exposure of its request, and a signed-in viewer's exposure is stored as a
 * `rank_events` row carrying that id (2891). A client that later reports a
 * conversion can quote the id — and a client can quote ANY id, including one
 * it read off somebody else's screen. So the id is a CLAIM, and what an
 * attribution stores is the result of binding that claim to an exposure, by
 * the same rule P3's outcome route binds an outcome (`bindOutcomeToExposure`):
 *
 *   • the exposure row must be the CONVERTING VIEWER's own — another viewer's
 *     id, an anonymous id (no rank_events row, by 3376's design) and an
 *     unknown id all bind nothing, and the refusal never says which;
 *   • when the conversion names the item it concerns, the exposure must be of
 *     that item;
 *   • the exposure must have been served NO LATER than the conversion
 *     happened — a recommendation served after the action cannot have led to
 *     it. That is causality, not an attribution window: HOW LONG before a
 *     conversion an exposure may still be credited, and whether a mere
 *     impression (view-through) counts or only a tap (click-through), are
 *     commercial rules this module does not invent (census §52's owner
 *     questions).
 *
 * The one output is a `BoundRecommendation`, which only `bindServedRecommendation`
 * constructs. `CreatorAttributionService.recordCreatorAttribution` accepts a
 * recommendation ONLY in that form, so a raw client string cannot reach the
 * column by any typed path.
 *
 * Consumes P3's contract (`isRecommendationId`, `canonicalServedAt`); changes
 * nothing in it.
 */
import { canonicalServedAt, isRecommendationId } from "./discoveryRecommendationRecord.js";

declare const BOUND: unique symbol;

/** A recommendation id that was bound to the converting viewer's own exposure. */
export interface BoundRecommendation {
  readonly [BOUND]: true;
  readonly recommendationId: string;
  /** The rank_events row the id was bound to. */
  readonly exposureRowId: string;
  readonly viewerUserId: string;
  readonly itemId: string;
  readonly surface: string;
  /** Canonical ISO-8601. */
  readonly servedAt: string;
}

export interface RecommendationClaim {
  /** The signed-in viewer who converted — from the session, never the body. */
  viewerUserId: string;
  /** What the client quoted. Shape-checked here; bound below. */
  recommendationId: unknown;
  /** The item the conversion concerns, when the caller knows it. */
  itemId?: string | null;
  /** When the conversion happened (ISO-8601). Absent ⇒ the causality check is skipped. */
  occurredAt?: string | null;
}

/** The exposure row as read back, filtered on (user_id = viewer, recommendation_id = id). */
export interface ExposureRowLike {
  id?: unknown;
  user_id?: unknown;
  item_id?: unknown;
  surface?: unknown;
  served_at?: unknown;
  recommendation_id?: unknown;
}

export type RecommendationBindingRefusal =
  /** Not the 22-character shape 2891 admits. Nothing was read. */
  | "malformed_recommendation_id"
  /** Another viewer's, anonymous, unknown or pruned. Never says which. */
  | "recommendation_not_found"
  /** The exposure is of a different item than the conversion names. */
  | "recommendation_item_mismatch"
  /** Served after the conversion happened: it cannot have led to it. */
  | "recommendation_served_after_conversion";

export type RecommendationBinding =
  | { ok: true; value: BoundRecommendation }
  | { ok: false; reason: RecommendationBindingRefusal; detail: string };

const refuse = (reason: RecommendationBindingRefusal, detail: string): RecommendationBinding =>
  ({ ok: false, reason, detail });

/** Step one, before any read: is the claim even the right shape? */
export function checkRecommendationClaimShape(claim: RecommendationClaim): RecommendationBinding | null {
  if (!isRecommendationId(claim.recommendationId)) {
    return refuse("malformed_recommendation_id", "a recommendation id is 22 base64url characters (2891)");
  }
  if (typeof claim.viewerUserId !== "string" || claim.viewerUserId.length === 0) {
    // No viewer, no binding: an anonymous exposure can never be credited.
    return refuse("recommendation_not_found", "no signed-in viewer to bind to");
  }
  return null;
}

/**
 * Bind a claim to the row a (viewer, id)-filtered read returned.
 *
 * The owner is checked AGAIN here, as `bindOutcomeToExposure` does: a read that
 * lost its viewer filter must not become a way to link somebody else's
 * exposure to a creator's earning.
 */
export function bindServedRecommendation(
  claim: RecommendationClaim,
  row: ExposureRowLike | null | undefined,
): RecommendationBinding {
  const shape = checkRecommendationClaimShape(claim);
  if (shape) return shape;
  const rid = claim.recommendationId as string;

  if (!row || typeof row.id !== "string" || row.id.length === 0) {
    return refuse("recommendation_not_found", "no exposure of this viewer carries that id");
  }
  if (row.user_id !== claim.viewerUserId) {
    return refuse("recommendation_not_found", "no exposure of this viewer carries that id");
  }
  if (row.recommendation_id !== undefined && row.recommendation_id !== null && row.recommendation_id !== rid) {
    return refuse("recommendation_not_found", "no exposure of this viewer carries that id");
  }
  const itemId = String(row.item_id ?? "");
  if (claim.itemId && itemId !== claim.itemId) {
    return refuse("recommendation_item_mismatch", `the exposure is of ${itemId || "no item"}, not ${claim.itemId}`);
  }
  const servedAt = canonicalServedAt(String(row.served_at ?? ""));
  if (claim.occurredAt) {
    const served = Date.parse(servedAt);
    const occurred = Date.parse(claim.occurredAt);
    if (!Number.isFinite(served)) {
      return refuse("recommendation_not_found", "the exposure carries no readable serve instant");
    }
    if (Number.isFinite(occurred) && served > occurred) {
      return refuse(
        "recommendation_served_after_conversion",
        `served ${servedAt}, conversion ${new Date(occurred).toISOString()}: a later exposure cannot have led to it`,
      );
    }
  }
  return {
    ok: true,
    value: {
      recommendationId: rid,
      exposureRowId: row.id,
      viewerUserId: claim.viewerUserId,
      itemId,
      surface: String(row.surface ?? ""),
      servedAt,
    } as BoundRecommendation,
  };
}
