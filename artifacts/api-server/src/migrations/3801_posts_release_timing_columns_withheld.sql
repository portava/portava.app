-- 3801_posts_release_timing_columns_withheld.sql
-- posts: no client role may read WHEN a post was released. updated_at and
-- publish_at join the columns 3362 already withholds (census-media §50.16,
-- verifier M3 finding N2b).
--
-- certify:supersedes-postconditions 2148_posts_write_boundary.sql
-- certify:supersedes-postconditions 3362_posts_client_column_grants.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane M band 3800-3819). APPLIED TO
-- NO DATABASE by the lane that wrote it. It narrows what the public anon key
-- and a signed-in client key can read from a live table, so it needs the
-- owner's production approval and is sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (verifier M3, N2b; confirmed in production by the lead's read-only
-- catalog read, 2026-10-08)
-- ══════════════════════════════════════════════════════════════════════════════
-- trg_posts_updated (set_updated_at) stamps updated_at on EVERY update. On a
-- "Publish after I leave" post (location_privacy_mode = 'delayed_until_exit')
-- the geofence-exit UPDATE (routes/location.ts) stamps the instant the author
-- left the place, and the delayed-publish worker's release UPDATE
-- (lib/delayedPostPublisher.ts publishPost) the release instant minutes later.
-- The API tells a non-author the creation instant instead (updatedAtForViewer,
-- census-media §50.14). But 3362 GRANTs SELECT (updated_at) to anon and
-- authenticated, and posts_select_policy admits every active public row to any
-- signed-in user, so
--     GET /rest/v1/posts?id=eq.<id>&select=updated_at
-- with the shipped anon key and the caller's own JWT returns the real instant.
-- A filter needs no select list: `?updated_at=gt.<t>` is a range oracle on it.
--
-- publish_at (20260812_posts_publish_at.sql: "Scheduled publish time for
-- delayed posts") is release timing by definition. Nothing in the tree writes
-- it today, and the only SQL that reads it is SECURITY DEFINER
-- (validate_live_place_recap_evidence), so it goes too: a writer added later
-- must not reopen the door. The other release-timing columns (published_at,
-- publish_eligible_at, publish_after_exit, publish_after_time,
-- exited_geofence_at, post_status) are already withheld by 3362 and stay so.
--
-- PRODUCTION IS NOT IN 3362's STATE. The lead's read-only catalog read on
-- 2026-10-08 found anon and authenticated holding TABLE-level SELECT on posts
-- there: 2148's state, in which every column — published_at, the GPS columns,
-- all of them — is readable. 0 delayed posts existed in production that day.
-- So this file accepts exactly one of two starting states, and leaves one end
-- state from either:
--   S1  3362's end state: no table-level client privilege; anon and
--       authenticated hold column SELECT on exactly 3362's 40 columns.
--   S2  2148's state: anon and authenticated hold a plain table-level SELECT
--       and no column privilege.
-- Anything else (PUBLIC holding a privilege, a grant option, a write
-- privilege, one role without the other, a column grant 3362 never made)
-- refuses the apply: it is a state nobody wrote down.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHO READS posts AS A CLIENT ROLE (re-verified 2026-10-08)
-- ══════════════════════════════════════════════════════════════════════════════
-- * No client code. travel-buddy-standalone has twelve files that call
--   supabase `.from(...)`; none names posts, no select embeds a posts
--   resource, and its one realtime subscription is on generated_visuals.
-- * The API reads posts only as service_role (lib/supabase.ts). This file does
--   not touch service_role.
-- * In the database: post_media's policies subquery posts AS THE INVOKING ROLE
--   on id, author_id, status, visibility and trip_id; posts' own policies read
--   the same columns (can_see_post is SECURITY DEFINER). The three functions
--   that read posts — can_see_post, can_see_postcard and
--   validate_live_place_recap_evidence — are SECURITY DEFINER. No view reads
--   posts, and posts is in no publication.
-- So no reader loses a column it uses.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOKE SELECT ON TABLE posts FROM anon, authenticated and PUBLIC. A table
-- REVOKE also takes away every column privilege of that kind the roles hold,
-- so from S1 and from S2 alike nothing is left. Then GRANT SELECT on 3362's
-- column list minus updated_at and publish_at: 38 columns, plus tombstoned_at
-- where 2141 created it. A column added to posts later is readable by no
-- client role until a migration grants it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- certify:migrations, and the marker line at the top
-- ══════════════════════════════════════════════════════════════════════════════
-- 3362's postcondition pins its 40 columns as client-readable ("a client role
-- lost a column it must keep"). certify:migrations stage 4 re-runs it whenever
-- 3362 is in a run's scope — on every full-chain build (the beta bootstrap
-- applies the whole chain in one run) — so after this file it would fail by
-- construction, exactly as 2955's did against 3740 (lead ruling G-2,
-- withdrawn). The marker line declares that this file supersedes it: while
-- 3801 is recorded applied, stage 4 holds 3362's postcondition back, names it
-- in its report, and re-runs THIS file's postcondition in its place. That
-- block asserts everything 3362's did — the never-readable columns, the exact
-- granted set (nothing more, nothing less), no table-level privilege, no
-- column privilege but SELECT, service_role reads every column — with the
-- narrower set, plus the release-timing columns. Nothing 3362 asserted goes
-- unasserted. (lib/migrationSqlBlocks.ts planPostconditionRerun.)
-- 2148's postcondition ("anon holds SELECT only", table-level) is superseded
-- too: it has failed every full-chain re-run since 3362 removed that SELECT,
-- and 3801 removes it itself where 3362 never ran (production). Its other
-- assertions — RLS on, a SELECT policy present, the two verification columns
-- present, no client column INSERT/UPDATE — are re-asserted below.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES NOT CHANGE
-- ══════════════════════════════════════════════════════════════════════════════
-- No policy, no row, no function, no trigger, no service_role privilege, no
-- write privilege. Every row a client role could read before, it can read
-- now; only the columns narrow.
--
-- Rollback: db/rollback/2026-10-08-3801-posts-release-timing-columns-withheld-rollback.sql
-- (re-grants SELECT (updated_at, publish_at): 3362's end state, and with it N2b).
-- Proof: src/test/db/postsReleaseTimingColumns.db.test.ts (live-DB tier) and
-- src/test/postsReleaseTimingColumnGrants.test.ts (static).

BEGIN;

DO $pre$
DECLARE
  -- 3362's granted list minus the two release-timing columns.
  v_granted  constant text[] := ARRAY[
    'id','author_id','trip_id','content','media_urls','visibility','status',
    'created_by','updated_by','source','created_at','deleted_at',
    'media_type','add_to_passport','like_count','comment_count','share_count',
    'comments_setting','likes_hidden','sharing_disabled','reposting_disabled',
    'category','save_count','media_thumbnail_url','primary_media_type',
    'media_count','has_video','filter_id','filter_intensity',
    'media_duration_seconds','post_buckets','bucket_classified',
    'original_language','geo_restriction',
    'age_restriction_enabled','age_min','age_max','tombstoned_at'];
  -- What this file takes away.
  v_release  constant text[] := ARRAY['updated_at','publish_at'];
  -- What 3362 already withholds.
  v_withheld constant text[] := ARRAY[
    'user_gps_lat','user_gps_lng','original_lat','original_lng','geog',
    'location_distance_meters','exited_geofence_at','delayed_location_reason',
    'location_name','location_place_id','location_lat','location_lng',
    'public_lat','public_lng','public_location_label','venue_id','venue_name',
    'canonical_location_id','canonical_place_id','perspective_vantage',
    'location_city','location_country',
    'location_privacy_mode','location_sensitivity_level','post_status',
    'geofence_radius_meters','publish_after_exit','publish_after_time',
    'publish_eligible_at','published_at',
    'location_source','location_verified','location_verified_at',
    'geotag_verified','geotag_credit_awarded'];
  v_optional constant text[] := ARRAY['tombstoned_at','perspective_vantage'];
  v_cols     text[];
  v_missing  text;
  v_unknown  text;
  v_bad      text;
  v_tables   int;
  v_s1_want  text;
  v_s1_have  text;
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): public.posts does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.posts'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): RLS is not enabled on posts; column grants would then be the only boundary. Refusing.';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped;

  -- Every column this file names (the optional two aside) exists ...
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(v_granted || v_release || v_withheld) c
   WHERE c <> ALL (v_optional) AND c <> ALL (v_cols);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): posts lacks column(s) this migration classifies: %. The schema is not the one this was written against.', v_missing;
  END IF;
  -- ... and every column that exists is classified: an unclassified one may be
  -- a location or a timing. Refuse rather than guess its side.
  SELECT string_agg(c, ', ') INTO v_unknown
    FROM unnest(v_cols) c
   WHERE c <> ALL (v_granted || v_release || v_withheld);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): posts has column(s) this migration does not classify: %. Classify them in 3801 before applying.', v_unknown;
  END IF;

  -- TABLE level: PUBLIC holds nothing, and anon/authenticated hold nothing but
  -- a plain SELECT (S2) — or nothing at all (S1).
  SELECT string_agg(format('%s:%s%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                           a.privilege_type, CASE WHEN a.is_grantable THEN '+grant' ELSE '' END), ', ')
    INTO v_bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.posts'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND NOT (a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
              AND a.privilege_type = 'SELECT' AND NOT a.is_grantable);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): client-role or PUBLIC table privileges on posts are neither 2148''s plain SELECT nor 3362''s none: %.', v_bad;
  END IF;
  SELECT count(DISTINCT a.grantee) INTO v_tables
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.posts'::regclass AND a.privilege_type = 'SELECT'
     AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole);

  -- Every client privilege on posts, table- or column-level, was granted by
  -- the table's owner, and this session acts for the owner: a REVOKE removes
  -- only what its own grantor granted, so a privilege from another grantor
  -- would survive the REVOKE below and leave the state half-changed.
  SELECT string_agg(DISTINCT x.grantor::regrole::text, ', ') INTO v_bad
    FROM (SELECT a.grantor, a.grantee FROM pg_class c, LATERAL aclexplode(c.relacl) a
           WHERE c.oid = 'public.posts'::regclass
          UNION ALL
          SELECT x.grantor, x.grantee FROM pg_attribute t, LATERAL aclexplode(t.attacl) x
           WHERE t.attrelid = 'public.posts'::regclass AND t.attnum > 0 AND NOT t.attisdropped AND t.attacl IS NOT NULL) x
   WHERE x.grantee IN ('anon'::regrole, 'authenticated'::regrole)
     AND x.grantor <> (SELECT relowner FROM pg_class WHERE oid = 'public.posts'::regclass);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): a client privilege on posts was granted by % rather than the table owner; this file''s REVOKE would not remove it.', v_bad;
  END IF;
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.posts'::regclass), 'USAGE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): % does not act for the owner of posts, so its REVOKE would remove nothing.', current_user;
  END IF;

  -- COLUMN level: only SELECT, only to anon/authenticated, never grantable,
  -- only on a column 3362 granted.
  SELECT string_agg(format('%s.%s:%s%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                           a.attname, x.privilege_type, CASE WHEN x.is_grantable THEN '+grant' ELSE '' END), ', ')
    INTO v_bad
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND NOT (x.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND x.privilege_type = 'SELECT'
              AND NOT x.is_grantable AND a.attname::text = ANY (v_granted || v_release));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): posts carries client or PUBLIC column privileges 3362 never granted: %.', v_bad;
  END IF;

  IF v_tables = 2 THEN
    -- S2 (2148's state, production on 2026-10-08): no column privilege beside it.
    IF EXISTS (SELECT 1 FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
                WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attacl IS NOT NULL
                  AND x.grantee IN ('anon'::regrole, 'authenticated'::regrole)) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3801): posts carries a client table-level SELECT AND client column grants; that is neither 2148''s state nor 3362''s.';
    END IF;
    RAISE NOTICE '3801: starting from 2148''s state (table-level client SELECT on posts; 3362 not applied here).';
  ELSIF v_tables = 0 THEN
    -- S1 (3362's end state): both roles hold column SELECT on exactly 3362's
    -- 40 columns (tombstoned_at only where it exists).
    SELECT string_agg(e, ',' ORDER BY e) INTO v_s1_want
      FROM (SELECT r || '.' || c AS e
              FROM unnest(ARRAY['anon','authenticated']) r, unnest(v_granted || v_release) c
             WHERE c = ANY (v_cols)) w;
    SELECT string_agg(e, ',' ORDER BY e) INTO v_s1_have
      FROM (SELECT DISTINCT x.grantee::regrole::text || '.' || a.attname::text AS e
              FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
             WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
               AND x.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND x.privilege_type = 'SELECT') h;
    IF v_s1_have IS DISTINCT FROM v_s1_want THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3801): no table-level client SELECT on posts, but the column grants are not exactly 3362''s. Have: %. Want: %.', v_s1_have, v_s1_want;
    END IF;
    RAISE NOTICE '3801: starting from 3362''s end state (client column grants on posts).';
  ELSE
    RAISE EXCEPTION 'PRECONDITION FAILED (3801): exactly one of anon/authenticated holds a table-level SELECT on posts; that is neither 2148''s state nor 3362''s.';
  END IF;
END $pre$;

-- The table-level SELECT goes, and with it every column-level SELECT the
-- three grantees held (PostgreSQL revokes the column privileges along with
-- the table privilege).
REVOKE SELECT ON TABLE public.posts FROM anon, authenticated, PUBLIC;

GRANT SELECT (
  id, author_id, trip_id, content, media_urls, visibility, status,
  created_by, updated_by, source, created_at, deleted_at,
  media_type, add_to_passport, like_count, comment_count, share_count,
  comments_setting, likes_hidden, sharing_disabled, reposting_disabled,
  category, save_count, media_thumbnail_url, primary_media_type,
  media_count, has_video, filter_id, filter_intensity,
  media_duration_seconds, post_buckets, bucket_classified,
  original_language, geo_restriction,
  age_restriction_enabled, age_min, age_max
) ON TABLE public.posts TO anon, authenticated;

-- tombstoned_at (2141) is granted where it exists, as 3362 did.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.posts'::regclass AND attname = 'tombstoned_at' AND NOT attisdropped) THEN
    EXECUTE 'GRANT SELECT (tombstoned_at) ON TABLE public.posts TO anon, authenticated';
  END IF;
END $$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
-- Re-runnable standalone on the committed database (certify:migrations stage
-- 4): catalog reads only, no temp table, nothing from the applying session.
DO $post$
DECLARE
  v_granted constant text[] := ARRAY[
    'id','author_id','trip_id','content','media_urls','visibility','status',
    'created_by','updated_by','source','created_at','deleted_at',
    'media_type','add_to_passport','like_count','comment_count','share_count',
    'comments_setting','likes_hidden','sharing_disabled','reposting_disabled',
    'category','save_count','media_thumbnail_url','primary_media_type',
    'media_count','has_video','filter_id','filter_intensity',
    'media_duration_seconds','post_buckets','bucket_classified',
    'original_language','geo_restriction',
    'age_restriction_enabled','age_min','age_max','tombstoned_at'];
  -- WHEN a post was released, or the author left: never client-readable.
  v_release constant text[] := ARRAY[
    'updated_at','publish_at','published_at','publish_eligible_at',
    'publish_after_exit','publish_after_time','exited_geofence_at','post_status'];
  -- 3362's minimum: never readable by a client role, in any mode.
  v_never   constant text[] := ARRAY[
    'user_gps_lat','user_gps_lng','original_lat','original_lng','geog',
    'location_distance_meters','exited_geofence_at','delayed_location_reason'];
  v_leak     text;
  v_lost     text;
  v_writable text;
  v_svc      text;
BEGIN
  -- VACUITY GUARD: the columns this file withholds exist, or the claims below
  -- are about nothing.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('updated_at','publish_at','published_at')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801) VACUOUS: posts lacks updated_at, publish_at or published_at.';
  END IF;
  -- 2148's, carried: rows are decided by RLS and a SELECT policy, and the two
  -- verification columns the write boundary was about are still there.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.posts'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): RLS is not enabled on posts; the column grants would be the only boundary.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.posts'::regclass AND polcmd IN ('r', '*')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): posts has no SELECT policy; client reads would need re-deriving.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('geotag_verified','location_verified')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): geotag_verified/location_verified not both present.';
  END IF;

  -- No table-level privilege survives for anon, authenticated or PUBLIC.
  -- Checked first: a table-level SELECT covers every column and would make the
  -- column checks below pass for the wrong reason.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO v_leak
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.posts'::regclass
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): a client role or PUBLIC holds a table-level privilege on posts: %.', v_leak;
  END IF;
  -- PUBLIC holds no column privilege either (it would reach every role).
  SELECT string_agg(a.attname || ':' || x.privilege_type, ', ') INTO v_leak
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attacl IS NOT NULL AND x.grantee = 0;
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): PUBLIC holds a column privilege on posts: %.', v_leak;
  END IF;

  -- THE NEGATIVES: no release-timing column, and none of 3362's minimum.
  SELECT string_agg(r || '.' || a.attname, ', ') INTO v_leak
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (v_release || v_never)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): a client role can still read a release-timing or private posts column: %.', v_leak;
  END IF;

  -- Exactly the granted set: nothing more (a leak), nothing less (a broken
  -- reader: post_media's policies need id, author_id, status, visibility and
  -- trip_id).
  SELECT string_agg(r || '.' || a.attname, ', ') INTO v_leak
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text <> ALL (v_granted)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): a client role can read a withheld posts column: %.', v_leak;
  END IF;
  SELECT string_agg(r || '.' || a.attname, ', ') INTO v_lost
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (v_granted)
     AND NOT has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF v_lost IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): a client role lost a posts column it must keep: %.', v_lost;
  END IF;

  -- No column privilege but SELECT (2148's no-write boundary holds).
  SELECT string_agg(DISTINCT r || '/' || p, ', ') INTO v_writable
    FROM unnest(ARRAY['anon','authenticated']) r,
         unnest(ARRAY['INSERT','UPDATE','REFERENCES']) p,
         pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege(r, a.attrelid, a.attnum, p);
  IF v_writable IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): a client role holds a column privilege other than SELECT on posts: %.', v_writable;
  END IF;

  -- The API's path is untouched: service_role reads every column.
  SELECT string_agg(a.attname, ', ') INTO v_svc
    FROM pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT');
  IF v_svc IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801): service_role cannot read posts column(s) %; the API would break.', v_svc;
  END IF;
  RAISE NOTICE '3801 postcondition: anon/authenticated read posts'' granted columns only; no release-timing column; service_role reads all.';
END $post$;
