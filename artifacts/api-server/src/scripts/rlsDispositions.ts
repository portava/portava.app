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

/* ════════════════════════════════════════════════════════════════════════════
 * RLS POLICY SHAPE RULES — lane B5, 2026-09-07
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Three defect classes that 2334 / 2337 / 2530 / 2531 spent a day repairing by
 * hand, expressed as rules that src/test/rlsPolicyShapeLive.test.ts evaluates
 * against the CI database's live pg_policies on every live-db run, so the NEXT
 * policy of the same shape fails in CI instead of in an audit.
 *
 *   1. A policy that reaches trip_members without BOTH a role gate and a
 *      status gate. trip_members encodes "pending" in two columns (legacy
 *      role='invited', current status='invited'); a predicate reading one of
 *      them admits pending invitees. Includes policies that reach the table
 *      through a public function that carries the defect.
 *   2. A FOR ALL policy with no WITH CHECK. Postgres then reuses USING as the
 *      write check, which is only correct when USING already IS the intended
 *      write predicate.
 *   3. A SELECT policy that admits on `auth.uid() = ANY(<array column>)` with
 *      no crew gate — an array of ids is a grant list, not a membership, and
 *      2337 measured a stranger listed in one reading the row.
 *
 * THESE ARE TEXTUAL. They read the deparsed policy expression as a string and
 * pattern-match it. That is exactly the heuristic that mis-counted 2337's
 * scope in both directions (it reported 24; the true number was 34), and the
 * only honest way to run a textual check is:
 *
 *   - say so (this paragraph);
 *   - enumerate what it CANNOT see and carry that as a captured list, not as
 *     silence: UNGATED_TRIP_MEMBERS_FUNCTIONS below was read from pg_proc on
 *     portava-ci, not guessed;
 *   - pass what it cannot decide only through an EXPLICIT, REVIEWED, NAMED
 *     allowlist that may only shrink — every entry says why it is there and
 *     what removes it;
 *   - FAIL when it examines nothing (assertSnapshotExamined).
 *
 * A green run here means "no policy of these three textual shapes exists on
 * CI outside the named lists". It does not mean the RLS is correct.
 */

/** One row of public.pg_policies_snapshot_v2() (migration 2532). */
export interface PolicySnapshotRow {
  tablename: string;
  policyname: string;
  /** 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL' as pg_policies spells it. */
  cmd: string;
  /** pg_policies.roles::text, e.g. "{public}", "{authenticated}", "{service_role}". */
  roles: string;
  permissive?: string | null;
  qual: string | null;
  with_check: string | null;
}

export const policyKey = (r: Pick<PolicySnapshotRow, "tablename" | "policyname">): string =>
  `${r.tablename}::${r.policyname}`;

const combinedExpr = (r: PolicySnapshotRow): string => `${r.qual ?? ""} ${r.with_check ?? ""}`;
const normalise = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, "");

/** Parses "{a,b}" into its members. */
export function parseRoles(roles: string): string[] {
  return roles.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}
export const isServiceRoleOnly = (roles: string): boolean => {
  const rs = parseRoles(roles);
  return rs.length > 0 && rs.every((r) => r === "service_role");
};

/* ── Rule 1: trip_members reachability ─────────────────────────────────────── */

export const TRIP_MEMBERS_TEXT_RE = /\btrip_members\b/;
export const ROLE_GATE_RE = /\brole\b/;
export const STATUS_GATE_RE = /\bstatus\b/;
/** The 2334/2337 helpers. Each encodes lib/http.ts requireTripMember exactly. */
export const AUTHZ_CREW_HELPER_RE =
  /\bauthz\.(is_trip_crew|shares_accepted_trip|is_accepted_trip_member|accepted_trip_role|accepted_trip_ids)\s*\(/;

/**
 * public functions whose BODY reads trip_members with NO status gate, so any
 * policy calling them inherits the defect without ever naming the table.
 * CAPTURED from pg_proc on portava-ci 2026-09-07 (every public/authz function
 * whose prosrc mentions trip_members was read); recapture when functions
 * change. Deliberately NOT listed here because 2337 repointed them at
 * authz.is_trip_crew: public.is_accepted_trip_member, can_see_post,
 * can_post_to_trip, can_see_postcard.
 */
export const UNGATED_TRIP_MEMBERS_FUNCTIONS: ReadonlyArray<string> = [
  // role IN (owner,member,co_host,viewer) OR trips.owner_id OR public trip; NO status.
  "can_see_trip",
  // self-join, no role, no status; EXECUTE held by anon/authenticated — an RPC
  // oracle of 2182's class. Named in no policy today; listed so that if one
  // ever calls it, this rule sees it.
  "shares_trip_with",
];
const ungatedFunctionRe = (): RegExp =>
  new RegExp(`\\b(?:public\\.)?(${UNGATED_TRIP_MEMBERS_FUNCTIONS.join("|")})\\s*\\(`);

export type TripMembersVerdict =
  | { kind: "not_applicable" }
  | { kind: "gated_by_helper"; via: string }
  | { kind: "gated_inline" }
  | { kind: "ungated_direct" }
  | { kind: "ungated_via_function"; via: string };

export function tripMembersVerdict(row: PolicySnapshotRow): TripMembersVerdict {
  const expr = combinedExpr(row);
  if (TRIP_MEMBERS_TEXT_RE.test(expr)) {
    return ROLE_GATE_RE.test(expr) && STATUS_GATE_RE.test(expr) ? { kind: "gated_inline" } : { kind: "ungated_direct" };
  }
  const fn = expr.match(ungatedFunctionRe());
  if (fn) return { kind: "ungated_via_function", via: fn[1] };
  const helper = expr.match(AUTHZ_CREW_HELPER_RE);
  if (helper) return { kind: "gated_by_helper", via: `authz.${helper[1]}` };
  return { kind: "not_applicable" };
}

export interface ReviewedAllowlistEntry {
  key: string;
  reason: string;
  reviewedBy: string;
  date: string;
}
export interface KnownOpenEntry {
  key: string;
  /** What the rule reports for it today; the stale-entry check verifies this is still true. */
  kind: string;
  reason: string;
  since: string;
  /** The event that makes this entry stale. When it happens, the entry MUST be removed. */
  removeWhen: string;
}

/**
 * Policies that name trip_members and are CORRECT without a status gate.
 * Reviewed, not inherited.
 */
export const TRIP_MEMBERS_REVIEWED_ALLOWLIST: ReadonlyArray<ReviewedAllowlistEntry> = [
  {
    key: "trip_members::trip_members_insert",
    reason:
      "Policy ON the membership table itself; WITH CHECK gates on trips.owner_id, which governs who may CREATE a membership row. A status gate here would be circular (2337 header, 'FOUR are correct as written').",
    reviewedBy: "migration 2337 (lane 2337) / lane B5",
    date: "2026-09-07",
  },
  {
    key: "trip_members::trip_members_delete",
    reason:
      "Policy ON the membership table itself; USING gates on trips.owner_id, which governs who may REMOVE a membership row. Same reasoning as trip_members_insert.",
    reviewedBy: "migration 2337 (lane 2337) / lane B5",
    date: "2026-09-07",
  },
];

const CAN_SEE_TRIP_CALLERS: ReadonlyArray<string> = [
  "map_pins::pins_select",
  "trip_checklist_items::trip_checklist_items_delete",
  "trip_checklist_items::trip_checklist_items_insert",
  "trip_checklist_items::trip_checklist_items_members",
  "trip_checklist_items::trip_checklist_items_update",
  "trip_checklists::trip_checklists_insert",
  "trip_checklists::trip_checklists_members",
  "trip_destinations::trip_destinations_select",
  "trip_documents::trip_documents_insert",
  "trip_documents::trip_documents_members",
  "trip_members::trip_members_select",
  "trip_notes::trip_notes_insert",
  "trip_notes::trip_notes_select",
  "trip_reminders::trip_reminders_insert",
  "trip_saved_places::trip_saved_places_insert",
  "trip_saved_places::trip_saved_places_members",
  "trips::trips_select",
];

/**
 * Policies the rule reports as UNGATED that are known, recorded, and NOT yet
 * fixed. May only shrink. Adding a row here to make CI green is the one thing
 * this list exists to prevent — every row names the event that removes it.
 */
export const TRIP_MEMBERS_KNOWN_OPEN: ReadonlyArray<KnownOpenEntry> = [
  {
    key: "highlights::highlights_select_active",
    kind: "ungated_direct",
    reason:
      "trip_only branch is a trip_members self-join with no role and no status gate; pending invitees and removed members read trip_only highlights (measured on portava-ci 2026-09-07). Repaired by migration 2530, which rewrites only that branch.",
    since: "2026-09-07",
    removeWhen: "migration 2530 is applied to portava-ci. The stale-entry check fails until you do.",
  },
  ...CAN_SEE_TRIP_CALLERS.map((key) => ({
    key,
    kind: "ungated_via_function",
    reason:
      "Reaches trip_members through public.can_see_trip(uuid), whose body gates on role IN (owner,member,co_host,viewer) OR trips.owner_id OR a public trip, and NEVER reads status — so a pending invitee (role='member', status='invited') passes. 2337 named the defect in can_see_trip and did not repair it; no migration does. Not a lane B5 deliverable: recorded so it cannot be forgotten.",
    since: "2026-09-07",
    removeWhen:
      "public.can_see_trip gains coalesce(status,'accepted')='accepted' (or these policies are repointed at authz.is_trip_crew) in an applied migration.",
  })),
];

/* ── Rule 2: FOR ALL without WITH CHECK ─────────────────────────────────────── */

export type ForAllVerdict =
  | "not_applicable"
  | "has_with_check"
  | "exempt_service_role_only"
  | "exempt_deny_all"
  | "exempt_service_predicate"
  | "reuses_using";

/**
 * A FOR ALL policy with no WITH CHECK reuses USING for INSERT/UPDATE. Three
 * shapes are exempt because reuse cannot widen them: TO service_role only
 * (bypasses RLS anyway), USING (false) (deny-all), and USING
 * (auth.role() = 'service_role') (service-only by predicate). Everything else
 * must be in the captured baseline.
 */
export function forAllWriteCheckVerdict(row: PolicySnapshotRow): ForAllVerdict {
  if (row.cmd !== "ALL") return "not_applicable";
  if (row.with_check != null) return "has_with_check";
  if (isServiceRoleOnly(row.roles)) return "exempt_service_role_only";
  const q = normalise(row.qual);
  if (q === "false" || q === "(false)") return "exempt_deny_all";
  if (q === "(auth.role()='service_role'::text)" || q === "auth.role()='service_role'::text") return "exempt_service_predicate";
  return "reuses_using";
}

/**
 * CAPTURED from portava-ci 2026-09-07: every FOR ALL policy for a non-service
 * role with no WITH CHECK whose USING is neither deny-all nor service-only.
 * NOT INDIVIDUALLY REVIEWED. Each entry carries exactly one fact: on this
 * policy, USING doubles as the write check. For most (`auth.uid() = user_id`)
 * that is the intended write predicate. For some it is visibly not —
 * trip_checklists::trip_checklists_members and
 * trip_checklist_items::trip_checklist_items_members are `USING
 * (can_see_trip(trip_id))`, so anyone who can SEE the trip (including any
 * viewer of a PUBLIC trip) can INSERT, UPDATE and DELETE its checklist rows.
 * That is reported, not excused, by being here.
 *
 * SHRINK-ONLY. A new FOR ALL policy without WITH CHECK fails the live guard;
 * an entry here that gains WITH CHECK fails the stale check until removed.
 */
export const FOR_ALL_WITHOUT_WITH_CHECK_BASELINE: ReadonlyArray<string> = [
  "buddy_availability_exceptions::bae_own_write",
  "buddy_services::bs_own_write",
  "compass_conversation_messages::compass_conversation_messages_owner",
  "compass_feedback::compass_feedback_owner",
  "compass_recent_context::compass_recent_context_owner",
  "compass_settings::compass_settings_owner",
  "event_cohosts::event_cohosts_host_write",
  "event_drafts::event_drafts_own",
  "event_media::event_media_uploader_write",
  "event_posts::event_posts_author_write",
  "event_reminders::event_reminders_own",
  "event_saves::event_saves_own",
  "event_share_links::event_share_links_creator_manage",
  "location_sessions::lsess_own",
  "location_snapshots::lsnap_own",
  "memories::memories_owner_all",
  "memory_items::memory_items_via_memory",
  "memory_likes::memory_likes_own",
  "memory_saves::memory_saves_own",
  "passport_memories::passport_memories_owner_all",
  "passport_visibility_preferences::passport_visibility_preferences_owner",
  "profile_emergency_contacts::pec_own",
  "rent_buddy_addons::rb_addon_own",
  "rent_buddy_applications::rb_apps_own",
  "rent_buddy_availability::rb_avail_own",
  "rent_buddy_match_preferences::rb_match_prefs_own",
  "rent_buddy_offers::rb_offers_buddy",
  "rent_buddy_package_stops::rb_pkg_stops_own",
  "rent_buddy_packages::rb_pkg_own",
  "rent_buddy_profiles::rb_profiles_own",
  "rent_buddy_requests::rb_requests_own",
  "rent_buddy_safety_checkins::rb_checkin_own",
  "rent_buddy_saved::rb_saved_own",
  "rent_buddy_tips::rb_tips_own",
  "rent_buddy_training_checklist::rb_train_own",
  "rent_buddy_waitlist::rb_waitlist_own",
  "route_legs::route_legs_owner_all",
  "route_stops::route_stops_owner_all",
  "safe_return_sessions::srs_own",
  "stamp_admires::sa_admirer_write",
  "stamp_campaigns::stamp_campaigns_admin_all",
  "stamp_definitions::stamp_definitions_admin_all",
  "traveler_passports::traveler_passports_own",
  "trip_area_preferences::tap_own",
  "trip_budget::trip_budget_owner",
  "trip_checklist_items::trip_checklist_items_members",
  "trip_checklists::trip_checklists_members",
  "trip_crew_location_preferences::crew_prefs_self_write",
  "trip_crew_location_sessions::crew_sessions_self",
  "trip_destinations::trip_destinations_manage",
  "trip_invite_links::trip_invite_links_owner",
  "trip_reminders::trip_reminders_own",
  "trip_traveler_passports::trip_traveler_passports_own",
  "user_mutes::Users can manage their own mutes",
  "user_privacy_settings::Users can manage their own privacy settings",
  "user_restrictions::Users can manage their own restrictions",
  "user_saves::Users can manage their own saves",
  "user_stamp_showcase::uss_owner_all",
  "wishlist_places::Users manage own wishlist places",
];

/* ── Rule 3: array-column grants without a crew gate ───────────────────────── */

/** `auth.uid() = ANY (<column>)` — a column, not an ARRAY[...] literal. */
export const ARRAY_GRANT_RE = /auth\.uid\(\)\s*=\s*ANY\s*\(\s*(?!ARRAY\b)[A-Za-z_][A-Za-z0-9_.]*\s*\)/;

export type ArrayGrantVerdict = "not_applicable" | "array_grant_with_crew_gate" | "array_grant_ungated";

export function arrayGrantVerdict(row: PolicySnapshotRow): ArrayGrantVerdict {
  if (row.cmd !== "SELECT" && row.cmd !== "ALL") return "not_applicable";
  if (isServiceRoleOnly(row.roles)) return "not_applicable";
  const q = row.qual ?? "";
  if (!ARRAY_GRANT_RE.test(q)) return "not_applicable";
  return AUTHZ_CREW_HELPER_RE.test(q) ? "array_grant_with_crew_gate" : "array_grant_ungated";
}

export const ARRAY_GRANT_KNOWN_OPEN: ReadonlyArray<KnownOpenEntry> = [
  {
    key: "trip_crew_location_sessions::crew_session_owner_select",
    kind: "array_grant_ungated",
    reason:
      "`auth.uid() = ANY(allowed_member_ids)` with no membership, status or expiry test. A stranger listed in the array reads the session (measured on portava-ci 2026-09-07), and this branch dominates crew_sessions_recipients_read completely. Repaired by migration 2531 (owner-only).",
    since: "2026-09-07",
    removeWhen: "migration 2531 is applied to portava-ci. The stale-entry check fails until you do.",
  },
];

/* ── Evaluation ────────────────────────────────────────────────────────────── */

/**
 * Two policies that must be present in ANY snapshot of this database. If they
 * are missing the snapshot is not the database we think it is — wrong project,
 * empty result, truncated page — and every rule above would pass vacuously.
 */
export const SNAPSHOT_SENTINELS: ReadonlyArray<string> = [
  "trip_members::trip_members_insert",
  "trip_readiness_items::tri_member_read",
];

/** Throws unless the snapshot examined something real. Vacuity is failure. */
export function assertSnapshotExamined(rows: ReadonlyArray<PolicySnapshotRow>): void {
  if (rows.length === 0) {
    throw new Error("RLS policy snapshot returned ZERO policies. A check that examines nothing must fail, not pass.");
  }
  const keys = new Set(rows.map(policyKey));
  const missing = SNAPSHOT_SENTINELS.filter((k) => !keys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `RLS policy snapshot is missing sentinel policies ${missing.join(", ")} — this is not the database these rules were written against (${rows.length} rows examined).`,
    );
  }
}

export interface PolicyShapeReport {
  examined: number;
  tripMembersOffenders: string[];
  tripMembersStaleKnownOpen: string[];
  tripMembersMissingReviewed: string[];
  forAllOffenders: string[];
  forAllStaleBaseline: string[];
  arrayGrantOffenders: string[];
  arrayGrantStaleKnownOpen: string[];
}

/** Pure. The live test feeds it pg_policies_snapshot_v2(); the unit test feeds it fixtures. */
export function evaluatePolicySnapshot(rows: ReadonlyArray<PolicySnapshotRow>): PolicyShapeReport {
  const byKey = new Map(rows.map((r) => [policyKey(r), r] as const));
  const reviewed = new Set(TRIP_MEMBERS_REVIEWED_ALLOWLIST.map((e) => e.key));
  const tmKnown = new Map(TRIP_MEMBERS_KNOWN_OPEN.map((e) => [e.key, e] as const));
  const agKnown = new Map(ARRAY_GRANT_KNOWN_OPEN.map((e) => [e.key, e] as const));
  const baseline = new Set(FOR_ALL_WITHOUT_WITH_CHECK_BASELINE);

  const tripMembersOffenders: string[] = [];
  const forAllOffenders: string[] = [];
  const arrayGrantOffenders: string[] = [];

  for (const r of rows) {
    const key = policyKey(r);
    const tm = tripMembersVerdict(r);
    if ((tm.kind === "ungated_direct" || tm.kind === "ungated_via_function") && !reviewed.has(key) && !tmKnown.has(key)) {
      tripMembersOffenders.push(`${key} [${tm.kind}${"via" in tm ? ` via ${tm.via}` : ""}]`);
    }
    if (forAllWriteCheckVerdict(r) === "reuses_using" && !baseline.has(key)) {
      forAllOffenders.push(`${key} USING ${r.qual}`);
    }
    if (arrayGrantVerdict(r) === "array_grant_ungated" && !agKnown.has(key)) {
      arrayGrantOffenders.push(key);
    }
  }

  const tripMembersStaleKnownOpen = TRIP_MEMBERS_KNOWN_OPEN.filter((e) => {
    const r = byKey.get(e.key);
    if (!r) return true; // policy gone: entry is stale
    return tripMembersVerdict(r).kind !== e.kind;
  }).map((e) => e.key);
  const tripMembersMissingReviewed = TRIP_MEMBERS_REVIEWED_ALLOWLIST.filter((e) => !byKey.has(e.key)).map((e) => e.key);
  const forAllStaleBaseline = FOR_ALL_WITHOUT_WITH_CHECK_BASELINE.filter((k) => {
    const r = byKey.get(k);
    return !r || forAllWriteCheckVerdict(r) !== "reuses_using";
  });
  const arrayGrantStaleKnownOpen = ARRAY_GRANT_KNOWN_OPEN.filter((e) => {
    const r = byKey.get(e.key);
    return !r || arrayGrantVerdict(r) !== e.kind;
  }).map((e) => e.key);

  return {
    examined: rows.length,
    tripMembersOffenders: tripMembersOffenders.sort(),
    tripMembersStaleKnownOpen,
    tripMembersMissingReviewed,
    forAllOffenders: forAllOffenders.sort(),
    forAllStaleBaseline,
    arrayGrantOffenders: arrayGrantOffenders.sort(),
    arrayGrantStaleKnownOpen,
  };
}
