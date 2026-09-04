/**
 * Account-deletion coverage manifest.
 *
 * WHY THIS EXISTS. executeAccountDeletion keeps an ANONYMISED TOMBSTONE profile
 * rather than deleting profiles(id), so no FK cascade hanging off profiles ever
 * fires — every table has to be cleared by hand. The hand-written list covers
 * 24 tables. Measured against production on 2026-08-22, **255 tables carry a
 * user-identifying column and 229 of them are untouched by deletion**: every
 * behavioural, presence and location row a user ever generated survives account
 * deletion indefinitely, keyed to a uuid that is still joinable across tables.
 *
 * This manifest does not fix that. It makes it IMPOSSIBLE TO GROW SILENTLY.
 * Modelled on rlsDispositions.ts: every user-keyed table in the baseline must
 * appear in exactly one bucket below, and checkDeletionCoverage.ts fails if a
 * NEW one appears in none of them. A new table therefore cannot enter the blind
 * spot without someone writing down what happens to it on deletion.
 *
 * THE BUCKETS ARE NOT EQUIVALENT:
 *   ERASED_BY_CASCADE     — the service actually deletes these today.
 *   RETAINED_WITH_REASON  — a DECIDED retention, with the reason written down.
 *   UNCLASSIFIED_BACKLOG  — NOT a decision. Pre-existing tables nobody has
 *                           triaged. Being on this list means the data survives
 *                           deletion and no one has said whether it should.
 *
 * Emptying UNCLASSIFIED_BACKLOG is owner decision D6 in the A0 packet. Entries
 * move to ERASED_BY_CASCADE (with matching code in AccountDeletionService) or to
 * RETAINED_WITH_REASON (with a reason a user could be shown). Nothing should be
 * left here permanently.
 */

/** Tables AccountDeletionService clears today. */
export const ERASED_BY_CASCADE: readonly string[] = [
  // PENDING BASELINE RECAPTURE — do not add the string yet.
  //   "phone_verification_challenges" (migration 2142) holds a phone number and
  //   a hashed live credential, and IS already deleted explicitly by
  //   AccountDeletionService (step "delete_phone_challenges") — not by its FK,
  //   because the tombstone profile means no cascade off profiles ever fires.
  //   It cannot be listed here until the baseline snapshot is recaptured: this
  //   gate reads baseline/20260819_baseline_structure.sql and rejects entries it
  //   cannot see as "STALE". Add the string in the same change that recaptures
  //   the baseline.
  // Erased by a DATABASE CONSTRAINT, not by service code — the one entry here
  // that AccountDeletionService never names. passport_stamps_gps.user_id
  // REFERENCES auth.users ON DELETE CASCADE, and step 5 calls
  // auth.admin.deleteUser, so the coordinates go. Verified against the live
  // schema on 2026-08-23; it sat in UNCLASSIFIED_BACKLOG until then because the
  // absence of a service reference was read as absence of deletion.
  //
  // Its PARENT is the open question, not this: passport_stamps references
  // profiles, which on production has no FK to auth.users, so the stamp itself
  // survives while its coordinates do not. That stays with D6.
  "passport_stamps_gps",
  // IG-02 intel tables. Registered here in the SAME change that creates them:
  // a new user-keyed table gets a deletion fate on day one, which is the whole
  // point of this manifest. Their append-only triggers permit DELETE only inside
  // a declared erasure (SET LOCAL portava.erasure_in_progress).
  "intel_observations",
  "intel_claims",
  "intel_evidence",
  "intel_confirmations",
  "intel_state_snapshots",
  // IG-02 contribution consent (migration 2172, user_id-keyed). Its ON DELETE
  // CASCADE to profiles never fires because the deletion keeps an anonymised
  // tombstone profile — the same mistake 2187 made for derived memory. Erased
  // explicitly by AccountDeletionService's `delete_intel_consent` step (a direct
  // scoped delete; the table is not append-only), with service_role DELETE
  // granted by migration 2203.
  "intel_contribution_consent",
  // IG-10 non-cash reward ledger (migration 2170, actor_id-keyed). Its ON DELETE
  // CASCADE to profiles never fires under the tombstone (same as consent above),
  // so a departed contributor's earning rows would survive while the observations
  // that earned them are erased by erase_intel_for_actor. Erased explicitly by
  // AccountDeletionService's `delete_intel_reward_ledger` step (a direct scoped
  // delete; the ledger has no DELETE-blocking trigger), with service_role DELETE
  // granted by migration 2204. Non-cash, so no financial-retention reason to keep it.
  "intel_reward_ledger",
  "comment_likes",
  "devices",
  "event_saves",
  "hidden_gem_saves",
  "hidden_gems",
  "identity_verifications",
  "messages",
  "notification_devices",
  "notifications",
  "post_media",
  "post_reactions",
  "post_saves",
  "post_shares",
  "posts",
  "posts_comments",
  "posts_likes",
  "saved_places",
  "search_history",
  "stories",
  "story_reactions",
  "story_replies",
  "story_views",
  "user_follows",
  "wishlist_places",
  // Trip "Memories" UGC + engagement (audit MEM·H2). AccountDeletionService now
  // collects each memory_item's media path (post-media/memories/{userId}/…)
  // BEFORE deleting, removes the storage objects, and clears the rows: the
  // user's owned memories (owner_id, all states incl. soft-deleted), their
  // children (memory_items, memory_tags/likes/saves by memory_id), and the
  // footprint the user left on other people's memories (likes/saves by user_id,
  // tags by tagged_user_id). memory_items and memory_tags are NOT listed here:
  // this manifest only tracks tables carrying a USER_IDENTIFYING_COLUMN, and
  // neither has one (memory_id / tagged_user_id are not in that set) — the
  // coverage check would flag them as STALE.
  "memories",
  "memory_likes",
  "memory_saves",
  // Passport / Wall owner-scoped tables (migrations 2260 / 2261 / 2271), each
  // keyed by user_id REFERENCES profiles(id) ON DELETE CASCADE. That cascade
  // never fires under the tombstone profile — the same mistake 2172/2170/2187
  // made for consent/reward-ledger/derived-memory — so the rows would survive
  // deletion as orphaned personal data (wall_session_intents even stores a
  // raw_text echo of typed input). Erased explicitly by AccountDeletionService's
  // `delete_availability_windows` / `delete_travel_dna_prefs` /
  // `delete_wall_session_intent` steps (direct scoped deletes keyed by user_id;
  // none is append-only). service_role already holds DELETE on all three (2260
  // and 2271 grant it explicitly; 2261 inherits it from Supabase default
  // privileges — verified against CI), so no grant migration was needed.
  "availability_windows",
  "passport_travel_dna_prefs",
  "wall_session_intents",
  // Derived memory (migrations 2183-2191). Erased explicitly by
  // AccountDeletionService's `erase_derived_memory` step, which calls the
  // SECURITY DEFINER erase_memory_for_user in one atomic, idempotent statement.
  // Deliberately NOT left to a foreign-key cascade: production's public.profiles
  // has no FK to auth.users, and the service keeps an anonymised tombstone
  // profile rather than deleting the row, so a profiles-keyed cascade can never
  // fire. Migration 2187 assumed it would; 2190 corrected it.
  "memory_projections",
  "memory_events",
  "memory_feedback",
];

/**
 * Tables the service does NOT delete, but where it NULLs a user-identifying
 * column on deletion — the 'anonymised / FK nulled' fate. The ROW is retained
 * (it is an operational record, not the user's content) and only the identifier
 * is removed. Distinct from ERASED_BY_CASCADE, whose rows are gone entirely.
 *
 * These carry a column declared `REFERENCES profiles(id) ON DELETE SET NULL`,
 * whose SET NULL never fires because the deletion keeps an anonymised TOMBSTONE
 * profile rather than deleting profiles(id) — so the service performs the SET
 * NULL by hand, restoring the FK's own declared intent.
 */
export const ANONYMISED_FK_NULLED: readonly string[] = [
  // intel_mission_candidates.accepted_by (migration 2167) names the contributor
  // who accepted a dispatched mission. The row is a city-scoped ops record with
  // no other user-identifying column, so it is kept while accepted_by is NULLed by
  // AccountDeletionService's `null_intel_mission_accepted_by` step — exactly what
  // the column's ON DELETE SET NULL declared, which the tombstone otherwise
  // silently defeats. UPDATE granted to service_role by 2167 and reaffirmed by 2211.
  "intel_mission_candidates",
];

/**
 * Tables read or written by the deletion flow itself, not user content to erase.
 */
export const DELETION_FLOW_TABLES: readonly string[] = [
  "user_account_states",
  "user_deletion_requests",
];

/**
 * DECIDED retentions. Each entry needs a reason a user could be shown.
 * Empty until D6 is answered — deliberately, so the backlog count stays honest.
 */
export const RETAINED_WITH_REASON: ReadonlyArray<{ table: string; reason: string }> = [
  // I1 (migration 2273). NOT user-keyed: it carries no actor column and no
  // personal data — subject_id is a place, distinct_actors is a count, and the
  // replay record is a set of weighted model inputs. It is an append-only log of
  // what the projection computed, keyed by (place, zone, claim_type); nothing in
  // it can be attributed to a person, so account deletion leaves it alone. The
  // per-person inputs behind a version are erased through erase_intel_for_actor
  // (observations, evidence, confirmations); a version row remains as the record
  // that an aggregate was once computed — the same posture as intel_claims and
  // intel_state_snapshots, which erase_intel_for_actor deliberately does not
  // touch ("aggregate beliefs about a place, not personal data"). Listed here so
  // the fate is written down, not inherited silence.
  {
    table: "intel_state_snapshot_versions",
    reason:
      "Append-only projection history with no actor column and no personal data (place key, counts, model inputs). " +
      "The per-person contributions behind it are erased by erase_intel_for_actor; the aggregate record is kept, as intel_claims/intel_state_snapshots are.",
  },
];

/**
 * NOT DECISIONS. Pre-existing user-keyed tables that survive account deletion and
 * that nobody has triaged. Baselined 2026-08-22 so the check can fail on NEW
 * tables while this backlog is worked down. Adding to this list is not allowed
 * for a new table — that is what the check enforces.
 */
export const UNCLASSIFIED_BACKLOG: readonly string[] = [
  // Live on production, migrations unpushed. Deletion fate is the Journey
  // workstream's decision, not this manifest's.
  "journey_observations",
  "journey_revocation_jobs",
  "journey_segment_revisions",
  "journey_shadow_cohort_assignments",
  "journey_shadow_ground_truth",
  "journey_shadow_qa_reports",
  "journey_shadow_session_issuances",
  "activity_events",
  "airport_profiles",
  "availability_nudges",
  "buddy_availability_exceptions",
  "buddy_services",
  "call_moderation_actions",
  "call_participants",
  "call_preferences",
  "circle_age_settings",
  "circle_checkins",
  "circle_context_settings",
  "circle_invites",
  "circle_member_visibility_overrides",
  "circle_memberships",
  "circle_presence",
  "circle_visibility_settings",
  "circles",
  "close_friends",
  "collections",
  "compass_active_user_badges",
  "compass_active_user_events",
  "compass_active_user_scores",
  "compass_admin_weight_sets",
  "compass_analytics",
  "compass_analytics_events",
  "compass_cache_invalidations",
  "compass_category_reputation",
  "compass_city_reputation",
  "compass_conversations",
  "compass_eligibility_logs",
  "compass_feed_cache",
  "compass_feed_sections",
  "compass_feedback",
  "compass_feedback_events",
  "compass_live_sessions",
  "compass_media_preload_manifest",
  "compass_memories",
  "compass_notification_decisions",
  "compass_outcome_events",
  "compass_preload_events",
  "compass_preload_queue",
  "compass_privacy_guard_logs",
  "compass_recent_context",
  "compass_recommendation_scores",
  "compass_safety_filter_logs",
  "compass_sense_nudges",
  "compass_sense_settings",
  "compass_served_recommendations",
  "compass_settings",
  "compass_suspension_requests",
  "compass_testing_scenarios",
  "compass_user_context_snapshots",
  "compass_user_navigation_patterns",
  "compass_user_preferences",
  "compass_user_profiles",
  "compass_visibility_boosts",
  "compass_visibility_cooldowns",
  "content_stamps",
  "creator_activity_scores",
  "daily_briefs",
  "delayed_post_location_events",
  "discovery_place_reports",
  "discovery_place_saves",
  "discovery_places",
  "discovery_shadow_serves",
  "event_activity_log",
  "event_attendee_states",
  "event_attendees",
  "event_cohosts",
  "event_drafts",
  "event_join_requests",
  "event_posts",
  "event_reminders",
  "event_reports",
  "event_roles",
  "event_rsvps",
  "event_updates",
  "event_waitlist",
  "events",
  "friend_requests",
  "geo_zones",
  "hashtag_reports",
  "hashtag_usage",
  "hidden_gem_reports",
  "hidden_gem_verifications",
  "hidden_gem_visits",
  "highlight_likes",
  "highlight_reports",
  "highlight_views",
  "highlights",
  "layover_events",
  "layover_sessions",
  "live_place_recaps",
  "local_guide_profiles",
  "location_preferences",
  "location_sessions",
  "location_snapshots",
  "location_trust_events",
  "map_pins",
  "media_ranking_snapshots",
  "media_stamp_reactions",
  "meetup_invites",
  "meetup_time_votes",
  // memories / memory_likes / memory_saves moved to ERASED_BY_CASCADE (MEM·H2).
  "message_reports",
  "message_requests",
  "message_thread_members",
  "message_threads",
  "message_translations",
  "moderation_reports",
  "notification_category_preferences",
  "notification_delivery_attempts",
  "notification_preferences",
  "passport_contribution_events",
  "passport_memories",
  "passport_postcards",
  "passport_stamps",
  "passport_visibility_preferences",
  "place_mismatch_reports",
  "place_top_contributors",
  "place_votes",
  "plan_attendance_events",
  "plan_checkins",
  "plan_editors",
  "plan_geofences",
  "post_edits",
  "post_hides",
  "post_impressions",
  "profile_emergency_contacts",
  "profile_privacy_settings",
  "profile_views",
  "pulse_geo_tags",
  "push_retry_queue",
  "quick_availability_status",
  "rank_events",
  "ranking_debug_samples",
  "rent_buddy_addons",
  "rent_buddy_applications",
  "rent_buddy_availability",
  "rent_buddy_beta_access",
  "rent_buddy_bookings",
  "rent_buddy_city_restrictions",
  "rent_buddy_earnings_ledger",
  "rent_buddy_emergency_contacts_snapshot",
  "rent_buddy_launch_controls",
  "rent_buddy_marketplace_analytics_events",
  "rent_buddy_match_preferences",
  "rent_buddy_match_scores",
  "rent_buddy_packages",
  "rent_buddy_payouts",
  "rent_buddy_profiles",
  "rent_buddy_requests",
  "rent_buddy_review_notes",
  "rent_buddy_safety_checkins",
  "rent_buddy_saved",
  "rent_buddy_search_events",
  "rent_buddy_support_reports",
  "rent_buddy_tips",
  "rent_buddy_training_checklist",
  "rent_buddy_user_limits",
  "rent_buddy_waitlist",
  "reports",
  "route_plan_members",
  "safe_return_events",
  "safe_return_live_shares",
  "safe_return_sessions",
  "saved_messages",
  "shared_moment_audit_events",
  "shared_moment_memberships",
  "shared_moment_suggestions",
  "shared_moments",
  "stamp_award_events",
  "stamp_milestones",
  "stamp_progress",
  "telegraph_chat_suggestions",
  "thread_reports",
  "traveler_passports",
  "trip_activity_log",
  "trip_area_preferences",
  "trip_autopilot_proposals",
  "trip_autopilot_settings",
  "trip_availability",
  "trip_checklists",
  "trip_crew_location_events",
  "trip_crew_location_preferences",
  "trip_crew_location_sessions",
  "trip_invite_link_attempts",
  "trip_invite_links",
  "trip_join_requests",
  "trip_members",
  "trip_notes",
  "trip_readiness_items",
  "trip_reminders",
  "trip_reservations",
  "trip_saved_places",
  "trip_traveler_passports",
  "trips",
  "trust_caps",
  "trust_events",
  "trust_profiles",
  "trust_restrictions",
  "trust_reviews",
  "user_availability",
  "user_hashtag_follows",
  "user_interaction_cooldowns",
  "user_location_preferences",
  "user_location_privacy",
  "user_location_state",
  "user_locations",
  "user_message_settings",
  "user_preference_events",
  "user_preference_profiles",
  "user_privacy_settings",
  "user_recent_places",
  "user_stamp_showcase",
  "user_stamps",
  "user_suggestion_seen",
  "user_trust_scores",
  "viewer_creator_fatigue",
];

/**
 * Tables created by canonical migrations AFTER the 2026-08-19 baseline. They are
 * classified above but cannot be found in the baseline yet, so the coverage check
 * must not report them as stale. They leave this list when the baseline is
 * recaptured — which is part of the apply sequence, not an afterthought.
 *
 * The journey_* family belongs here too: those tables are LIVE ON PRODUCTION
 * (verified 2026-08-22) while their migrations are still unpushed to git. They
 * are listed as backlog rather than erased because their deletion fate is the
 * Journey workstream's call, not this one's.
 */
export const POST_BASELINE_TABLES: readonly string[] = [
  // Derived memory, added by migrations 2183-2191 (post-baseline).
  "memory_projections",
  "memory_events",
  "memory_feedback",
  "intel_observations",
  "intel_claims",
  "intel_evidence",
  "intel_confirmations",
  "intel_state_snapshots",
  // I1 append-only projection history, added by migration 2273 (post-baseline).
  // Classified in RETAINED_WITH_REASON above (no actor column).
  "intel_state_snapshot_versions",
  "intel_contribution_consent",
  // IG-10 non-cash reward ledger, added by migration 2170 (post-baseline).
  "intel_reward_ledger",
  // IG mission candidates, added by migration 2167 (post-baseline). Classified
  // in ANONYMISED_FK_NULLED (accepted_by is NULLed, the row is kept).
  "intel_mission_candidates",
  // Passport / Wall owner-scoped tables (migrations 2260 / 2261 / 2271,
  // post-baseline). Classified in ERASED_BY_CASCADE above.
  "availability_windows",
  "passport_travel_dna_prefs",
  "wall_session_intents",
  "journey_observations",
  "journey_revocation_jobs",
  "journey_segment_revisions",
  "journey_shadow_cohort_assignments",
  "journey_shadow_ground_truth",
  "journey_shadow_qa_reports",
  "journey_shadow_session_issuances",
];

/** Columns that make a table user-keyed for the purposes of this manifest. */
export const USER_IDENTIFYING_COLUMNS: readonly string[] = [
  "accepted_by",
  "actor_id",
  "author_id",
  "buddy_id",
  "created_by",
  "follower_id",
  "following_id",
  "host_id",
  "member_id",
  "owner_id",
  "profile_id",
  "recipient_id",
  "reporter_id",
  "sender_id",
  "submitted_by",
  "traveler_id",
  "user_id",
  "viewer_id",
];
