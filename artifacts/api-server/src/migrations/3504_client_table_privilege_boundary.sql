-- 3504_client_table_privilege_boundary.sql
--
-- `anon` and `authenticated` stop holding SELECT, INSERT, UPDATE and DELETE on
-- 53 named tables in schema public that no client code path reaches.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane 2490/3503.
--
-- Privilege-only. Creates no persistent object, drops nothing, writes no row,
-- flips no flag, adds/alters/drops no RLS policy, and NAMES `service_role`
-- NOWHERE except to assert it is untouched. Idempotent: REVOKE is a no-op when
-- the privilege is already absent.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS: 2490 LEFT THE DML FOUR, ON PURPOSE, FOR PER-SURFACE WORK
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase's ALTER DEFAULT PRIVILEGES hands `anon`, `authenticated` and
-- `service_role` the full set `arwdDxtm` on every table created in `public`.
-- 2490 revoked the four that row-level security does not police (TRUNCATE,
-- REFERENCES, TRIGGER, MAINTAIN), database-wide, and deliberately left the DML
-- four alone, saying so in its own header:
--
--     "The DML four are left exactly as they are, deliberately: they are the
--      ones a real client path may use under a real policy, and narrowing them
--      table-by-table is per-surface work with per-surface evidence."
--
-- This file is that per-surface work for the tables where the answer is "no
-- client path at all", and it carries the per-surface evidence table below.
-- 3503 did the same thing one object kind over (sequences) and, for one table,
-- `telegraph_report_evidence`.
--
-- ── What a zero-policy table actually is ────────────────────────────────────
-- "RLS enabled with zero policies" is deny-all because RLS refuses every row,
-- NOT because the grants are absent. The grants are all still there. So the
-- first permissive policy anyone ever adds to one of these tables exposes it to
-- client keys, with no second gate behind it. Calling such a table
-- "service-role only" is wrong, and this lane exists because that wording hid
-- the standing grant.
--
-- ── And on 11 of the 53 it is not even inert ─────────────────────────────────
-- Measured 2026-10-03 by read-only SELECTs on both hosted databases:
--
--   database                     named  present  RLS on  policies  anon holds DML
--   travel-buddy (testing)          53       52      52         0              51
--   portava-ci                      53       53      42         0              53
--
-- On `portava-ci` ELEVEN of them have RLS OFF with `anon=arwd` intact:
-- content_translations, media_dedup_groups, media_dedup_memberships,
-- place_ai_summaries, place_best_of, place_cache_invalidation_queue,
-- place_coverage_buckets, place_living_cache, place_top_contributors,
-- post_bucket_ledger, weather_cache. There nothing is policing the grant at
-- all — the anon key can read and write those tables today. The canonical chain
-- never enables RLS on them (the files that would, 2107 and 2108, sit in
-- `reconciliation-staging/` marked STAGED — NOT APPLIED), so `portava-ci` is
-- what the chain actually produces and the testing database's RLS came from an
-- out-of-band apply that was never written into the chain. This migration is
-- the half that does not depend on which of those two states a database is in.
--
-- `telegraph_outbox` (2810) is the 53rd: it does not exist on the testing
-- database yet because 2810 is pending there. 2810 creates it, enables RLS,
-- deliberately creates zero policies, and names no role anywhere, so it is born
-- in exactly this shape. Every statement below is guarded on the table
-- existing, so this file is correct whichever side of 2810 it runs on — but see
-- APPLY ORDER.
--
-- `trip_invite_link_attempts` is the mirror image and is why the list is named
-- rather than computed: its own creating migration (0110:36) revoked these
-- grants, the testing database shows them absent, and `portava-ci` shows
-- `anon=arwd` present anyway. Whatever re-granted them there, a named list
-- closes it and a computed sweep over "RLS on and zero policies" would have
-- skipped it on the database where RLS is on and missed it on the other.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY NO CALLER BREAKS — the structural argument, then the per-table evidence
-- ══════════════════════════════════════════════════════════════════════════════
-- Structurally, there are exactly two client-key Supabase clients in this repo,
-- and between them they touch twelve tables, none of which is in the list:
--   * travel-buddy-standalone/src/lib/supabase.ts:21 (EXPO_PUBLIC_SUPABASE_ANON_KEY;
--     :35 authedClient() re-creates it with a user JWT) — reaches `circles`,
--     `event_rsvps`, `message_thread_members`, `message_threads`, `profiles`,
--     `rent_buddy_fee_rules`, `rent_buddy_packages`, `trip_members`, `trips`,
--     `user_follows`, and issues no .rpc() at all;
--   * src/lib/supabase.ts:16, the legacy root app — reaches `map_pins`,
--     `profiles`, `trip_members`, `trips`, `user_location_privacy`,
--     `user_locations`.
-- The API server has ONE runtime client and it is service_role: lib/supabase.ts:20
-- is its only createClient outside tests and scripts, and requireUser
-- (lib/http.ts:293) hands routes `getServiceClient()`, using the JWT only to
-- resolve identity. requireAdmin (lib/requireAdmin.ts:147) does the same. So no
-- route depends on a client-role grant. There are no edge functions:
-- `supabase/` holds only `migrations/` and a README.
--
-- Every SECURITY DEFINER function that writes one of these tables runs as its
-- owner and is therefore unaffected either way; each one that a client could
-- call already carries REVOKE ALL ... FROM PUBLIC, anon, authenticated plus
-- GRANT EXECUTE TO service_role (0109:60, 0110:94, 0111:92, 0113:70, 2177:54,
-- 2500:808). One SECURITY INVOKER function is worth naming because the revoke
-- is what makes it safe rather than incidentally safe:
-- `increment_bucket_count()` (2048:55) is granted to anon and authenticated, so
-- an anon caller can invoke it through PostgREST; being INVOKER, its write to
-- `place_coverage_buckets` is blocked only by that role's own privilege on the
-- table. After this file the block is structural.
--
-- Two cases where the revoke depends on an invariant that is not visible from
-- either file alone, stated rather than buried:
--   * `telegraph_outbox` is written by `telegraph_outbox_from_message()`
--     (2810:300-307), an AFTER INSERT OR UPDATE trigger on public.messages that
--     is NOT SECURITY DEFINER. A client-role session writing `messages` would
--     need its own INSERT on the outbox. No client writes `messages` (zero
--     .from('messages') in travel-buddy-standalone, src/, app/, packages/,
--     posts-ui/; the app calls /api/messages/...), and the trigger returns NULL
--     unless `telegraph_message_kernel_enabled` is TRUE, which 2810:418 seeds
--     FALSE. If `messages` ever acquires a client write path, that path needs
--     INSERT on telegraph_outbox granted with its reason recorded, or the
--     trigger function needs SECURITY DEFINER.
--   * `post_impressions` has no writer anywhere in the repo
--     (CreatorActivityScoreService.ts:1065 says so independently), so its one
--     reader, routes/profile.ts:258-266, counts rows nothing inserts. The
--     revoke is correct regardless; the missing writer is a separate finding
--     for the posts/profile lane.
--
-- ── PER-TABLE EVIDENCE (53) ─────────────────────────────────────────────────
-- Each line: the table, where its service-role-only intent is recorded, and the
-- strongest code evidence that only a service-role client reaches it.
--
--  1 admin_access_log                 2035:34-36 "no SELECT policy = auditors must use the service role directly" | lib/adminAudit.ts:32
--  2 call_moderation_actions          0156:22-25 "Service-role-only audit log: RLS enabled with NO policies"      | lib/calls/callStoreAdapter.ts:388
--  3 circle_invites                   2069:22-25 "Access: service-role only ... RLS is enabled with NO policies"  | routes/requests.ts:110
--  4 comment_likes                    2070:53-58 (2070:9-15 "no permissive policies are added on purpose")        | routes/posts.ts:3262
--  5 compass_abuse_flags              0055_compass_ux:109 "Only service role reads/writes abuse flags"            | compass/CompassAbuseDefenseEngine.ts:218
--  6 compass_admin_actions            migrations/0055_compass_admin:113 "Fire-and-forget audit log"               | routes/adminCompass.ts:58
--  7 compass_admin_weight_sets        migrations/0055_compass_admin:77 "No user-facing RLS"                       | routes/adminCompass.ts:523
--  8 compass_algorithm_versions       migrations/0055_compass_admin:80 "Activation log"                           | routes/adminCompass.ts:622
--  9 compass_cache_invalidations      0054:99 "service role writes only; no direct auth-role access"              | compass/CompassCacheEngine.ts:185
-- 10 compass_content_freshness        0054:134 "Service role only ... no client reads needed"                     | no reader; verdict from the stated intent
-- 11 compass_explanation_reasons      0055_compass_ux:53 "Service role manages; no user access to sensitive flags"| compass/CompassExplanationEngine.ts:200
-- 12 compass_preload_queue            0054:63 "Service role only ... this internal queue"                         | no reader; sibling table DID get a client policy
-- 13 compass_rollbacks                migrations/0055_compass_admin:100 "Append-only audit trail"                 | routes/adminCompass.ts:762
-- 14 compass_suspension_requests      migrations/0055_compass_admin:60 "Service role manages all rows"            | compass/CompassAbuseDefenseEngine.ts:170
-- 15 compass_testing_scenarios        migrations/0055_compass_admin:130 admin cockpit sandbox                      | routes/adminCompass.ts:1060
-- 16 compass_user_navigation_patterns 0054:118 "Service role only — internal to the API server"                   | compass/CompassFrontLoadEngine.ts:698
-- 17 compass_visibility_boosts        no per-table comment in 0053; ranker-internal exposure counter              | lib/discoveryRankProvenance.ts:270
-- 18 compass_visibility_cooldowns     no per-table comment in 0053; same fair-exposure lane                       | compass/CompassFairExposureEngine.ts:218
-- 19 content_translations             created outside the chain; no policy in canonical                           | routes/contentTranslation.ts:41
-- 20 devices                          2070:21-29 "E2EE device registry ... Server-only"                           | routes/devices.ts:58
-- 21 feature_flag_audit_log           0118:20 "No public policies — all reads/writes ... service-role key"        | routes/admin.ts:730
-- 22 friend_requests                  client states it never writes this table                                    | travel-buddy-standalone/src/services/friends.ts:6
-- 23 highlight_revocation_log         2724:145-155 "No policy for authenticated at all, in any verb ... deliberate"| lib/memoryRevocationDeadLetter.ts:195
-- 24 job_health                       0017:12-16 "server-side only ... only the service role key may read/write"  | lib/storyRetentionScheduler.ts:212
-- 25 key_packages                     2070:31-33 "Anonymous writes here would enable key-substitution attacks"    | routes/keyPackages.ts:72
-- 26 media_dedup_groups               pHash cluster table, worker-written                                         | lib/media/mediaDedupWorker.ts:111
-- 27 media_dedup_memberships          worker-only; no route reads it                                              | lib/media/mediaDedupWorker.ts:149
-- 28 media_events                     2039:30-32 "service role writes only; no user-facing read policy"           | lib/mediaAnalytics.ts:189
-- 29 media_stamp_reactions            2070:95-97 "Server-only: routes/mediaFeed.ts"; client fn RETIRED            | travel-buddy-standalone/src/services/mediaInteractions.ts:130
-- 30 notification_delivery_attempts   0062:207-209 "Service-role only ... not exposed to end users"               | services/notifications/NotificationRouter.ts:591
-- 31 place_ai_summaries               24h AI-summary cache                                                        | lib/places/placeAiSummary.ts:106
-- 32 place_best_of                    worker-populated precompute                                                 | lib/places/placeCollectionsWorker.ts:519
-- 33 place_cache_invalidation_queue   background revalidation queue                                               | lib/places/placeCollectionsWorker.ts:368
-- 34 place_coverage_buckets           coverage counters; the INVOKER RPC case above                               | lib/places/bucketClassifier.ts:201
-- 35 place_living_cache               SWR payload cache served anonymously VIA THE API                            | routes/placeLiving.ts:450
-- 36 place_merge_log                  admin merge/unmerge audit                                                   | routes/placesCanonical.ts:117
-- 37 place_mismatch_reports           2070:106-108 "Must not be publicly readable (reporter IDs) or writable"     | routes/adminPlaceMismatch.ts:42
-- 38 place_top_contributors           derived contributor cache                                                   | lib/places/placeCollectionsWorker.ts:277
-- 39 post_bucket_ledger               idempotency ledger for a backfill worker                                    | lib/places/bucketClassifier.ts:188
-- 40 post_edits                       2070:70-75 "anyone could read every user's edit history with the anon key"  | routes/posts.ts:3327
-- 41 post_event_links                 server-side post-event association; no endpoint returns raw rows            | lib/mediaEventLinks.ts:139
-- 42 post_impressions                 designed writer is a server route (and is missing — see above)              | routes/profile.ts:258
-- 43 post_reactions                   2070:44-49; client uses /api/posts/:id/reactions                            | travel-buddy-standalone/src/services/postEngagement.ts:178
-- 44 post_shares                      2070:61-66; client uses POST /api/posts/:id/share                           | travel-buddy-standalone/src/services/postEngagement.ts:287
-- 45 push_retry_queue                 0062:242-246 "the retry worker runs with the service role client"           | lib/pushRetryQueue.ts:142
-- 46 ranking_config_audit_log         2061:21 "service role manages writes; no user-facing read policy"           | routes/adminRankingConfig.ts:218
-- 47 search_history                   client uses /api/me/search-history (GET/POST/DELETE)                         | travel-buddy-standalone/src/services/discovery.ts:1218
-- 48 stamp_milestones                 2070:74-76 "Written by StampAwardEngine, read by ... all service-role"      | travel-buddy-standalone/src/components/StampsTab.tsx:265
-- 49 story_purge_queue                2998:169 RLS on, zero policies; pass refuses a non-service client           | services/stories/storyRetention.ts:225
-- 50 telegraph_outbox                 2810:231-238 zero policies by design; "NOTHING DRAINS IT YET"               | no .from()/rpc() anywhere; absent from both database.types.ts
-- 51 trip_invite_link_attempts        0110:36-37 already revoked there; re-granted on portava-ci                   | routes/trips-expansion.ts:1756
-- 52 user_suggestion_seen             migrations/0050:4,16-17 "Service role only — no user-facing RLS policies"    | lib/suggestionSeenCache.ts:95
-- 53 weather_cache                    Open-Meteo response cache keyed by destination; no per-user rows            | lib/weatherCache.ts:63
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT IN THE LIST, AND WHY — ten tables
-- ══════════════════════════════════════════════════════════════════════════════
-- Each is in the same shape. None is omitted by oversight.
--
-- OWNED BY ANOTHER LANE THAT HAS ALREADY SHIPPED THE FIX. Re-revoking here
-- would duplicate it, and granting service_role back (as a "never narrow the
-- server" reflex suggests) would CONTRADICT their exact-match postconditions,
-- leaving whichever ran last the winner:
--   * memory_events, memory_feedback, memory_policy, memory_projections —
--     2333:204-223 revokes the client roles AND narrows service_role on
--     purpose (memory_events loses UPDATE, which an unconditional BEFORE UPDATE
--     RAISE trigger already makes impossible; memory_policy keeps SELECT only,
--     its sole writer being 2192's migration-time seed running as postgres).
--     Applied to portava-ci 2026-09-09; NOT applied to the testing database,
--     and it cannot be replayed there until 2224 lands, because 2333:179-198
--     requires `route_flow_contribution_consent`, which is absent. The fix for
--     these four is to unblock and apply 2333, not to re-derive it.
--   * portava_featured — 2332:288-292, and ONLY 2332. portava-ci shows
--     `service_role=arwd` and no client grant, so it landed there. The testing
--     database still shows `anon=arwd` AND carries a ledger row for 2160 with
--     applied_by='backfill' — which 2254 says asserts only that the filename
--     existed, never that the file ran. The object state is the evidence, and
--     it says neither file applied there.
--     CORRECTED 2026-10-03: the remedy is 2332 ALONE, not "2160 then 2332".
--     2160 ends with anon and authenticated holding SELECT; 2332 ends with them
--     holding nothing, and 2160 run AFTER 2332 would re-grant exactly what 2332
--     revoked while its own postcondition still reported PASSED. 2160 is
--     SUPERSEDED: do not apply it, and never after 2332. Neither database can
--     reach it through the applier — both carry a ledger row for it — so only a
--     hand-apply could, which is the case this note exists to stop.
--
--     A DEFECT IN 2332'S RECORDED ROLLBACK, carried here because 2332's BYTES
--     CANNOT BE TOUCHED. 2332:208-211 (production) and :218-220 (portava-ci)
--     record the rollback as `GRANT ALL ON TABLE <t> TO anon, authenticated,
--     service_role`, described at :198 as "the exact prior grant set".
--     It is not. The CI block's own portava_featured lines, :221-222, are
--     already in the faithful shape; it is the three money tables there, and
--     all four in the production block, that over-grant.
--     Measured read-only 2026-10-03, every one of the four on travel-buddy
--     holds `anon=arwd, authenticated=arwd, service_role=arwdDxtm`: the client
--     roles hold the four DML verbs and NOT TRUNCATE, REFERENCES, TRIGGER or
--     MAINTAIN, because 2490 took those from them database-wide. So running
--     that block as written would hand four privileges back on money tables and
--     silently undo part of 2490. It would also fail this repository's own
--     ratchet: the shape is the fixture `checkClientPrivilegeBoundary` rejects,
--     asserted in test/clientPrivilegeBoundary.test.ts under "FAILS on GRANT
--     ALL to a client role". A rollback nobody could commit as a migration is
--     not a rollback.
--
--     THE FAITHFUL FORM, for whoever ever needs it:
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rent_buddy_earnings_ledger TO anon, authenticated;
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rent_buddy_payouts         TO anon, authenticated;
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rent_buddy_tips            TO anon, authenticated;
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.portava_featured           TO anon, authenticated;
--       GRANT ALL ON TABLE <each of the four> TO service_role;
--     On portava-ci, portava_featured takes `GRANT SELECT` for the client roles
--     instead, because 2160 had already reduced them to that there.
--
--     WHY THIS NOTE IS HERE AND NOT IN 2332. 2332 IS APPLIED on portava-ci —
--     all four tables show `service_role=arwd` with no client grant, ledger row
--     applied_by='ci' 2026-09-09 — and its ledger checksum there is a real
--     sha256 of the file's bytes, `bbbbbd055c26…`. check:migration-ledger
--     hashes each file on disk and compares (scripts/lib/migrationLedgerCore.ts
--     :148-164), so a COMMENT-ONLY edit to 2332 is still a byte change and
--     would fail that gate against a database where the file really ran. I made
--     that edit, measured the mismatch, and reverted it: the restored file
--     hashes to `bbbbbd055c26…` again, exactly the stored row. Same precedent
--     as checkProductionDrift.ts's 2950 entry, which declined to edit an
--     applied file for this reason and recorded the correction in a note.
--     2160's SUPERSEDED warning is NOT written into 2160 either (integration,
--     2026-10-04). Its ledger rows hold the literal 'backfill', so no checksum
--     pins it today, but docs/migrations.md freezes every applied file's bytes
--     and 2160 ran on portava-ci. The warning is here and in that document.
--
--     FOR WHOEVER PREPARES 2332'S PRODUCTION APPLY — a window that closes, and
--     what it actually costs. Today only portava-ci pins 2332's bytes;
--     production has NO ledger row for it (read 2026-10-03). The applier writes
--     the row inside the migration's own transaction, hashing whatever the file
--     holds at that moment, so once 2332 applies to production BOTH databases
--     pin it and the recorded rollback is frozen as written. Fixing the block in
--     the same change that applies 2332 is therefore the last cheap moment for
--     the production half.
--
--     IT IS NOT FREE FOR THE CI HALF, AND IT IS WORSE THAN A FAILED CHECK.
--     Measured by reading the applier rather than assumed: for a file whose
--     ledger row proves an apply, it hashes the bytes on disk and compares
--     (scripts/src/apply-migrations.ts:932-947). Equal → `skipped`. NOT equal →
--     `drifted`, and drift is not a skip: the applier prints "the SQL that ran
--     and the SQL in this commit are not the same text ... Reconcile by hand"
--     and calls process.exit(1) (:1345-1366). The schema-drift job runs that
--     applier against portava-ci on every live-DB run, so an edited 2332 would
--     not merely fail check:migration-ledger — it would block EVERY apply run
--     on the shared CI database, for every lane, until someone UPDATEd that row
--     by hand. Nothing in this tree does that, and a hand-written ledger UPDATE
--     on a shared database is an owner's call, not a PR's. The applier's own
--     note adds the reason to be slow about it: a backfill that used a different
--     digest looks exactly like a real edit.
--
--     So the three options, stated rather than implied: (a) leave 2332's bytes
--     alone and keep this note as the record, which is where it stands; (b) fix
--     the block in the applying change AND hand-update portava-ci's row in the
--     same operation, which closes it everywhere at the cost of one manual write
--     to a shared database; (c) fix it in a later migration-numbered successor
--     that supersedes the rollback the way 2332 supersedes 2160, which needs no
--     manual write at all. This lane's recommendation is (c) if the block is ever
--     worth changing in place, because it is the only one that leaves every
--     checksum reconcilable by the tooling that exists. (a) and (c) are both
--     safe today; (b) is the one that stops the project's CI until a human
--     finishes it, so it should not be bundled into an apply under time
--     pressure, which is exactly when it would be proposed.
--
-- A LIVE CLIENT PATH, so the revoke is not safe to assert:
--   * generated_visuals — travel-buddy-standalone/src/hooks/useVisualStatusChannel.ts:125
--     subscribes the ANON-KEY client to Supabase Realtime `postgres_changes` on
--     this table and reads `status`, `source_image_url`, `hero_path` off the row
--     payload. It is wired (GeneratedHeaderPicker.tsx:136, app/event/[id].tsx:260),
--     and Realtime applies RLS per subscriber, so with zero policies it
--     delivers nothing today: either the AI-header status feature is silently
--     dead in production or 0194:64-67's deny-all intent is wrong. That is a
--     product decision. INSERT/UPDATE/DELETE would be safe to revoke; SELECT is
--     the one that would foreclose the feature permanently, so the table is
--     held out whole rather than half-done.
--
-- AN OPEN OWNER DECISION, where a revoke would quietly settle it:
--   * rent_buddy_review_notes — 0160:39 claims "service-role/admin access
--     only", but lib/d6Classifications.ts:209-228 records the premise as false
--     and the question as STILL OPEN: the sole writer, routes/rentABuddy.ts:2581,
--     is guarded by requireUser (not an admin check) and inserts
--     author_id = auth.user.id with the note taken from a `privateNote` body
--     field. If that is a traveller's own content it will need an owner SELECT
--     policy and an `authenticated` SELECT grant.
--   * user_recent_places — db/migrations/0027:21-29 creates three owner-scoped
--     policies, and reconciliation-staging/2112 records 0027's content as
--     applied to production, yet both databases show ZERO policies and no
--     DROP POLICY for them exists anywhere in the repo. Partial apply and an
--     out-of-band drop are different facts with different consequences, and
--     nothing readable distinguishes them.
--
-- NO RECORDED INTENT AT ALL — the repo's own "unexplained live" Class E
-- (docs/RECONCILIATION-PACKET.md:362):
--   * compass_analytics — no creating migration anywhere; zero code references;
--     its (user_id, onboarding_completed, ...) shape duplicates columns 0107
--     added to `compass_settings`, so dead-vs-awaiting-a-policy is undecidable.
--   * user_trust_scores — no creating migration; its one code reference was
--     deliberately removed with a comment asserting the table does not exist
--     (portava-fixes.patch:709-712), yet it is live and
--     docs/algorithm/signal-audit.md:113 still lists it as partly wired.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE HALF THIS MIGRATION CANNOT REACH — STATED, NOT HIDDEN
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. THE DEFAULT ACL FOR TABLES. Measured 2026-10-03, identical on both
--    databases, `pg_default_acl` for relations in public carries two grantor
--    rows: `postgres` issuing `anon=arwd, authenticated=arwd`, and
--    `supabase_admin` issuing the wider `anon=arwdDxtm, authenticated=arwdDxtm`.
--    So the NEXT table a migration creates is born in exactly this shape again,
--    and this file does not change that. It deliberately does not:
--      * the supabase_admin half is unreachable from a migration at all
--        (ALTER DEFAULT PRIVILEGES may only be issued FOR ROLE a role the
--        current role is a member of; postgres is not a member of
--        supabase_admin — 2490 and 3503 both measured this);
--      * the postgres half IS reachable, but revoking DML there flips the whole
--        tree to deny-by-default for every future table, so that every table
--        that genuinely wants client access must grant it explicitly. That is
--        very likely the right end state and it is a change of convention for
--        every lane, not a privilege fix for 53 tables. It needs the owner's
--        decision and its own migration. 3503 did alter the SEQUENCE default,
--        which is a narrower claim: no client path draws from a sequence at all.
--    Consequence to plan for: a new table in this shape re-opens the gap, and
--    re-running this file does not cover it because the list is named. The
--    static guard that catches that is checkClientPrivilegeBoundary.ts.
-- 2. WHETHER A DATABASE EVER RAN THIS. The ledger says that, not this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Every statement is guarded on the table existing, so this file is safe in any
-- order and on any database. But a table that is absent when it runs is a table
-- it does not reach: on the testing database it MUST run AFTER 2810, or
-- `telegraph_outbox` is created afterwards and inherits the default ACL with
-- nothing to take it away. For the story-retention/unsend rollout that means
-- after `2_apply_2810.sql`. Re-running this file (it is idempotent) closes it
-- again if the order slips, and the postcondition reports which of the named
-- tables were present, so a run that missed one is visible rather than silent.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- None, as with 2490 and 3503: restoring the previous state re-grants a
-- capability no code path uses. If one of these tables ever genuinely needs
-- client access, GRANT the specific privilege on THAT table to THAT role, with
-- the reason recorded, in its own migration alongside the policy that scopes it.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── the named targets, read by the three blocks below (and repeated, checked, in $post$) ─
CREATE TEMP TABLE IF NOT EXISTS _p3504_targets (rel text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO _p3504_targets (rel) VALUES
  ('admin_access_log'),
  ('call_moderation_actions'),
  ('circle_invites'),
  ('comment_likes'),
  ('compass_abuse_flags'),
  ('compass_admin_actions'),
  ('compass_admin_weight_sets'),
  ('compass_algorithm_versions'),
  ('compass_cache_invalidations'),
  ('compass_content_freshness'),
  ('compass_explanation_reasons'),
  ('compass_preload_queue'),
  ('compass_rollbacks'),
  ('compass_suspension_requests'),
  ('compass_testing_scenarios'),
  ('compass_user_navigation_patterns'),
  ('compass_visibility_boosts'),
  ('compass_visibility_cooldowns'),
  ('content_translations'),
  ('devices'),
  ('feature_flag_audit_log'),
  ('friend_requests'),
  ('highlight_revocation_log'),
  ('job_health'),
  ('key_packages'),
  ('media_dedup_groups'),
  ('media_dedup_memberships'),
  ('media_events'),
  ('media_stamp_reactions'),
  ('notification_delivery_attempts'),
  ('place_ai_summaries'),
  ('place_best_of'),
  ('place_cache_invalidation_queue'),
  ('place_coverage_buckets'),
  ('place_living_cache'),
  ('place_merge_log'),
  ('place_mismatch_reports'),
  ('place_top_contributors'),
  ('post_bucket_ledger'),
  ('post_edits'),
  ('post_event_links'),
  ('post_impressions'),
  ('post_reactions'),
  ('post_shares'),
  ('push_retry_queue'),
  ('ranking_config_audit_log'),
  ('search_history'),
  ('stamp_milestones'),
  ('story_purge_queue'),
  ('telegraph_outbox'),
  ('trip_invite_link_attempts'),
  ('user_suggestion_seen'),
  ('weather_cache')
ON CONFLICT (rel) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRECONDITION — a target that has acquired a permissive policy is not mine
-- ═══════════════════════════════════════════════════════════════════════════
-- The whole argument above is that these tables have no client surface. A
-- PERMISSIVE policy is a client surface: whoever added it meant a client role to
-- reach rows, and this file would silently take the privilege that makes that
-- work. Refuse instead, loudly, naming the table — the remedy is to drop it
-- from the list in a follow-up migration with the reason recorded. A RESTRICTIVE
-- policy only ever narrows, so it is not a surface and is not counted.
--
-- Tagged $pre$ (integration, 2026-10-04): it reads _p3504_targets, which is
-- gone after COMMIT, so certify:migrations stage 4 must not re-run it. The
-- applier runs it here, in this transaction, which is the only place a
-- precondition means anything; the $post$ block re-asserts the same fact (3).
DO $pre$
DECLARE
  v_names text;
BEGIN
  SELECT string_agg(t.rel, ', ' ORDER BY t.rel) INTO v_names
    FROM _p3504_targets t
   WHERE to_regclass('public.' || t.rel) IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_policy p
                  WHERE p.polrelid = to_regclass('public.' || t.rel)
                    AND p.polpermissive);

  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION
      '3504 PRECONDITION FAILED: % now carries a permissive RLS policy, so a client role is meant to reach its rows. Revoking the privilege behind it would break that surface. Drop the table from this migration''s list in a follow-up, with the reason recorded.',
      v_names;
  END IF;
END $pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE REVOKE — client roles and PUBLIC only; service_role is never named
-- ═══════════════════════════════════════════════════════════════════════════
-- REVOKE ALL rather than naming the four verbs: it subsumes what 2490 already
-- took (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) without naming MAINTAIN, which
-- PostgreSQL 16 cannot parse and which is why 2490 itself cannot replay on the
-- local harness. PUBLIC is named because a grant to PUBLIC reaches both client
-- roles and `has_table_privilege` does not show it as either of them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t.rel FROM _p3504_targets t
            WHERE to_regclass('public.' || t.rel) IS NOT NULL
            ORDER BY t.rel
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, PUBLIC', r.rel);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — this migration fails loudly rather than silently no-opping
-- ═══════════════════════════════════════════════════════════════════════════
-- RE-RUNNABLE AFTER COMMIT (integration, 2026-10-04). certify:migrations stage 4
-- re-runs every assertion block that is not $pre$ against the COMMITTED
-- database, and _p3504_targets is `ON COMMIT DROP`. As #566 wrote it this block
-- read that table, so on `main` the first run after the merge would have
-- applied 3504 correctly and then failed its certification with
--     ERROR: relation "_p3504_targets" does not exist
-- (measured on a local PostgreSQL 16 with the repository's own stage-4 split).
-- That is 3390's defect, F4 in docs/ops/discovery-portava-ci-apply-plan.md
-- §5.3, and this is 3390's repair: the block carries the list as a literal and
-- reads only the catalogue.
--   * In the APPLYING transaction the temp table still exists, and it is what
--     the REVOKE above walked, so it is what is asserted about — and the
--     literal must name exactly the same tables, or the block raises. Two
--     lists that can drift apart would let a table be revoked and never
--     verified after commit, or verified and never revoked.
--   * AFTER COMMIT the temp table is gone and the literal stands in for it.
-- An EMPTY temp table is not compared with the literal: it is reported by the
-- vacuity guard below, which is the more useful message for a sweep over
-- nothing.
DO $post$
DECLARE
  v_literal constant text[] := ARRAY[
    'admin_access_log',
    'call_moderation_actions',
    'circle_invites',
    'comment_likes',
    'compass_abuse_flags',
    'compass_admin_actions',
    'compass_admin_weight_sets',
    'compass_algorithm_versions',
    'compass_cache_invalidations',
    'compass_content_freshness',
    'compass_explanation_reasons',
    'compass_preload_queue',
    'compass_rollbacks',
    'compass_suspension_requests',
    'compass_testing_scenarios',
    'compass_user_navigation_patterns',
    'compass_visibility_boosts',
    'compass_visibility_cooldowns',
    'content_translations',
    'devices',
    'feature_flag_audit_log',
    'friend_requests',
    'highlight_revocation_log',
    'job_health',
    'key_packages',
    'media_dedup_groups',
    'media_dedup_memberships',
    'media_events',
    'media_stamp_reactions',
    'notification_delivery_attempts',
    'place_ai_summaries',
    'place_best_of',
    'place_cache_invalidation_queue',
    'place_coverage_buckets',
    'place_living_cache',
    'place_merge_log',
    'place_mismatch_reports',
    'place_top_contributors',
    'post_bucket_ledger',
    'post_edits',
    'post_event_links',
    'post_impressions',
    'post_reactions',
    'post_shares',
    'push_retry_queue',
    'ranking_config_audit_log',
    'search_history',
    'stamp_milestones',
    'story_purge_queue',
    'telegraph_outbox',
    'trip_invite_link_attempts',
    'user_suggestion_seen',
    'weather_cache'
  ];
  v_targets  text[];
  v_named    int;
  v_present  int;
  v_absent   text;
  v_offending int;
  v_names    text;
  v_svc      text;
BEGIN
  IF to_regclass('pg_temp._p3504_targets') IS NOT NULL THEN
    SELECT coalesce(array_agg(t.rel ORDER BY t.rel), ARRAY[]::text[]) INTO v_targets FROM _p3504_targets t;
    IF cardinality(v_targets) > 0 THEN
      SELECT string_agg(d.rel, ', ' ORDER BY d.rel) INTO v_names
        FROM (
          (SELECT unnest(v_targets) AS rel EXCEPT SELECT unnest(v_literal))
          UNION ALL
          (SELECT unnest(v_literal) AS rel EXCEPT SELECT unnest(v_targets))
        ) d;
      IF v_names IS NOT NULL THEN
        RAISE EXCEPTION
          '3504 postcondition FAILED: the list this block carries for its re-run after COMMIT is not the list the sweep above walked. Named in one and not the other: %. Edit both together.',
          v_names;
      END IF;
    END IF;
  ELSE
    v_targets := v_literal;
  END IF;

  v_named := cardinality(v_targets);

  SELECT count(*) FILTER (WHERE to_regclass('public.' || t.rel) IS NOT NULL),
         string_agg(t.rel, ', ' ORDER BY t.rel) FILTER (WHERE to_regclass('public.' || t.rel) IS NULL)
    INTO v_present, v_absent
    FROM unnest(v_targets) AS t(rel);

  -- VACUITY GUARD. Measured 2026-10-03: 52 of these 53 exist on the testing
  -- database (telegraph_outbox pending) and all 53 on portava-ci. A run that
  -- finds fewer than 45 is not a Portava database, and a sweep over nothing
  -- must not report success. This is the lesson of 2190, whose anon-grant
  -- postcondition passed by matching nothing.
  IF v_present < 45 THEN
    RAISE EXCEPTION
      '3504 postcondition VACUOUS: only % of % named tables exist in schema public; expected 45+ (testing 52, portava-ci 53). Absent: %.',
      v_present, v_named, coalesce(v_absent, '(none)');
  END IF;

  -- 1. No present target grants anything to anon, authenticated or PUBLIC.
  SELECT count(*), string_agg(rel, ', ' ORDER BY rel) INTO v_offending, v_names
    FROM (
      SELECT DISTINCT t.rel
        FROM unnest(v_targets) AS t(rel)
        JOIN pg_class c ON c.oid = to_regclass('public.' || t.rel)
        CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated')
    ) s;

  IF v_offending > 0 THEN
    RAISE EXCEPTION
      '3504 postcondition FAILED: % table(s) still grant a privilege to anon, authenticated or PUBLIC: %',
      v_offending, v_names;
  END IF;

  -- 2. The server is untouched: service_role keeps all four DML privileges on
  --    every present target. This migration must never narrow the server, and
  --    every writer identified in the header is service_role.
  --    One privilege per call, ANDed. `has_table_privilege(role, oid, 'a,b')`
  --    is TRUE when the role holds EITHER, not both, so the comma form here
  --    would have passed over a service_role that had lost three of the four.
  --    The database test's mutation case found that in this very block.
  SELECT string_agg(t.rel, ', ' ORDER BY t.rel) INTO v_svc
    FROM unnest(v_targets) AS t(rel)
   WHERE to_regclass('public.' || t.rel) IS NOT NULL
     AND NOT (has_table_privilege('service_role', to_regclass('public.' || t.rel), 'SELECT')
          AND has_table_privilege('service_role', to_regclass('public.' || t.rel), 'INSERT')
          AND has_table_privilege('service_role', to_regclass('public.' || t.rel), 'UPDATE')
          AND has_table_privilege('service_role', to_regclass('public.' || t.rel), 'DELETE'));

  IF v_svc IS NOT NULL THEN
    RAISE EXCEPTION
      '3504 postcondition FAILED: service_role lacks one of SELECT/INSERT/UPDATE/DELETE on: % (this migration must never narrow the server).',
      v_svc;
  END IF;

  -- 3. No present target acquired a permissive policy while this ran.
  SELECT string_agg(t.rel, ', ' ORDER BY t.rel) INTO v_names
    FROM unnest(v_targets) AS t(rel)
   WHERE to_regclass('public.' || t.rel) IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_policy p
                  WHERE p.polrelid = to_regclass('public.' || t.rel) AND p.polpermissive);

  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION
      '3504 postcondition FAILED: % carries a permissive RLS policy whose client surface this migration just revoked the privilege behind.',
      v_names;
  END IF;

  RAISE NOTICE '3504 OK: % of % named tables present and revoked, none grants anon/authenticated/PUBLIC anything, service_role intact on all of them. Not present (unreached by this run): %. Residual (see header): the postgres and supabase_admin default ACLs still issue client DML on every NEW table in public.',
    v_present, v_named, coalesce(v_absent, '(none)');
END $post$;

COMMIT;
