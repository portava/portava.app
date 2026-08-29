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
  /**
   * Item passed the eligibility gate and entered scoring.
   *
   * NO LONGER WRITTEN as of 2026-08-29. Retained because ~116,000 historical
   * rows carry this event_type and anything reading that corpus still needs the
   * constant. It was removed from the write path because it is derivable with
   * certainty from ITEM_SCORED: no control flow separates the two writes, so
   * every item that emitted one emitted the other, with an identical field set.
   * Production bore that out exactly — 46,677 = 46,677 on pulse, 11,367 =
   * 11,367 on compass.
   */
  ITEM_ELIGIBLE: "ranking_item_eligible",
  /**
   * Item received a final composite score. One row per scored candidate — and,
   * since ITEM_ELIGIBLE stopped being written, also the record that the item
   * PASSED the eligibility gate (an ineligible item is never scored).
   */
  ITEM_SCORED: "ranking_item_scored",
  /**
   * Item was REJECTED by the eligibility gate, with the reason.
   *
   * Written only on rejection, which today means never: the gate is
   * structurally unreachable on all three surfaces that use it. That is exactly
   * why it exists. Before this, a rejection produced NO row at all — the gate's
   * only interesting outcome was its only unobservable one, and "the gate
   * rejected five items" was indistinguishable from "five items were never
   * candidates". Its cost is proportional to rejections, so it is free until the
   * gate does something, and it is the signal required to prove it ever did.
   */
  ITEM_INELIGIBLE: "ranking_item_ineligible",

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

// ── Non-ranker event_type markers ─────────────────────────────────────────────
//
// rank_events.event_type is a free-text provenance column shared by writers that
// are NOT part of the ranking pipeline (e.g. 'place_view' in routes/rankEvents.ts,
// 'watch_impression' in routes/mediaFeed.ts).  Those values do not belong in
// `RankingEvent`: every member of that object is a ranking-pipeline event and
// every value is prefixed "ranking_" — an invariant asserted by
// src/test/ranking-explanation-analytics.test.ts ("all event strings start with
// 'ranking_'").  Markers for non-ranker writers live here instead.

/**
 * `event_type` marker for a Live Pulse rail serve (GET /api/pulse/live).
 *
 * Deliberately NOT a member of `RankingEvent`.  Live Pulse items are assembled
 * by urgency (routes/pulse.ts), never scored by rankCandidates, so those rows
 * carry no feature vector — naming this a `ranking_*` event would assert the
 * ranker provenance the marker exists to deny, as well as breaking the
 * "ranking_" prefix invariant above.
 *
 * Genuine ranker impressions (lib/rankLog.ts logImpression /
 * logCompassImpression) write no event_type at all, so `event_type IS NULL`
 * selects the ranked corpus and `event_type = 'live_pulse_serve'` selects these.
 */
export const LIVE_PULSE_SERVE_EVENT = "live_pulse_serve";

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
