/**
 * Find Your Circle — response shaper.
 *
 * Strips all sensitive fields from a presence row and enforces the visibility
 * mode contract before sending data to a circle member.
 *
 * Visibility mode contract:
 *   status_only     → profile info + status text. No location of any kind.
 *   approximate_area → status + approximate_label (neighbourhood/district).
 *   venue_checkin   → status + venue_label ONLY when checked_in = true.
 *   precise_live    → 403 (deferred to V2; rejected at route level).
 *
 * The response always includes:
 *   userId, avatarUrl, displayName, username, status, visibilityMode,
 *   freshnessLabel, lastUpdatedAt, canMessage, canViewProfile, safetyActionsAllowed
 *
 * The response NEVER includes:
 *   email, phone, precise GPS, private trip/event fields, admin notes,
 *   emergency data (needs_help bool is server-only; routes must not surface it).
 *
 * ── WHERE THE RUNG COMES FROM (census-sensing S3) ────────────────────────────
 * `circle_presence` is one of the four presence models S3 names, and this file
 * plus `routes/circle.ts` are its entire read surface. The visibility contract
 * above used to BE the fusion layer for it: this function decided, alone, how
 * revealing a circle member's row was allowed to be.
 *
 * It no longer decides. `circlePresenceEstimate` turns the row into a
 * `PresenceClaim` and hands it to `presenceFusion.admit`; the §52 fold, the
 * source ceiling from `presence/fusion/sources.PRESENCE_SOURCE_CONTRACTS`, the
 * §10 state and the seal all come back on a `FusedPresenceEstimate` that only
 * the store can mint. THE LABELS BELOW ARE GATED ON THAT ESTIMATE'S RUNG —
 * a presence the store refuses carries no location, whatever the mode says.
 *
 * The arithmetic is unchanged; what changed is that there is no longer an
 * expression in this module that decides how much of a person's location to
 * publish without the one store seeing it.
 */
import {
  PRESENCE_WRITE_CAPABILITIES,
  presenceFusion,
  type FusedPresenceEstimate,
  type PresenceClaim,
} from "../presence/fusion/store.js";
import { circleConsentScope } from "../presence/fusion/sources.js";
import { precisionRank, type LocationPrecision } from "../presence/domain/types.js";

/**
 * The Circle context a presence row belongs to — 0117's `(context_type,
 * context_id)` pair. It is the claim's CONSENT SCOPE (owner decision A): a
 * member published this row to the accepted members of THIS trip or event, and
 * a fused read reaches the estimate only by holding that context's scope.
 */
export interface CircleContextRef {
  type: string;
  id: string;
}

/**
 * ── REVOCATION — the store's half of "stop sharing" ─────────────────────────
 * Each returns how many retained estimates were dropped. The routes call these
 * at the exact points a member's consent to a context ends: pausing one
 * context, pausing all, the session-end pause, the sweep of a context whose
 * trip or event has ended, an admin disabling a context, the kill switch.
 */
export function revokeCirclePresence(userId: string, contextType: string, contextId: string): number {
  return presenceFusion.revokeSubjectInScope(userId, circleConsentScope(contextType, contextId));
}
export function revokeCircleContext(contextType: string, contextId: string): number {
  return presenceFusion.revokeScope(circleConsentScope(contextType, contextId));
}
export function revokeAllCirclePresence(userId: string): number {
  return presenceFusion.revokeSubject(userId, "circle");
}
export function revokeEveryCirclePresence(): number {
  return presenceFusion.revokeScopeKind("circle");
}

export interface CircleProfileSnippet {
  userId: string;
  avatarUrl: string | null;
  displayName: string;
  username: string;
}

export interface ShapedPresence {
  userId: string;
  avatarUrl: string | null;
  displayName: string;
  username: string;
  status: string;
  statusLabel: string | null;
  visibilityMode: string;
  freshnessLabel: string;
  lastUpdatedAt: string | null;
  /** Populated only when visibility allows location info */
  approximateLabel: string | null;
  venueLabel: string | null;
  /**
   * Broad-area coordinates for map pins.
   * venue_checkin and approximate_area modes may populate these once the DB
   * schema includes public_lat / public_lng columns (deferred to V2).
   * Always null in V1.
   */
  publicLat: number | null;
  publicLng: number | null;
  isStale: boolean;
  canMessage: boolean;
  canViewProfile: boolean;
  safetyActionsAllowed: boolean;
  /** true when the member hasn't published any presence for this context yet */
  presenceAbsent: boolean;
}

function freshnessLabel(lastUpdatedAt: string | null, isStale: boolean): string {
  if (!lastUpdatedAt) return "Not yet shared";
  if (isStale) return "Last seen a while ago";
  const diff = Date.now() - new Date(lastUpdatedAt).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return "More than a day ago";
}

/**
 * ── THE §52 BOUND EACH VISIBILITY MODE CARRIES ───────────────────────────────
 *
 * `circle_presence` (migration 0117) has no coordinate columns; what it holds
 * is a status and a LABEL, and `venue` is the rung a label occupies — which is
 * also this source's ceiling in `presence/fusion/sources.ts`. So the whole
 * ladder for this model is three rungs:
 *
 *   status_only       `presence_only`  — "they are here" and nothing more.
 *   approximate_area  `venue`          — a neighbourhood/district label.
 *   venue_checkin     `venue`          — a venue label, and only while
 *                                        `checked_in`; see the second bound.
 *   precise_live      `none`           — V2. Rejected at route level; the
 *                                        store refuses it here too, so the
 *                                        rejection does not depend on the
 *                                        route remembering to.
 *
 * An UNRECOGNISED mode is `none`, not a default. A mode this table does not
 * know is a mode whose consent semantics we cannot state, and the honest rung
 * for that is nothing. (The old if/else produced the same silence by falling
 * off the end of the chain; here it is a decision rather than an omission.)
 */
const VISIBILITY_MODE_CEILING: Readonly<Record<string, LocationPrecision>> = Object.freeze({
  status_only: "presence_only",
  approximate_area: "venue",
  venue_checkin: "venue",
  precise_live: "none",
});

/** The rung at or above which this source may serve a LABEL at all. */
const CIRCLE_LABEL_RUNG: LocationPrecision = "venue";

function observedAtMsOf(presenceRow: Record<string, any>): number | null {
  const raw = presenceRow["updated_at"];
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  // An unparseable timestamp is treated as ABSENT rather than as a bad clock:
  // the honest consequence of not knowing when a row was written is "this can
  // never be presented as current", which is exactly what an untimed claim
  // already is in the store.
  return Number.isFinite(t) ? t : null;
}

/**
 * Put one `circle_presence` row through the presence fusion layer.
 *
 * Returns the sealed estimate, or `null` when the store refused — an empty
 * subject, an unknown mode, a mode whose fold lands on `none`. A refusal is
 * not an error here: it is the answer "this member has no location to publish
 * in this context", and `shapePresence` renders exactly that.
 *
 * NO CLOCK IS PASSED, deliberately. `nowMs` in the store means "the instant
 * the caller is asking about", and `null` means the caller has none — which is
 * the truth here. The circle's own retention is NOT the store's 60-minute
 * derivation TTL: `routes/circle.ts` filters `expires_at` before a row ever
 * reaches this function and marks `is_stale` on its own schedule (0117's
 * `stale_after_secs`). Handing the store a wall clock would quietly retire
 * labels the circle's consent policy still serves, which is a different
 * decision from the one this lane is making.
 *
 * The subject is the Portava ACCOUNT, so a circle estimate is account-scoped
 * and `PresenceFusionStore.resolve` may fuse it with the other same-class
 * models; the store re-mints under the asking source's ceiling and the
 * viewer's audience, so that can only ever narrow. The circle CONTEXT is the
 * claim's consent scope (owner decision A): the row was published to the
 * accepted members of one trip or event, and only a viewer holding that
 * context's scope can reach the estimate through a fused read.
 */
export function circlePresenceEstimate(
  profile: CircleProfileSnippet,
  presenceRow: Record<string, any> | null,
  visibilityMode: string,
  isStale: boolean,
  context: CircleContextRef,
): FusedPresenceEstimate | null {
  // No row is not a refusal — there is simply nothing to assert about this
  // member, and minting an estimate for it would invent a presence.
  if (!presenceRow) return null;

  const checkedIn = Boolean(presenceRow["checked_in"]);
  const claim: PresenceClaim = {
    subjectKey: profile.userId,
    linkage: "account_scoped",
    scope: circleConsentScope(context.type, context.id),
    // The most this model can ever ask for. The bounds below do the narrowing,
    // and the store folds its own source ceiling over the result, so this can
    // never widen anything — §52 has exactly one direction.
    requestedPrecision: CIRCLE_LABEL_RUNG,
    ceilings: [
      VISIBILITY_MODE_CEILING[visibilityMode] ?? "none",
      // A venue label is published only while the member says they are AT the
      // venue. Not checked in is not a quieter venue label, it is no venue.
      visibilityMode === "venue_checkin" && !checkedIn ? "presence_only" : CIRCLE_LABEL_RUNG,
    ],
    observedAtMs: observedAtMsOf(presenceRow),
    // A circle row is a STANDING SELF-ASSERTION, not a sighting. `recent` and
    // `last_known` are both non-live §10 states, so neither can be mistaken for
    // a confirmed current position — which is the distinction §2.2 exists for.
    state: isStale ? "last_known" : "recent",
    confidence: checkedIn ? 0.8 : 0.5,
    evidence: [checkedIn ? "user_checkin" : "server_sync"],
    // 0117 has no coordinate columns, and the `venue` ceiling means the store
    // would drop a point even if it had. The absence is now arithmetic rather
    // than a comment.
    point: null,
  };

  const admission = presenceFusion.admit(
    PRESENCE_WRITE_CAPABILITIES.circle_presence,
    claim,
    null,
  );
  return admission.ok ? admission.estimate : null;
}

/**
 * Shape a presence row (or null for absent presence) into a safe API response.
 *
 * @param profile        Public profile fields of the target user.
 * @param presenceRow    Raw DB row from circle_presence, or null if not published.
 * @param visibilityMode Effective visibility mode resolved by the access guard.
 * @param isStale        Whether the presence is considered stale.
 */
export function shapePresence(
  profile: CircleProfileSnippet,
  presenceRow: Record<string, any> | null,
  visibilityMode: string,
  isStale: boolean,
  context: CircleContextRef,
): ShapedPresence {
  if (!presenceRow) {
    return {
      userId: profile.userId,
      avatarUrl: profile.avatarUrl,
      displayName: profile.displayName,
      username: profile.username,
      status: "unknown",
      statusLabel: null,
      visibilityMode,
      freshnessLabel: "Not yet shared",
      lastUpdatedAt: null,
      approximateLabel: null,
      venueLabel: null,
      publicLat: null,
      publicLng: null,
      isStale: false,
      canMessage: true,
      canViewProfile: true,
      safetyActionsAllowed: true,
      presenceAbsent: true,
    };
  }

  const status = (presenceRow["status"] as string | null) ?? "active";
  const statusLabel = (presenceRow["status_label"] as string | null) ?? null;
  const lastUpdatedAt = (presenceRow["updated_at"] as string | null) ?? null;

  // Location fields — gated on the RUNG the fusion store admitted for this
  // row, not on the mode alone. The mode is one of the bounds that produced
  // that rung (see VISIBILITY_MODE_CEILING); a refusal — no subject, an
  // unknown mode, a fold that landed on `none` — leaves `estimate` null and
  // publishes no location at all.
  const estimate = circlePresenceEstimate(profile, presenceRow, visibilityMode, isStale, context);
  const mayPublishLabel =
    estimate !== null && precisionRank(estimate.precision) >= precisionRank(CIRCLE_LABEL_RUNG);

  let approximateLabel: string | null = null;
  let venueLabel: string | null = null;

  if (mayPublishLabel && visibilityMode === "approximate_area") {
    approximateLabel = (presenceRow["approximate_label"] as string | null) ?? null;
  } else if (mayPublishLabel && visibilityMode === "venue_checkin") {
    const checkedIn = Boolean(presenceRow["checked_in"]);
    if (checkedIn) {
      venueLabel = (presenceRow["venue_label"] as string | null) ?? null;
    }
  }
  // precise_live: rejected at route level — and `none` in the ceiling table, so
  // the store refuses it here as well rather than trusting the route to.

  return {
    userId: profile.userId,
    avatarUrl: profile.avatarUrl,
    displayName: profile.displayName,
    username: profile.username,
    status,
    statusLabel,
    visibilityMode,
    freshnessLabel: freshnessLabel(lastUpdatedAt, isStale),
    lastUpdatedAt,
    approximateLabel,
    venueLabel,
    // Taken OFF the sealed estimate rather than hardcoded. V1 has no coordinate
    // columns in circle_presence, and the source's `venue` ceiling means the
    // store retains a point only at `precise` — a rung this model cannot reach.
    // So a coordinate is unrepresentable here until the register's ceiling is
    // raised in a reviewed diff, not merely absent until someone adds a column.
    publicLat: estimate?.position?.lat ?? null,
    publicLng: estimate?.position?.lng ?? null,
    isStale,
    canMessage: true,
    canViewProfile: true,
    safetyActionsAllowed: true,
    presenceAbsent: false,
  };
}
