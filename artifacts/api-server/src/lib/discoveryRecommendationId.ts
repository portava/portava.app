/**
 * discoveryRecommendationId — `04` §5's recommendation denominator, for Discovery.
 *
 * WHAT `04` §5 ASKS FOR
 * =====================
 * > "Every served item must have a `recommendation_id`."
 * > Minimum recommendation record: recommendation_id, user_id, session_id,
 * > candidate_type/id, surface, rank_position, model_version, reason codes,
 * > served_at.
 * > "Without exposure denominators, engagement rates are misleading."
 *
 * The last sentence is the requirement's own statement of purpose, and it is
 * what fixes every design decision below: this identifies an EXPOSURE, not an
 * item and not a recommendation "object".
 *
 * WHAT ALREADY EXISTED, AND WHY THIS IS NOT A REBUILD
 * ===================================================
 * Two things existed before this module and neither was reused blindly.
 *
 * 1. **Compass already mints a `recommendation_id`.** `enrichFeedWithRecommendationIds`
 *    (`src/routes/compass.ts:265`) issues an HMAC-signed opaque token per served
 *    feed item and pre-registers it in the production table
 *    `compass_served_recommendations` (`migrations/0055_compass_admin.sql:22`,
 *    live — the column list is in the 2026-09-08 production schema snapshot).
 *    census-discovery's DV-40 recorded "zero occurrences in Discovery … only
 *    Layover and Media hits"; that grep result is wrong, and the correction is
 *    filed with the row.
 *
 *    **It is still not reusable here, for a stated reason.** The Compass token
 *    is deterministic over (userId, itemId, itemType, sectionName,
 *    explanationKey) — deliberately, because Compass dedupes on it
 *    (`dedupeByRecommendationId`, `src/routes/compass.ts:296`) and hands it to
 *    the client as the `/api/compass/why/:recommendationId` lookup handle. Its
 *    `UNIQUE` constraint on `recommendation_id` depends on that collapsing.
 *    A denominator needs the opposite: the same item served to the same viewer
 *    twice is TWO exposures, and an id that collapses them under-counts exactly
 *    the quantity `04` §5 exists to measure. So the id here binds the SERVE.
 *
 * 2. **Discovery's serve-log row already carried six of the nine fields.**
 *    `rank_events` gives `user_id`, `session_id`, `item_id` + `item_kind`
 *    (candidate type/id), `surface`, `position` (rank position) and `served_at`
 *    as real columns. Only `recommendation_id`, `model_version` and the reason
 *    codes were missing, and all three fit in the `features` jsonb that every
 *    row already writes. Hence NO MIGRATION: the record is completed on the
 *    table Discovery already writes to.
 *
 * WHY A HASH AND NOT A SIGNATURE
 * ==============================
 * The Compass token is HMAC-signed because it is handed to a client and comes
 * back as a URL segment, so it must be unforgeable. This id is written into
 * `rank_events.features` server-side and is never accepted from a client, so
 * there is nothing to forge and a signature would buy nothing while adding a
 * second copy of a secret-resolution chain that belongs in one place.
 *
 * IF that changes — if a Discovery `/why` is ever exposed — this id must be
 * re-minted through the signed primitive rather than trusted as-is, and the
 * secret handling in `src/compass/CompassExplanationEngine.ts:255` should be
 * lifted into a shared module first so there is exactly one implementation of
 * it. That is recorded as a cross-lane request, not done here: that file
 * belongs to the Compass lane.
 *
 * WHY DETERMINISTIC AND NOT A UUID
 * ================================
 * `randomUUID()` would satisfy "every item has an id" and quietly defeat
 * DV-37. The serve-log writer is fire-and-forget; if a batch is ever retried,
 * random ids would mint a second set of exposures for one serve and inflate the
 * denominator — the precise failure `04` §5 warns about, arriving through the
 * fix for it. Deriving the id from the serve's own coordinates makes a replay
 * of an identical batch produce identical ids, so a future `onConflict` has
 * something to conflict ON. It does not by itself make the write idempotent —
 * that still needs a unique index, which is a migration — so DV-37 does not
 * move on this.
 */
import { createHash } from "node:crypto";

/**
 * `04` §5's minimum recommendation record, in the specification's own order.
 *
 * Exported as data so a test can check the record against the requirement
 * rather than against its own memory of it, and so a reader can see at a glance
 * which of the nine are columns and which live in `features`.
 */
export const RECOMMENDATION_RECORD_FIELDS = [
  "recommendation_id",
  "user_id",
  "session_id",
  "candidate_type/id",
  "surface",
  "rank_position",
  "model_version",
  "reason codes",
  "served_at",
] as const;

export type RecommendationRecordField = (typeof RECOMMENDATION_RECORD_FIELDS)[number];

/**
 * Where each of the nine lives on a Discovery `rank_events` row.
 *
 * Recorded rather than described in prose because the split is the whole
 * argument for why this needed no migration, and a claim of that shape should
 * be checkable.
 */
export const RECOMMENDATION_RECORD_LOCATION: Readonly<
  Record<RecommendationRecordField, string>
> = {
  "recommendation_id": "features.recommendationId",
  "user_id":           "column user_id",
  "session_id":        "column session_id",
  "candidate_type/id": "columns item_kind + item_id",
  "surface":           "column surface",
  "rank_position":     "column position",
  "model_version":     "features.modelVersion",
  "reason codes":      "features.reasonCodes",
  "served_at":         "column served_at",
};

/** The coordinates of one exposure — the tuple the id is derived from. */
export interface ExposureCoordinates {
  userId:    string;
  sessionId: string;
  /** ISO-8601, as written to `rank_events.served_at`. */
  servedAt:  string;
  surface:   string;
  /** Zero-based rank position within the served page. */
  position:  number;
  itemId:    string;
}

/**
 * Domain separation. Without it, a digest computed here and a digest computed
 * somewhere else over the same six strings would be the same value meaning two
 * different things.
 */
const DOMAIN = "portava:discovery:recommendation:v1";

/**
 * Derive the opaque recommendation id for one exposure.
 *
 * Pure and total. The inputs are joined through `JSON.stringify` of a fixed-
 * length array rather than concatenated with a separator, so no combination of
 * field values can be re-partitioned into a different tuple with the same
 * digest — a destination of `"a|b"` and one of `"a"` followed by `"b"` must not
 * collide.
 *
 * The output is base64url (`[A-Za-z0-9_-]`), 128 bits, which is transport-safe
 * wherever the id is later carried and contains none of its inputs verbatim.
 */
export function recommendationIdFor(c: ExposureCoordinates): string {
  const canonical = JSON.stringify([
    DOMAIN,
    String(c.userId    ?? ""),
    String(c.sessionId ?? ""),
    String(c.servedAt  ?? ""),
    String(c.surface   ?? ""),
    Number.isFinite(c.position) ? Math.trunc(c.position) : -1,
    String(c.itemId    ?? ""),
  ]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}
