-- 3740_client_grant_excess_boundary.sql
--
-- `anon` and `authenticated` stop holding privileges that no migration grants
-- and no client code path uses: on nine post-baseline tables, everything; on
-- `profiles`, the TABLE-level SELECT and UPDATE that override its column
-- grants. POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane G
-- (mission 4, grants / inverse schema audit), band 3740-3759.
--
-- Privilege-only. Creates no persistent object, drops nothing, writes no row,
-- flips no flag, adds/alters/drops no RLS policy, and leaves `service_role`
-- exactly as it is (asserted). Idempotent: REVOKE is a no-op when the privilege
-- is already absent, and the profiles column grants it re-issues are the
-- column grants the baseline already records.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- HOW IT WAS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- The scheduled inverse audit (`audit:live-unexplained`, clean-build-proof.yml)
-- has been red on every run since at least 2026-10-02. Run 37608414616
-- (2026-10-07, main 116ca4541f) reported 548 EXCESS_PRIVILEGE findings on
-- portava-ci: live client-role privileges that no GRANT in the baseline or the
-- chain explains. Replayed offline against the model, 106 of them were the
-- model failing to read grants the chain really makes (several targets in one
-- GRANT, and GRANTs issued from a FOREACH loop — fixed in the audit model in
-- the same change, not here). The other 442 are real, and are these ten tables.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PART 1 — NINE TABLES THAT INHERITED SUPABASE'S DEFAULT ACL AND KEPT IT
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase's `ALTER DEFAULT PRIVILEGES` gives `anon` and `authenticated`
-- SELECT, INSERT, UPDATE and DELETE on every table created in `public` (2490
-- removed only the four privileges RLS cannot police). A migration that creates
-- a table and does not REVOKE leaves the anonymous key holding all four. These
-- nine were created that way, and nothing since revoked them:
--
--   table                               created by   client policies (all TO authenticated)
--   highlight_resurfacing_preferences   2720         owner-only, all four verbs (2720:133-157)
--   highlight_projection_policies       2721         owner-only, all four verbs (2721:143-167)
--   highlight_sources                   2722         owner SELECT/INSERT/DELETE (2722:117-145)
--   message_edits                       2811         member SELECT only (2811:217)
--   message_reactions                   2811         member SELECT only (2811:228)
--   message_attachments                 2811         member SELECT only (2811:239)
--   conversation_action_refs            2811         member SELECT only (2811:250)
--   media_processing_attempts           2951         owner SELECT (2954), TO public
--   media_asset_lifecycle_events        2952         owner SELECT (2954), TO public
--
-- (2955 revoked INSERT/UPDATE/DELETE on the last two and deliberately left
-- SELECT, 2955:54, "for the owner SELECT policies". This file takes SELECT as
-- well, for the reason below; it is the one place it overrides an earlier
-- file's stated choice, and it says so.)
--
-- ── Why the grant matters when RLS is on ─────────────────────────────────────
-- No policy on any of the nine admits `anon`, so today the anon key reads zero
-- rows and its writes are refused. That denial rests on the ABSENCE of a
-- policy. The first permissive policy anyone adds — `FOR ALL`, or `TO public`
-- as 2954 already writes — turns the standing grant into live access for the
-- anonymous key, and nothing in review would flag it, because the grant was
-- made by CREATE TABLE and no migration names it. The same holds for the
-- `authenticated` writes on the seven tables whose policies are SELECT-only or
-- owner-only: they are one policy away from a client write path that bypasses
-- every server-side check (the Telegraph tables' own postcondition, 2811:286-
-- 290, says "writes must go through the service role"). This repository has
-- shipped RLS predicate defects to production before (42P17 recursion, a
-- tautological self-compare, a PERMISSIVE block policy that leaked every
-- message); a grant nobody needs is a bet that the next policy is right.
--
-- ── Why no caller breaks ─────────────────────────────────────────────────────
-- No client code path reaches any of the nine. Every direct table access in
-- the client trees (travel-buddy-standalone/src and /app, src/, app/,
-- packages/, posts-ui/, lib/ — tests excluded) touches only: profiles, trips,
-- user_location_privacy, trip_members, map_pins, user_locations, user_follows,
-- rent_buddy_packages, rent_buddy_fee_rules, event_rsvps, circles. No client
-- issues .rpc(); the one Realtime `postgres_changes` subscription
-- (travel-buddy-standalone/src/hooks/useVisualStatusChannel.ts:121) is on
-- generated visuals. The app reaches Highlights and Telegraph data through API
-- routes (travel-buddy-standalone/src/services/highlights.ts:555-565,
-- services/messaging.ts:921-934), and the API server's one runtime client is
-- service_role (src/lib/supabase.ts:20), which this file does not touch. No
-- view, no policy on another table, and no SQL function references any of the
-- nine (checked over the baseline and every migration). Referential actions
-- (ON DELETE CASCADE from messages, highlights, media_assets) run as the
-- table owner and need no client privilege.
--
-- After this file the policies on the nine are inert for client roles — they
-- narrow a privilege nobody holds. That is the intended end state: the day a
-- client path needs one of these tables, its migration GRANTs exactly the
-- verbs it needs, beside the policy that polices them, and says why.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PART 2 — profiles: TABLE-LEVEL SELECT AND UPDATE OVER THE COLUMN GRANTS
-- ══════════════════════════════════════════════════════════════════════════════
-- `profiles` is the one baseline table whose client ACL is COLUMN-level: the
-- 2026-08-19 production dump grants anon and authenticated SELECT on 61 of its
-- columns and UPDATE on 80 (baseline/20260819_baseline_structure.sql, the
-- `GRANT SELECT(id),UPDATE(id) ON TABLE public.profiles` block), and NO
-- table-level SELECT or UPDATE. So by design neither role can read
-- date_of_birth, full_name, expo_push_token, trust_score, safety_flags_count,
-- id_verified_at, selfie_verified_at or verification_method, and neither can
-- write `role` (2078:200-201). The two post-baseline phone columns (2142:33-34,
-- phone_e164 and phone_verified_at) were given no client grant at all.
--
-- On portava-ci, anon and authenticated hold table-level SELECT and UPDATE on
-- profiles. PostgreSQL privileges are additive and a table grant covers every
-- column, so there the anon key can read date_of_birth, phone_e164,
-- expo_push_token and full_name of every row `profiles_select` admits — every
-- non-private profile — and both roles can UPDATE every column, `role`
-- included. (The BEFORE trigger from 2078 still refuses a role change; the
-- column barrier 2078 built is simply gone underneath it, as 2078:50-54
-- predicted a single table-level GRANT would do.)
--
-- No migration grants that. It is how the database is BUILT: the baseline is a
-- pg_dump, and pg_dump writes a table's ACL as additions to the owner-only
-- default, never as a REVOKE of a client role it did not mention. Replayed
-- onto a database whose default ACL already hands anon and authenticated ALL on
-- new tables, `CREATE TABLE public.profiles` inherits ALL and the dump's column
-- GRANTs add nothing. Every non-production build from this baseline does
-- exactly that:
--   * portava-ci                 — measured (run 37608414616);
--   * the beta bootstrap         — scripts/src/beta-db-core.ts:1003-1007 sets that
--                                  default ACL before it replays the baseline;
--   * the local replay harness   — scripts/local-db/shim.sql:58, likewise.
-- Production is the source of the dump and does not have it. 3504 met the same
-- mechanism on trip_invite_link_attempts ("re-granted on portava-ci") and
-- closed it by name; profiles is the remaining table it affects (the audit's
-- grant findings name no other baseline table).
--
-- This part makes the ACL the baseline records true wherever the chain runs:
-- revoke table-level SELECT and UPDATE from both client roles (PostgreSQL also
-- revokes their column-level SELECT/UPDATE when the table-level privilege is
-- revoked), then grant the baseline's exact column lists again. Where the
-- column ACL was already the baseline's (production), the end state equals the
-- start state, and the postcondition proves it either way. INSERT and DELETE
-- (granted table-level by the baseline, policed by profiles_insert and by the
-- absence of a DELETE policy) are untouched.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER, ROLLBACK, AND WHAT IS NOT HERE
-- ══════════════════════════════════════════════════════════════════════════════
-- Needs 2720, 2721, 2722, 2811, 2951, 2952 and 2954 applied (the precondition
-- refuses otherwise); sorts after all of them. Rollback:
-- db/rollback/2026-10-07-3740-client-grant-excess-boundary-rollback.sql
-- (restores Part 1's pre-3740 grants; does not restore Part 2's table-level
-- grants, which no migration ever made).
--
-- NOT here: the Supabase default ACL itself. It still hands anon and
-- authenticated the DML four on every FUTURE table, which is how these nine got
-- them. checkClientPrivilegeBoundary.ts rule 4 (same change) now fails CI on a
-- post-baseline CREATE TABLE that no migration follows with a client-role
-- REVOKE, and the inverse audit reports the live result daily.

BEGIN;

DO $pre$
DECLARE
  v_targets constant text[] := ARRAY[
    'highlight_resurfacing_preferences', 'highlight_projection_policies',
    'highlight_sources', 'message_edits', 'message_reactions',
    'message_attachments', 'conversation_action_refs',
    'media_processing_attempts', 'media_asset_lifecycle_events'];
  v_cols constant text[] := ARRAY[
    'id', 'handle', 'name', 'avatar_url', 'home_city', 'home_country',
    'current_city', 'travel_style', 'interests', 'verified', 'open_to_meet',
    'is_private', 'bio', 'created_at', 'updated_at',
    'preferred_message_language', 'auto_translate_messages',
    'show_original_messages', 'translation_updated_at', 'show_telegraph_dm',
    'show_telegraph_trip', 'show_telegraph_circle',
    'notifications_inbox_viewed_at', 'preferred_language',
    'spoken_languages', 'default_language', 'travel_styles', 'travel_pace',
    'budget_style', 'travel_group_style', 'looking_for', 'comfort_level',
    'availability_tags', 'planning_style', 'public_social_links',
    'expo_push_token', 'verification_status', 'verified_at',
    'verification_method', 'verification_expires_at',
    'highlights_last_viewed_at', 'tag_permission', 'cover_photo_url',
    'account_status', 'role', 'display_name', 'username',
    'username_updated_at', 'date_of_birth', 'dob_verified',
    'passport_visibility', 'full_name', 'location_city', 'location_country',
    'location_verified', 'city', 'country', 'country_code', 'flag_emoji',
    'tagline', 'trust_score', 'trust_label', 'verification_level',
    'verified_since', 'id_verified_at', 'selfie_verified_at',
    'home_country_verified_at', 'safety_flags_count', 'host_verified_at',
    'buddy_verified_at', 'passport_section_order', 'passport_tab_order',
    'passport_hidden_sections', 'avatar_image_width', 'avatar_image_height',
    'cover_image_width', 'cover_image_height', 'is_official',
    'bio_original_language', 'featured_count',
    'show_profile_picture_publicly'];
  v_names text;
  v_role  text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_names
    FROM unnest(v_targets) AS t WHERE to_regclass('public.' || t) IS NULL;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 PRECONDITION FAILED: % absent from schema public. Apply 2720, 2721, 2722, 2811, 2951, 2952 and 2954 first.', v_names;
  END IF;

  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '3740 PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  -- RLS decides which ROWS a client reads; the column grants decide which
  -- columns. With RLS off the column grants would be the only boundary, which
  -- is a state nobody has described.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass) THEN
    RAISE EXCEPTION '3740 PRECONDITION FAILED: RLS is not enabled on public.profiles. Refusing.';
  END IF;
  -- Every column this file grants must exist: a GRANT naming a missing column
  -- fails, and a schema that lacks one is not the schema this was written for.
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_names
    FROM unnest(v_cols) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = 'public.profiles'::regclass
                        AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 PRECONDITION FAILED: public.profiles lacks column(s) this migration grants: %.', v_names;
  END IF;
  -- PUBLIC must hold no SELECT/UPDATE on profiles: a privilege granted to
  -- PUBLIC survives a revoke from anon and authenticated and would keep every
  -- column readable behind a postcondition that only looked at the two roles.
  SELECT string_agg(x.privilege_type, ', ') INTO v_names
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.profiles'::regclass AND x.grantee = 0
     AND x.privilege_type IN ('SELECT', 'UPDATE');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 PRECONDITION FAILED: PUBLIC holds % on public.profiles; revoking from anon and authenticated would not close it.', v_names;
  END IF;

  -- Report which state this database is in. Both are expected.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.profiles', 'SELECT')
       OR has_table_privilege(v_role, 'public.profiles', 'UPDATE') THEN
      RAISE NOTICE '3740: % holds TABLE-level SELECT/UPDATE on public.profiles (a baseline replayed over the Supabase default ACL); this file removes it.', v_role;
    ELSE
      RAISE NOTICE '3740: % holds no table-level SELECT/UPDATE on public.profiles (the production shape); the column grants are re-issued unchanged.', v_role;
    END IF;
  END LOOP;
END $pre$;

-- ── Part 1 ───────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE
  public.highlight_resurfacing_preferences,
  public.highlight_projection_policies,
  public.highlight_sources,
  public.message_edits,
  public.message_reactions,
  public.message_attachments,
  public.conversation_action_refs,
  public.media_processing_attempts,
  public.media_asset_lifecycle_events
FROM PUBLIC, anon, authenticated;

-- ── Part 2 ───────────────────────────────────────────────────────────────────
-- Revoking the table-level privilege also revokes the two roles' column-level
-- SELECT and UPDATE on every column (PostgreSQL does both), so the two GRANTs
-- below re-establish the baseline's column ACL from a clean slate.
REVOKE SELECT, UPDATE ON TABLE public.profiles FROM anon, authenticated;

GRANT SELECT (
  id, handle, name, avatar_url, home_city, home_country, current_city,
  travel_style, interests, verified, open_to_meet, is_private, bio,
  created_at, updated_at, preferred_message_language,
  auto_translate_messages, show_original_messages, translation_updated_at,
  show_telegraph_dm, show_telegraph_trip, show_telegraph_circle,
  preferred_language, spoken_languages, default_language, travel_styles,
  travel_pace, budget_style, travel_group_style, looking_for, comfort_level,
  availability_tags, planning_style, public_social_links,
  verification_status, verified_at, verification_expires_at, tag_permission,
  cover_photo_url, account_status, role, display_name, username,
  username_updated_at, passport_visibility, location_city, location_country,
  location_verified, city, country, country_code, flag_emoji, tagline,
  trust_label, verification_level, verified_since, home_country_verified_at,
  host_verified_at, buddy_verified_at, passport_section_order,
  passport_tab_order
) ON TABLE public.profiles TO anon, authenticated;

GRANT UPDATE (
  id, handle, name, avatar_url, home_city, home_country, current_city,
  travel_style, interests, verified, open_to_meet, is_private, bio,
  created_at, updated_at, preferred_message_language,
  auto_translate_messages, show_original_messages, translation_updated_at,
  show_telegraph_dm, show_telegraph_trip, show_telegraph_circle,
  notifications_inbox_viewed_at, preferred_language, spoken_languages,
  default_language, travel_styles, travel_pace, budget_style,
  travel_group_style, looking_for, comfort_level, availability_tags,
  planning_style, public_social_links, expo_push_token, verification_status,
  verified_at, verification_method, verification_expires_at,
  highlights_last_viewed_at, tag_permission, cover_photo_url, account_status,
  display_name, username, username_updated_at, date_of_birth, dob_verified,
  passport_visibility, full_name, location_city, location_country,
  location_verified, city, country, country_code, flag_emoji, tagline,
  trust_score, trust_label, verification_level, verified_since,
  id_verified_at, selfie_verified_at, home_country_verified_at,
  safety_flags_count, host_verified_at, buddy_verified_at,
  passport_section_order, passport_tab_order, passport_hidden_sections,
  avatar_image_width, avatar_image_height, cover_image_width,
  cover_image_height, is_official, bio_original_language, featured_count,
  show_profile_picture_publicly
) ON TABLE public.profiles TO anon, authenticated;

COMMIT;

-- ── Postconditions — assertion-only, re-runnable after COMMIT ────────────────
DO $post$
DECLARE
  v_targets constant text[] := ARRAY[
    'highlight_resurfacing_preferences', 'highlight_projection_policies',
    'highlight_sources', 'message_edits', 'message_reactions',
    'message_attachments', 'conversation_action_refs',
    'media_processing_attempts', 'media_asset_lifecycle_events'];
  -- The baseline's profiles column ACL for both client roles, exactly.
  v_select constant text[] := ARRAY[
    'id', 'handle', 'name', 'avatar_url', 'home_city', 'home_country',
    'current_city', 'travel_style', 'interests', 'verified', 'open_to_meet',
    'is_private', 'bio', 'created_at', 'updated_at',
    'preferred_message_language', 'auto_translate_messages',
    'show_original_messages', 'translation_updated_at', 'show_telegraph_dm',
    'show_telegraph_trip', 'show_telegraph_circle', 'preferred_language',
    'spoken_languages', 'default_language', 'travel_styles', 'travel_pace',
    'budget_style', 'travel_group_style', 'looking_for', 'comfort_level',
    'availability_tags', 'planning_style', 'public_social_links',
    'verification_status', 'verified_at', 'verification_expires_at',
    'tag_permission', 'cover_photo_url', 'account_status', 'role',
    'display_name', 'username', 'username_updated_at', 'passport_visibility',
    'location_city', 'location_country', 'location_verified', 'city',
    'country', 'country_code', 'flag_emoji', 'tagline', 'trust_label',
    'verification_level', 'verified_since', 'home_country_verified_at',
    'host_verified_at', 'buddy_verified_at', 'passport_section_order',
    'passport_tab_order'];
  v_update constant text[] := ARRAY[
    'id', 'handle', 'name', 'avatar_url', 'home_city', 'home_country',
    'current_city', 'travel_style', 'interests', 'verified', 'open_to_meet',
    'is_private', 'bio', 'created_at', 'updated_at',
    'preferred_message_language', 'auto_translate_messages',
    'show_original_messages', 'translation_updated_at', 'show_telegraph_dm',
    'show_telegraph_trip', 'show_telegraph_circle',
    'notifications_inbox_viewed_at', 'preferred_language',
    'spoken_languages', 'default_language', 'travel_styles', 'travel_pace',
    'budget_style', 'travel_group_style', 'looking_for', 'comfort_level',
    'availability_tags', 'planning_style', 'public_social_links',
    'expo_push_token', 'verification_status', 'verified_at',
    'verification_method', 'verification_expires_at',
    'highlights_last_viewed_at', 'tag_permission', 'cover_photo_url',
    'account_status', 'display_name', 'username', 'username_updated_at',
    'date_of_birth', 'dob_verified', 'passport_visibility', 'full_name',
    'location_city', 'location_country', 'location_verified', 'city',
    'country', 'country_code', 'flag_emoji', 'tagline', 'trust_score',
    'trust_label', 'verification_level', 'verified_since', 'id_verified_at',
    'selfie_verified_at', 'home_country_verified_at', 'safety_flags_count',
    'host_verified_at', 'buddy_verified_at', 'passport_section_order',
    'passport_tab_order', 'passport_hidden_sections', 'avatar_image_width',
    'avatar_image_height', 'cover_image_width', 'cover_image_height',
    'is_official', 'bio_original_language', 'featured_count',
    'show_profile_picture_publicly'];
  -- Personal or authority columns no client role may READ, named so a failure
  -- says which one leaked rather than only that two lists differ.
  v_never_read constant text[] := ARRAY[
    'date_of_birth', 'full_name', 'expo_push_token', 'phone_e164',
    'phone_verified_at', 'trust_score', 'safety_flags_count',
    'id_verified_at', 'selfie_verified_at', 'verification_method'];
  v_present int;
  v_names   text;
  v_role    text;
  v_got     text[];
  v_want    text[];
BEGIN
  -- VACUITY GUARD: a sweep over no tables proves nothing.
  SELECT count(*) INTO v_present
    FROM unnest(v_targets) AS t WHERE to_regclass('public.' || t) IS NOT NULL;
  IF v_present <> 9 THEN
    RAISE EXCEPTION '3740 POSTCONDITION VACUOUS: only % of the 9 named tables exist.', v_present;
  END IF;

  -- 1. No named table grants anon, authenticated or PUBLIC anything, at table
  --    or column level.
  SELECT string_agg(DISTINCT t, ', ') INTO v_names
    FROM unnest(v_targets) AS t
    JOIN pg_class c ON c.oid = to_regclass('public.' || t)
    CROSS JOIN LATERAL aclexplode(c.relacl) x
   WHERE x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 POSTCONDITION FAILED: a client role or PUBLIC still holds a table privilege on: %', v_names;
  END IF;
  SELECT string_agg(DISTINCT t || '.' || a.attname, ', ') INTO v_names
    FROM unnest(v_targets) AS t
    JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || t)
                       AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 POSTCONDITION FAILED: a client role or PUBLIC holds a column privilege on: %', v_names;
  END IF;

  -- 2. The server is untouched. One has_table_privilege call per privilege:
  --    the comma form is OR, not AND.
  SELECT string_agg(t || ':' || p, ', ' ORDER BY t, p) INTO v_names
    FROM unnest(v_targets) AS t
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
   WHERE NOT has_table_privilege('service_role', 'public.' || t, p);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 POSTCONDITION FAILED: service_role lost %', v_names;
  END IF;

  -- 3. profiles: no table-level SELECT or UPDATE for a client role or PUBLIC.
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END
                    || ':' || x.privilege_type, ', ') INTO v_names
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.profiles'::regclass
     AND x.privilege_type IN ('SELECT', 'UPDATE')
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3740 POSTCONDITION FAILED: table-level % on public.profiles; it overrides every column grant.', v_names;
  END IF;

  -- 4. profiles: each client role's column SELECT and UPDATE sets are the
  --    baseline's, exactly — no more (a leak) and no fewer (a broken reader).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"), ARRAY[]::text[])
      INTO v_got
      FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND x.grantee = v_role::regrole AND x.privilege_type = 'SELECT';
    SELECT array_agg(c ORDER BY c COLLATE "C") INTO v_want FROM unnest(v_select) AS c;
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '3740 POSTCONDITION FAILED: % column SELECT on public.profiles is not the baseline''s. Extra: %. Missing: %.',
        v_role,
        (SELECT string_agg(g, ', ') FROM unnest(v_got) g WHERE g <> ALL (v_want)),
        (SELECT string_agg(w, ', ') FROM unnest(v_want) w WHERE w <> ALL (v_got));
    END IF;

    SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"), ARRAY[]::text[])
      INTO v_got
      FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND x.grantee = v_role::regrole AND x.privilege_type = 'UPDATE';
    SELECT array_agg(c ORDER BY c COLLATE "C") INTO v_want FROM unnest(v_update) AS c;
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '3740 POSTCONDITION FAILED: % column UPDATE on public.profiles is not the baseline''s. Extra: %. Missing: %.',
        v_role,
        (SELECT string_agg(g, ', ') FROM unnest(v_got) g WHERE g <> ALL (v_want)),
        (SELECT string_agg(w, ', ') FROM unnest(v_want) w WHERE w <> ALL (v_got));
    END IF;

    -- 5. The named personal and authority columns, through the privilege
    --    check PostgREST itself relies on.
    -- CASE, not AND: has_column_privilege raises on a column that does not
    -- exist (phone_e164 is absent wherever 2142 has not run), and AND does
    -- not promise to evaluate the existence test first.
    SELECT string_agg(c, ', ' ORDER BY c) INTO v_names
      FROM unnest(v_never_read) AS c
     WHERE CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a
                              WHERE a.attrelid = 'public.profiles'::regclass
                                AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
                THEN has_column_privilege(v_role, 'public.profiles', c, 'SELECT')
                ELSE false END;
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION '3740 POSTCONDITION FAILED: % can read public.profiles.%', v_role, v_names;
    END IF;
    IF has_column_privilege(v_role, 'public.profiles', 'role', 'UPDATE') THEN
      RAISE EXCEPTION '3740 POSTCONDITION FAILED: % can UPDATE public.profiles.role (2078).', v_role;
    END IF;
  END LOOP;
END $post$;
