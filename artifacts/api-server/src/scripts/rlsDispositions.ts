/**
 * RLS disposition manifest — every `public`-schema table must carry exactly
 * one entry. No default, no inherited silence: a table with no entry here is
 * a bug in this file, not a table that's fine to leave unclassified.
 *
 * Model (RECONCILIATION-PACKET.md §5.4, "ruling 8"):
 *
 *   RLS_REQUIRED         RLS enabled AND >= 1 policy.
 *   DENY_ALL_BY_DESIGN   RLS enabled AND 0 policies (service_role bypasses
 *                        RLS entirely, so this is a deliberate deny-all to
 *                        every other role). Requires a one-line reason.
 *   REVIEWED_EXEMPT      RLS NOT enabled, deliberately (e.g. a PostGIS
 *                        system catalog table like spatial_ref_sys, not
 *                        application data). Requires reason + reviewer + date.
 *   NEEDS_REVIEW         The baseline evidence for this table did not
 *                        resolve cleanly into one of the three classes
 *                        above. Never guessed into a class — flagged
 *                        instead. (Empty in this generation — see below.)
 *
 * SEEDED FROM THE BASELINE, NOT THE PACKET. §5.4's own class lists (A/B/C/D/E)
 * are known-stale: they predate migrations 2096 and 2107, so they still
 * classify compass_memories and the 12 internal-cache tables as RLS-off,
 * which the committed baseline (captured 2026-08-19, verified post
 * migrations 2096-2100/2107/2119 — see
 * artifacts/api-server/baseline/20260819_baseline_structure.sql) shows is no
 * longer true. This file is generated mechanically from that baseline via
 * src/scripts/parseBaselineSchema.ts, not copied from the packet's seed list.
 *
 * GENERATED 2026-08-19 from artifacts/api-server/baseline/20260819_baseline_structure.sql
 * (387 CREATE TABLE public.*, 387 matching ENABLE ROW LEVEL SECURITY, 737
 * CREATE POLICY ... ON public.* statements — every ENABLE target and every
 * policy target resolved to a known table; zero dropped/orphaned matches).
 * To regenerate after a new baseline capture, re-run the parser against the
 * new file and diff — do not hand-edit entries wholesale.
 *
 * RESULT: 327 RLS_REQUIRED, 60 DENY_ALL_BY_DESIGN, 0 REVIEWED_EXEMPT,
 * 0 NEEDS_REVIEW. Every one of the 387 tables in this baseline already has
 * RLS enabled — REVIEWED_EXEMPT is empty because nothing like
 * spatial_ref_sys (a PostGIS system catalog table) appears in this baseline
 * at all, not because the class was skipped. NEEDS_REVIEW is empty because
 * every table's evidence resolved unambiguously (RLS-enabled status and
 * policy count both matched a known table in every case — see the
 * generation counts above). If a future baseline capture ever produces a
 * non-tiny REVIEWED_EXEMPT or NEEDS_REVIEW set, or a table with RLS
 * disabled that isn't a deliberate, reviewed exemption, that is a signal
 * something is wrong — not a class to fill in and move past.
 *
 * Six DENY_ALL_BY_DESIGN entries below carry an extra citation: they were
 * flagged in docs/RECONCILIATION-PACKET.md §5.4's Class A list as
 * user-facing tables that "warrant an explicit reviewed disposition rather
 * than inherited silence" — that concern is carried forward here, not
 * dropped, even though this file's own classification is mechanical.
 *
 * Imported by src/test/rlsDispositions.test.ts, which re-parses the
 * committed baseline at test time and fails if any table there has no
 * entry here — the property this whole file exists to guarantee.
 */

export type RlsDispositionClass =
  | "RLS_REQUIRED"
  | "DENY_ALL_BY_DESIGN"
  | "REVIEWED_EXEMPT"
  | "NEEDS_REVIEW";

export interface RlsDisposition {
  class: RlsDispositionClass;
  /** Policy count observed in the baseline this entry was generated from. */
  policyCount: number;
  /** Required for DENY_ALL_BY_DESIGN and REVIEWED_EXEMPT. */
  reason?: string;
  /** Required for REVIEWED_EXEMPT. */
  reviewer?: string;
  /** Required for REVIEWED_EXEMPT — ISO date the exemption was recorded. */
  date?: string;
}

/**
 * FOLLOW-UPS — items this manifest surfaces but does not itself resolve.
 * Not enforced by rlsDispositions.test.ts's coverage/consistency checks
 * (those verify the manifest against the baseline; this is a to-do list for
 * a human, not a schema fact) — kept here specifically so it is not lost
 * inside a single DENY_ALL_BY_DESIGN reason string on one table and forgotten.
 *
 * These 6 tables are classified DENY_ALL_BY_DESIGN above because that is
 * mechanically what the baseline shows (RLS enabled, 0 policies) — they were
 * ALREADY deny-all before this file was generated, and this file documents
 * that existing state rather than changing it. The open question is not
 * their classification; it's whether "deny-all" is actually SAFE for them,
 * which the baseline (a structure-only dump) cannot answer — that requires
 * checking the client code for a direct anon-key read path.
 */
export const FOLLOW_UPS: ReadonlyArray<{ table: string; note: string }> = [
  { table: "devices", note: "user-facing deny-all — confirm no client reads directly with the anon key before assuming safe" },
  { table: "key_packages", note: "user-facing deny-all — confirm no client reads directly with the anon key before assuming safe" },
  { table: "comment_likes", note: "user-facing deny-all — confirm no client reads directly with the anon key before assuming safe" },
  { table: "post_reactions", note: "user-facing deny-all — confirm no client reads directly with the anon key before assuming safe" },
  { table: "post_shares", note: "user-facing deny-all — confirm no client reads directly with the anon key before assuming safe" },
  { table: "circle_invites", note: "user-facing deny-all — confirm no client reads directly with the anon key before assuming safe" },
];

/**
 * Tables created by canonical migrations AFTER the 2026-08-19 baseline, with
 * their disposition written down NOW rather than at the next recapture.
 *
 * They cannot go into RLS_DISPOSITIONS yet: rlsDispositions.test.ts asserts
 * that every entry there names a table in the committed baseline (the
 * staleness check), so an entry for a post-baseline table would fail the
 * suite — which is why intel_coverage_snapshots (2181), intel_live_promoted_scopes
 * (2179) and the rest of the post-baseline intel family have no entry at all.
 * That is inherited silence, the thing this file exists to refuse. This list
 * is the written disposition in the meantime; at recapture each entry moves
 * into RLS_DISPOSITIONS (regenerate from the new baseline and diff — the class
 * and policy count must match what the parser finds) and is deleted here.
 *
 * Not enforced by the test (it verifies the manifest against the baseline);
 * enforced by review.
 */
export const POST_BASELINE_RLS_DISPOSITIONS: Record<string, RlsDisposition & { migration: string }> = {
  "intel_state_snapshot_versions": {
    class: "DENY_ALL_BY_DESIGN",
    policyCount: 0,
    migration: "2273_intel_replayable_projection.sql",
    reason:
      "I1 append-only projection history. RLS enabled, zero policies: service_role (bypasses RLS) holds INSERT+SELECT only; " +
      "anon and authenticated hold nothing (REVOKE ALL, no grant). Readers reach live state through intel_state_snapshots " +
      "via the server projection, never this table. UPDATE/DELETE refused by trigger AND by grant.",
  },
  "trip_plan_item_votes": {
    class: "DENY_ALL_BY_DESIGN",
    policyCount: 0,
    migration: "2292_map_journey_intelligence.sql",
    reason:
      "Map spec §36 Phase-6 group decision: one accept/decline per crew member per trip plan item. RLS enabled, zero " +
      "policies: service_role (which bypasses RLS) holds SELECT/INSERT/UPDATE/DELETE; anon and authenticated are " +
      "REVOKEd explicitly and hold nothing, so no PostgREST client can read or write a vote at all. The membership " +
      "check that decides who may vote and who may read a tally lives in routes/mapJourney.ts (accepted trip members " +
      "only), which is the same place every other trip-scoped write is authorized — a policy here would be a second, " +
      "divergent answer to 'who is on this trip'.",
  },
};

export const RLS_DISPOSITIONS: Record<string, RlsDisposition> = {
  "activity_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "admin_access_log": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "age_limit_audit_log": { class: "RLS_REQUIRED", policyCount: 1 },
  "airport_profiles": { class: "RLS_REQUIRED", policyCount: 1 },
  "appeals": { class: "RLS_REQUIRED", policyCount: 2 },
  "availability_nudges": { class: "RLS_REQUIRED", policyCount: 2 },
  "blocks": { class: "RLS_REQUIRED", policyCount: 6 },
  "buddy_availability_exceptions": { class: "RLS_REQUIRED", policyCount: 4 },
  "buddy_booking_change_requests": { class: "RLS_REQUIRED", policyCount: 2 },
  "buddy_booking_events": { class: "RLS_REQUIRED", policyCount: 2 },
  "buddy_services": { class: "RLS_REQUIRED", policyCount: 4 },
  "call_moderation_actions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "call_participants": { class: "RLS_REQUIRED", policyCount: 1 },
  "call_preferences": { class: "RLS_REQUIRED", policyCount: 3 },
  "call_sessions": { class: "RLS_REQUIRED", policyCount: 1 },
  "canonical_locations": { class: "RLS_REQUIRED", policyCount: 1 },
  "circle_age_settings": { class: "RLS_REQUIRED", policyCount: 2 },
  "circle_audit_events": { class: "RLS_REQUIRED", policyCount: 2 },
  "circle_checkins": { class: "RLS_REQUIRED", policyCount: 3 },
  "circle_context_settings": { class: "RLS_REQUIRED", policyCount: 2 },
  "circle_invites": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification. Flagged in docs/RECONCILIATION-PACKET.md §5.4 (Class A) as user-facing -- deny-all-by-design here may be an oversight rather than a decision; needs explicit owner confirmation, not inherited silence." },
  "circle_meeting_points": { class: "RLS_REQUIRED", policyCount: 1 },
  "circle_member_visibility_overrides": { class: "RLS_REQUIRED", policyCount: 2 },
  "circle_memberships": { class: "RLS_REQUIRED", policyCount: 4 },
  "circle_presence": { class: "RLS_REQUIRED", policyCount: 3 },
  "circle_visibility_settings": { class: "RLS_REQUIRED", policyCount: 2 },
  "circles": { class: "RLS_REQUIRED", policyCount: 3 },
  "city_country_geocode_cache": { class: "RLS_REQUIRED", policyCount: 1 },
  "city_timezones": { class: "RLS_REQUIRED", policyCount: 1 },
  "close_friends": { class: "RLS_REQUIRED", policyCount: 1 },
  "collection_items": { class: "RLS_REQUIRED", policyCount: 1 },
  "collections": { class: "RLS_REQUIRED", policyCount: 1 },
  "comment_likes": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification. Flagged in docs/RECONCILIATION-PACKET.md §5.4 (Class A) as user-facing -- deny-all-by-design here may be an oversight rather than a decision; needs explicit owner confirmation, not inherited silence." },
  "compass_abuse_flags": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_active_user_badges": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_active_user_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_active_user_scores": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_admin_actions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_admin_weight_sets": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_algorithm_versions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_analytics": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_analytics_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_cache_invalidations": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_category_reputation": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_city_confidence": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_city_models": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_city_reputation": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_content_freshness": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_conversation_messages": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_conversations": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_eligibility_logs": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_explanation_reasons": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_feed_cache": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_feed_sections": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_feedback": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_feedback_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_frontload_rules": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_graph_edges": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_graph_nodes": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_intent_modes": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_live_sessions": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_media_preload_manifest": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_memories": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_notification_decisions": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_outcome_events": { class: "RLS_REQUIRED", policyCount: 2 },
  "compass_preload_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_preload_queue": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_privacy_guard_logs": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_recent_context": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_recommendation_scores": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_rollbacks": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_safety_filter_logs": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_sense_nudges": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_sense_settings": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_served_recommendations": { class: "RLS_REQUIRED", policyCount: 2 },
  "compass_settings": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_suspension_requests": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_testing_scenarios": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_user_context_snapshots": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_user_navigation_patterns": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_user_preferences": { class: "RLS_REQUIRED", policyCount: 3 },
  "compass_user_profiles": { class: "RLS_REQUIRED", policyCount: 1 },
  "compass_visibility_boosts": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "compass_visibility_cooldowns": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "content_distribution_stats": { class: "RLS_REQUIRED", policyCount: 1 },
  "content_stamps": { class: "RLS_REQUIRED", policyCount: 3 },
  "content_translations": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "country_essentials": { class: "RLS_REQUIRED", policyCount: 2 },
  "country_metadata": { class: "RLS_REQUIRED", policyCount: 2 },
  "creator_activity_scores": { class: "RLS_REQUIRED", policyCount: 1 },
  "daily_briefs": { class: "RLS_REQUIRED", policyCount: 1 },
  "delayed_post_location_events": { class: "RLS_REQUIRED", policyCount: 2 },
  "destination_identities": { class: "RLS_REQUIRED", policyCount: 2 },
  "devices": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification. Flagged in docs/RECONCILIATION-PACKET.md §5.4 (Class A) as user-facing -- deny-all-by-design here may be an oversight rather than a decision; needs explicit owner confirmation, not inherited silence." },
  "discovery_cache": { class: "RLS_REQUIRED", policyCount: 2 },
  "discovery_geocode_cache": { class: "RLS_REQUIRED", policyCount: 2 },
  "discovery_place_reports": { class: "RLS_REQUIRED", policyCount: 2 },
  "discovery_place_saves": { class: "RLS_REQUIRED", policyCount: 2 },
  "discovery_places": { class: "RLS_REQUIRED", policyCount: 7 },
  "discovery_shadow_serves": { class: "RLS_REQUIRED", policyCount: 2 },
  "entry_requirements": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_activity_log": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_agenda_items": { class: "RLS_REQUIRED", policyCount: 1 },
  "event_attendee_states": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_attendees": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_cohosts": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_drafts": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_invites": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_join_requests": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_media": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_posts": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_reminders": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_reports": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_reviews": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_roles": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_rsvps": { class: "RLS_REQUIRED", policyCount: 3 },
  "event_saves": { class: "RLS_REQUIRED", policyCount: 1 },
  "event_share_links": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_updates": { class: "RLS_REQUIRED", policyCount: 2 },
  "event_waitlist": { class: "RLS_REQUIRED", policyCount: 3 },
  "events": { class: "RLS_REQUIRED", policyCount: 4 },
  "external_place_references": { class: "RLS_REQUIRED", policyCount: 1 },
  "feature_flag_audit_log": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "feature_flags": { class: "RLS_REQUIRED", policyCount: 1 },
  "friend_requests": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "fsq_city_ingests": { class: "RLS_REQUIRED", policyCount: 2 },
  "fsq_places": { class: "RLS_REQUIRED", policyCount: 2 },
  "fx_rates": { class: "RLS_REQUIRED", policyCount: 2 },
  "generated_visuals": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "geo_zones": { class: "RLS_REQUIRED", policyCount: 6 },
  "geofence_admin_settings": { class: "RLS_REQUIRED", policyCount: 3 },
  "hashtag_reports": { class: "RLS_REQUIRED", policyCount: 5 },
  "hashtag_usage": { class: "RLS_REQUIRED", policyCount: 4 },
  "hashtags": { class: "RLS_REQUIRED", policyCount: 4 },
  "hidden_gem_reports": { class: "RLS_REQUIRED", policyCount: 2 },
  "hidden_gem_saves": { class: "RLS_REQUIRED", policyCount: 3 },
  "hidden_gem_verifications": { class: "RLS_REQUIRED", policyCount: 2 },
  "hidden_gem_visits": { class: "RLS_REQUIRED", policyCount: 2 },
  "hidden_gems": { class: "RLS_REQUIRED", policyCount: 4 },
  "highlight_likes": { class: "RLS_REQUIRED", policyCount: 5 },
  "highlight_replies": { class: "RLS_REQUIRED", policyCount: 4 },
  "highlight_reports": { class: "RLS_REQUIRED", policyCount: 3 },
  "highlight_views": { class: "RLS_REQUIRED", policyCount: 5 },
  "highlights": { class: "RLS_REQUIRED", policyCount: 5 },
  "identity_verifications": { class: "RLS_REQUIRED", policyCount: 1 },
  "job_health": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "key_packages": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification. Flagged in docs/RECONCILIATION-PACKET.md §5.4 (Class A) as user-facing -- deny-all-by-design here may be an oversight rather than a decision; needs explicit owner confirmation, not inherited silence." },
  "layover_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "layover_plan_stops": { class: "RLS_REQUIRED", policyCount: 1 },
  "layover_recommendations": { class: "RLS_REQUIRED", policyCount: 1 },
  "layover_sessions": { class: "RLS_REQUIRED", policyCount: 1 },
  "live_place_recap_chapters": { class: "RLS_REQUIRED", policyCount: 1 },
  "live_place_recap_snapshots": { class: "RLS_REQUIRED", policyCount: 1 },
  "live_place_recap_sources": { class: "RLS_REQUIRED", policyCount: 1 },
  "live_place_recap_versions": { class: "RLS_REQUIRED", policyCount: 1 },
  "live_place_recaps": { class: "RLS_REQUIRED", policyCount: 1 },
  "local_guide_contributions": { class: "RLS_REQUIRED", policyCount: 2 },
  "local_guide_profiles": { class: "RLS_REQUIRED", policyCount: 4 },
  "location_preferences": { class: "RLS_REQUIRED", policyCount: 3 },
  "location_sessions": { class: "RLS_REQUIRED", policyCount: 4 },
  "location_snapshots": { class: "RLS_REQUIRED", policyCount: 1 },
  "location_trust_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "map_pins": { class: "RLS_REQUIRED", policyCount: 4 },
  "media_assets": { class: "RLS_REQUIRED", policyCount: 1 },
  "media_attachments": { class: "RLS_REQUIRED", policyCount: 1 },
  "media_dedup_groups": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "media_dedup_memberships": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "media_events": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "media_ranking_snapshots": { class: "RLS_REQUIRED", policyCount: 1 },
  "media_stamp_reactions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "meetup_invites": { class: "RLS_REQUIRED", policyCount: 5 },
  "meetup_time_options": { class: "RLS_REQUIRED", policyCount: 4 },
  "meetup_time_votes": { class: "RLS_REQUIRED", policyCount: 3 },
  "meetups": { class: "RLS_REQUIRED", policyCount: 4 },
  "memories": { class: "RLS_REQUIRED", policyCount: 2 },
  "memory_items": { class: "RLS_REQUIRED", policyCount: 2 },
  "memory_likes": { class: "RLS_REQUIRED", policyCount: 2 },
  "memory_saves": { class: "RLS_REQUIRED", policyCount: 1 },
  "memory_tags": { class: "RLS_REQUIRED", policyCount: 4 },
  "message_reports": { class: "RLS_REQUIRED", policyCount: 1 },
  "message_requests": { class: "RLS_REQUIRED", policyCount: 3 },
  "message_thread_members": { class: "RLS_REQUIRED", policyCount: 2 },
  "message_threads": { class: "RLS_REQUIRED", policyCount: 1 },
  "message_translations": { class: "RLS_REQUIRED", policyCount: 3 },
  "messages": { class: "RLS_REQUIRED", policyCount: 4 },
  "moderation_actions": { class: "RLS_REQUIRED", policyCount: 1 },
  "moderation_reports": { class: "RLS_REQUIRED", policyCount: 3 },
  "neighborhood_areas": { class: "RLS_REQUIRED", policyCount: 2 },
  "notification_category_preferences": { class: "RLS_REQUIRED", policyCount: 3 },
  "notification_delivery_attempts": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "notification_devices": { class: "RLS_REQUIRED", policyCount: 1 },
  "notification_preferences": { class: "RLS_REQUIRED", policyCount: 3 },
  "notifications": { class: "RLS_REQUIRED", policyCount: 1 },
  "passport_contribution_events": { class: "RLS_REQUIRED", policyCount: 6 },
  "passport_memories": { class: "RLS_REQUIRED", policyCount: 6 },
  "passport_postcards": { class: "RLS_REQUIRED", policyCount: 4 },
  "passport_stamps": { class: "RLS_REQUIRED", policyCount: 7 },
  "passport_stamps_gps": { class: "RLS_REQUIRED", policyCount: 5 },
  "passport_visibility_preferences": { class: "RLS_REQUIRED", policyCount: 5 },
  "place_ai_summaries": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_best_of": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_cache_invalidation_queue": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_coverage_buckets": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_days": { class: "RLS_REQUIRED", policyCount: 1 },
  "place_image_reports": { class: "RLS_REQUIRED", policyCount: 1 },
  "place_living_cache": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_merge_log": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_mismatch_reports": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_profiles": { class: "RLS_REQUIRED", policyCount: 1 },
  "place_top_contributors": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "place_votes": { class: "RLS_REQUIRED", policyCount: 1 },
  "places": { class: "RLS_REQUIRED", policyCount: 1 },
  "plan_attendance_events": { class: "RLS_REQUIRED", policyCount: 3 },
  "plan_checkins": { class: "RLS_REQUIRED", policyCount: 7 },
  "plan_editors": { class: "RLS_REQUIRED", policyCount: 1 },
  "plan_geofences": { class: "RLS_REQUIRED", policyCount: 5 },
  "portava_featured": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "post_bucket_ledger": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "post_edits": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "post_event_links": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "post_hides": { class: "RLS_REQUIRED", policyCount: 1 },
  "post_impressions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "post_media": { class: "RLS_REQUIRED", policyCount: 5 },
  "post_media_moderation_ledger": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "post_reactions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification. Flagged in docs/RECONCILIATION-PACKET.md §5.4 (Class A) as user-facing -- deny-all-by-design here may be an oversight rather than a decision; needs explicit owner confirmation, not inherited silence." },
  "post_saves": { class: "RLS_REQUIRED", policyCount: 5 },
  "post_shares": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification. Flagged in docs/RECONCILIATION-PACKET.md §5.4 (Class A) as user-facing -- deny-all-by-design here may be an oversight rather than a decision; needs explicit owner confirmation, not inherited silence." },
  "posts": { class: "RLS_REQUIRED", policyCount: 5 },
  "posts_comments": { class: "RLS_REQUIRED", policyCount: 5 },
  "posts_likes": { class: "RLS_REQUIRED", policyCount: 5 },
  "price_baselines": { class: "RLS_REQUIRED", policyCount: 2 },
  "profile_emergency_contacts": { class: "RLS_REQUIRED", policyCount: 2 },
  "profile_privacy_settings": { class: "RLS_REQUIRED", policyCount: 2 },
  "profile_views": { class: "RLS_REQUIRED", policyCount: 1 },
  "profiles": { class: "RLS_REQUIRED", policyCount: 3 },
  "pulse_geo_tags": { class: "RLS_REQUIRED", policyCount: 5 },
  "push_retry_queue": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "quick_availability_status": { class: "RLS_REQUIRED", policyCount: 4 },
  "rank_events": { class: "RLS_REQUIRED", policyCount: 2 },
  "ranking_config": { class: "RLS_REQUIRED", policyCount: 1 },
  "ranking_config_audit_log": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "ranking_debug_samples": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_addons": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_admin_access_logs": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_admin_actions": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_admin_response_templates": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_applications": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_availability": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_beta_access": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_booking_addons": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_booking_extensions": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_bookings": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_city_restrictions": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_city_rollouts": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_disputes": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_earnings_ledger": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_emergency_contacts_snapshot": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_fee_rules": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_global_controls": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_launch_audit_logs": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_launch_checklists": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_launch_controls": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_marketplace_analytics_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_match_preferences": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_match_scores": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_offers": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_package_stops": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_packages": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_payouts": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_policy_flags": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_pricing_rules": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_profiles": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_requests": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_review_notes": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "rent_buddy_reviews": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_route_change_requests": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_route_stops": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_safety_checkins": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_safety_events": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_saved": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_search_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "rent_buddy_support_reports": { class: "RLS_REQUIRED", policyCount: 3 },
  "rent_buddy_tag_consents": { class: "RLS_REQUIRED", policyCount: 4 },
  "rent_buddy_tips": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_training_checklist": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_user_limits": { class: "RLS_REQUIRED", policyCount: 2 },
  "rent_buddy_waitlist": { class: "RLS_REQUIRED", policyCount: 2 },
  "report_evidence": { class: "RLS_REQUIRED", policyCount: 1 },
  "reports": { class: "RLS_REQUIRED", policyCount: 1 },
  "reviews": { class: "RLS_REQUIRED", policyCount: 5 },
  "route_legs": { class: "RLS_REQUIRED", policyCount: 2 },
  "route_plan_members": { class: "RLS_REQUIRED", policyCount: 4 },
  "route_plans": { class: "RLS_REQUIRED", policyCount: 5 },
  "route_stops": { class: "RLS_REQUIRED", policyCount: 2 },
  "safe_return_contacts": { class: "RLS_REQUIRED", policyCount: 1 },
  "safe_return_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "safe_return_live_shares": { class: "RLS_REQUIRED", policyCount: 1 },
  "safe_return_sessions": { class: "RLS_REQUIRED", policyCount: 1 },
  "saved_messages": { class: "RLS_REQUIRED", policyCount: 3 },
  "saved_places": { class: "RLS_REQUIRED", policyCount: 2 },
  "search_history": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "shared_moment_audit_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "shared_moment_contributions": { class: "RLS_REQUIRED", policyCount: 1 },
  "shared_moment_memberships": { class: "RLS_REQUIRED", policyCount: 1 },
  "shared_moment_suggestions": { class: "RLS_REQUIRED", policyCount: 1 },
  "shared_moments": { class: "RLS_REQUIRED", policyCount: 1 },
  "stamp_admin_audit_log": { class: "RLS_REQUIRED", policyCount: 1 },
  "stamp_admires": { class: "RLS_REQUIRED", policyCount: 2 },
  "stamp_artwork_definitions": { class: "RLS_REQUIRED", policyCount: 2 },
  "stamp_artwork_versions": { class: "RLS_REQUIRED", policyCount: 2 },
  "stamp_award_events": { class: "RLS_REQUIRED", policyCount: 3 },
  "stamp_campaigns": { class: "RLS_REQUIRED", policyCount: 2 },
  "stamp_collection_items": { class: "RLS_REQUIRED", policyCount: 1 },
  "stamp_collections": { class: "RLS_REQUIRED", policyCount: 1 },
  "stamp_definitions": { class: "RLS_REQUIRED", policyCount: 2 },
  "stamp_generation_queue": { class: "RLS_REQUIRED", policyCount: 1 },
  "stamp_milestones": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "stamp_progress": { class: "RLS_REQUIRED", policyCount: 2 },
  "stamp_reconciliation_log": { class: "RLS_REQUIRED", policyCount: 1 },
  "stories": { class: "RLS_REQUIRED", policyCount: 1 },
  "story_reactions": { class: "RLS_REQUIRED", policyCount: 2 },
  "story_replies": { class: "RLS_REQUIRED", policyCount: 2 },
  "story_views": { class: "RLS_REQUIRED", policyCount: 2 },
  "tags": { class: "RLS_REQUIRED", policyCount: 4 },
  "telegraph_chat_suggestions": { class: "RLS_REQUIRED", policyCount: 3 },
  "thread_reports": { class: "RLS_REQUIRED", policyCount: 1 },
  "traveler_passports": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_activity_log": { class: "RLS_REQUIRED", policyCount: 1 },
  "trip_area_preferences": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_autopilot_proposals": { class: "RLS_REQUIRED", policyCount: 1 },
  "trip_autopilot_settings": { class: "RLS_REQUIRED", policyCount: 1 },
  "trip_availability": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_budget": { class: "RLS_REQUIRED", policyCount: 1 },
  "trip_checklist_items": { class: "RLS_REQUIRED", policyCount: 4 },
  "trip_checklists": { class: "RLS_REQUIRED", policyCount: 3 },
  "trip_crew_location_events": { class: "RLS_REQUIRED", policyCount: 4 },
  "trip_crew_location_preferences": { class: "RLS_REQUIRED", policyCount: 5 },
  "trip_crew_location_sessions": { class: "RLS_REQUIRED", policyCount: 8 },
  "trip_destinations": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_documents": { class: "RLS_REQUIRED", policyCount: 4 },
  "trip_invite_link_attempts": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "trip_invite_links": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_join_requests": { class: "RLS_REQUIRED", policyCount: 3 },
  "trip_members": { class: "RLS_REQUIRED", policyCount: 4 },
  "trip_notes": { class: "RLS_REQUIRED", policyCount: 4 },
  "trip_plan_items": { class: "RLS_REQUIRED", policyCount: 3 },
  "trip_readiness_items": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_readiness_snapshots": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_reminders": { class: "RLS_REQUIRED", policyCount: 2 },
  "trip_reservations": { class: "RLS_REQUIRED", policyCount: 5 },
  "trip_saved_places": { class: "RLS_REQUIRED", policyCount: 3 },
  "trip_traveler_passports": { class: "RLS_REQUIRED", policyCount: 2 },
  "trips": { class: "RLS_REQUIRED", policyCount: 6 },
  "trust_admin_actions": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "trust_caps": { class: "RLS_REQUIRED", policyCount: 1 },
  "trust_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "trust_profiles": { class: "RLS_REQUIRED", policyCount: 1 },
  "trust_restrictions": { class: "RLS_REQUIRED", policyCount: 1 },
  "trust_reviews": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "trust_settings": { class: "RLS_REQUIRED", policyCount: 1 },
  "universal_stamp_catalog": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_account_states": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_availability": { class: "RLS_REQUIRED", policyCount: 4 },
  "user_deletion_requests": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_follows": { class: "RLS_REQUIRED", policyCount: 5 },
  "user_friendships": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_hashtag_follows": { class: "RLS_REQUIRED", policyCount: 8 },
  "user_interaction_cooldowns": { class: "RLS_REQUIRED", policyCount: 1 },
  "user_location_preferences": { class: "RLS_REQUIRED", policyCount: 3 },
  "user_location_privacy": { class: "RLS_REQUIRED", policyCount: 3 },
  "user_location_state": { class: "RLS_REQUIRED", policyCount: 5 },
  "user_locations": { class: "RLS_REQUIRED", policyCount: 3 },
  "user_message_settings": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_mutes": { class: "RLS_REQUIRED", policyCount: 1 },
  "user_preference_events": { class: "RLS_REQUIRED", policyCount: 1 },
  "user_preference_profiles": { class: "RLS_REQUIRED", policyCount: 1 },
  "user_privacy_settings": { class: "RLS_REQUIRED", policyCount: 1 },
  "user_recent_places": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "user_restrictions": { class: "RLS_REQUIRED", policyCount: 1 },
  "user_saves": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_stamp_showcase": { class: "RLS_REQUIRED", policyCount: 2 },
  "user_stamps": { class: "RLS_REQUIRED", policyCount: 4 },
  "user_suggestion_seen": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "user_trust_scores": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "viewer_creator_fatigue": { class: "RLS_REQUIRED", policyCount: 1 },
  "weather_cache": { class: "DENY_ALL_BY_DESIGN", policyCount: 0, reason: "Baseline-derived 2026-08-19: RLS enabled, zero policies in the committed baseline -- deny-all by construction (only service_role, which bypasses RLS, can read/write this table). Mechanically classified; not yet reviewed for a table-specific justification." },
  "wishlist_places": { class: "RLS_REQUIRED", policyCount: 1 },
};
