/**
 * rankingAnalytics.ts — typed constants for all ranking analytics event_type values.
 *
 * Import these wherever you write to rank_events to prevent typos.
 * These are purely additive — the rank_events table schema is unchanged;
 * the `event_type` column is the existing flexible string field.
 *
 * Privacy rule:
 *   Analytics writes MUST NOT include private content metadata, exact private
 *   locations, sensitive profile data, full ranking feature vectors, or
 *   fraud-detection details.  Safe fields: event_type, item_id, surface,
 *   content_type, ranking_version, user_id (viewer), session_id.
 */

// ── Event-type constants ───────────────────────────────────────────────────────

/**
 * Immutable map of all ranking analytics event_type string values.
 * Use these instead of raw string literals everywhere rank_events is written.
 */
export const RankingEvent = {
  // ── Scoring pipeline events ──────────────────────────────────────────────────
  /** Item passed the eligibility gate and entered scoring. */
  ITEM_ELIGIBLE: "ranking_item_eligible",
  /** Item received a final composite score. */
  ITEM_SCORED: "ranking_item_scored",

  // ── Assembly / selection events ──────────────────────────────────────────────
  /** Item was placed in the assembled feed (standard slot). */
  ITEM_SELECTED: "ranking_item_selected",
  /** Item was placed in the exploration slot. */
  ITEM_EXPLORATION_SELECTED: "ranking_item_exploration_selected",
  /** Item was selected from the underexposed bucket. */
  ITEM_UNDEREXPOSED_SELECTED: "ranking_item_underexposed_selected",
  /** Item was selected from the new-creator bucket. */
  NEW_CREATOR_SELECTED: "ranking_new_creator_selected",
  /** Item was selected from the returning-creator bucket. */
  RETURNING_CREATOR_SELECTED: "ranking_returning_creator_selected",

  // ── Boost / penalty signal events ────────────────────────────────────────────
  /** A non-zero activity boost was included in this item's score. */
  ACTIVITY_BOOST_APPLIED: "ranking_activity_boost_applied",
  /** Activity boost hit the max-boost ceiling (was capped). */
  ACTIVITY_BOOST_CAPPED: "ranking_activity_boost_capped",
  /** A fatigue penalty reduced this item's score. */
  FATIGUE_PENALTY_APPLIED: "ranking_fatigue_penalty_applied",
  /** Item was moved by the diversity / creator-cap re-ordering pass. */
  DIVERSITY_REORDERED: "ranking_diversity_reordered",

  // ── Outcome events (extend existing impression / outcome types) ───────────────
  /** Item was shown to the viewer (extends existing impression type). */
  ITEM_IMPRESSION: "ranking_item_impression",
  /** Viewer opened / tapped the item (extends existing "tap" outcome). */
  ITEM_OPENED: "ranking_item_opened",
  /** Viewer saved the item (extends existing "save" outcome). */
  ITEM_SAVED: "ranking_item_saved",
  /** Viewer hid the item. */
  ITEM_HIDDEN: "ranking_item_hidden",
  /** Viewer reported the item. */
  ITEM_REPORTED: "ranking_item_reported",
} as const;

/** Union of all ranking analytics event_type strings. */
export type RankingEventType = (typeof RankingEvent)[keyof typeof RankingEvent];

// ── Outcome → analytics event mapping ────────────────────────────────────────
//
// Maps the existing client-facing outcome values to the new typed constants.
// Backward compatibility: old string values keep working as rank_events outcome
// field values; this map drives the additional analytics event emission.

export const OUTCOME_TO_ANALYTICS_EVENT: Partial<Record<string, RankingEventType>> = {
  tap:      RankingEvent.ITEM_OPENED,
  save:     RankingEvent.ITEM_SAVED,
  hide:     RankingEvent.ITEM_HIDDEN,
  report:   RankingEvent.ITEM_REPORTED,
};
