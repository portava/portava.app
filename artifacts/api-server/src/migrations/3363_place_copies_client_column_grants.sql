-- 3363_place_copies_client_column_grants.sql
-- The three tables that hold a COPY of a post's place: the client roles may
-- read only their columns that carry no place (census-media §44.11, lane G1).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it. It changes what the public anon key can
-- read from three live tables, so it needs the owner's production approval
-- (census-media §44.15 is the approval step: order, verification, recovery).
--
-- ── THE DEFECT (census-media §44.7, item 2) ─────────────────────────────────
-- 3362 withheld posts' place columns from anon and authenticated. The same
-- place is copied at create, whatever the author's location_privacy_mode, into
-- three tables the client roles still read in full:
--   pulse_geo_tags      SELECT policies `true` for every role: every row.
--                       venue_name, district, city, the geo zone, the owner's
--                       Pulse visibility, and hotel_blur_applied — "this was
--                       posted within ~200 m of where the author sleeps".
--   passport_postcards  postcards_select: can_see_postcard(id). The venue
--                       (location_name), city, country, and the verification
--                       verdict incl. verified_distance_meters.
--   post_media          post_media_public_select. canonical_place_id, and
--                       stamp_overlay (a stamp's label, city and country).
--
-- ── WHO READS THESE COLUMNS AS A CLIENT ROLE (census-media §44.12) ──────────
-- * No client code. travel-buddy-standalone and the legacy root app have no
--   `.from()` on any of the three, no embedded resource, no RPC and no realtime
--   channel on them, in the tree or in git history. The app reads them only
--   through the API.
-- * The API reads and writes them only as service_role. Untouched here.
-- * In the database: no policy on another table, no view, no trigger and no
--   function a client role may EXECUTE reads any of them as the invoking role
--   (can_see_postcard is SECURITY DEFINER). Their own policies read their own
--   columns, which needs no column privilege.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
-- For each table: REVOKE the table-level SELECT from anon and authenticated,
-- and GRANT SELECT on the columns below. Nothing else: every INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES, TRIGGER (and MAINTAIN) privilege, table- or
-- column-level, is left exactly as it is, and so is every policy and row.
--
--   pulse_geo_tags — granted 4: id, post_id, user_id, created_at.
--     withheld 13: venue_name, display_label, district, city, country,
--     country_code, geo_zone_id, tag_type, approx_distance_label,
--     location_visibility, hotel_blur_applied, source, confidence_score.
--   passport_postcards — granted 20 (content, audience, stamp style and
--     revocation, media counts, timestamps).
--     withheld 9: location_name, location_city, location_country,
--     location_verified, verification_method, verified_distance_meters,
--     verified_at, stamp_eligible, stamp_reason.
--   post_media — granted 23 (the file, its processing and moderation state).
--     withheld 2: canonical_place_id, stamp_overlay.
--
-- The classes are 3362's: the place; the city and country (these tables admit
-- rows the API never serves, e.g. a pending delayed post's geo tag); privacy
-- state; presence evidence and location verification. census-media §44.13
-- argues each column.
--
-- A column added to any of the three later is readable by NO client role
-- until a migration grants it: the default is closed. Any column this file
-- does not classify refuses the apply.
--
-- Rollback: db/rollback/2026-09-27-3363-place-copies-client-column-grants-rollback.sql
-- (restores the prior SELECT grants exactly, deletes this file's ledger row,
-- and with them re-opens the defect).

BEGIN;

DO $pre$
DECLARE
  spec jsonb := $spec${
    "pulse_geo_tags": {
      "granted":  ["id","post_id","user_id","created_at"],
      "withheld": ["venue_name","display_label","district","city","country",
                   "country_code","geo_zone_id","tag_type","approx_distance_label",
                   "location_visibility","hotel_blur_applied","source","confidence_score"]},
    "passport_postcards": {
      "granted":  ["id","post_id","user_id","media_url","caption","stamp_style",
                   "stamp_revoked","stamp_revoked_reason","stamp_revoked_at",
                   "stamp_revoked_by","visibility","status","created_at","updated_at",
                   "deleted_at","primary_media_type","media_count","has_video",
                   "pinned_at","note"],
      "withheld": ["location_name","location_city","location_country",
                   "location_verified","verification_method","verified_distance_meters",
                   "verified_at","stamp_eligible","stamp_reason"]},
    "post_media": {
      "granted":  ["id","post_id","user_id","media_type","storage_bucket",
                   "storage_path","public_url","thumbnail_url","thumbnail_storage_path",
                   "mime_type","file_size_bytes","duration_seconds","width","height",
                   "processing_status","moderation_status","sort_order","created_at",
                   "updated_at","phash","dedup_processed","feed_storage_path","feed_url"],
      "withheld": ["canonical_place_id","stamp_overlay"]}
  }$spec$;
  t        text;
  rel      regclass;
  granted  text[];
  withheld text[];
  cols     text[];
  bad      text;
BEGIN
  FOR t IN SELECT jsonb_object_keys(spec) LOOP
    rel := to_regclass('public.' || t);
    IF rel IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): public.% does not exist.', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = rel) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): RLS is not enabled on %; column grants would then be the only boundary. Refusing.', t;
    END IF;
    granted  := ARRAY(SELECT jsonb_array_elements_text(spec -> t -> 'granted'));
    withheld := ARRAY(SELECT jsonb_array_elements_text(spec -> t -> 'withheld'));
    cols     := ARRAY(SELECT attname::text FROM pg_attribute
                       WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped);

    -- Every column named here exists, and every column that exists is named
    -- once. An unclassified column may be a place: refuse rather than guess.
    SELECT string_agg(c, ', ') INTO bad FROM unnest(granted || withheld) c WHERE c <> ALL (cols);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): % lacks column(s) this migration classifies: %.', t, bad;
    END IF;
    SELECT string_agg(c, ', ') INTO bad FROM unnest(cols) c WHERE c <> ALL (granted) AND c <> ALL (withheld);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): % has column(s) this migration does not classify: %. Classify them in 3363 before applying.', t, bad;
    END IF;
    SELECT string_agg(c, ', ') INTO bad FROM unnest(granted) c WHERE c = ANY (withheld);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): % classifies column(s) twice: %.', t, bad;
    END IF;

    -- The start state the rollback restores: anon and authenticated each hold
    -- table-level SELECT without grant option, PUBLIC holds no SELECT, and no
    -- client role holds a COLUMN-level SELECT (column INSERT/UPDATE may exist
    -- and are left alone).
    IF (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) a
         WHERE c.oid = rel AND a.privilege_type = 'SELECT' AND NOT a.is_grantable
           AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) <> 2 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): anon and authenticated do not both hold table-level SELECT (without grant option) on %.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
                WHERE c.oid = rel AND a.grantee = 0 AND a.privilege_type = 'SELECT') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): PUBLIC holds SELECT on %; a client-role revoke would change nothing.', t;
    END IF;
    SELECT string_agg(a.attname || ':' || x.grantee::regrole::text, ', ') INTO bad
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type = 'SELECT'
       AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363): % already carries column-level SELECT for a client role (%); the rollback could not restore it.', t, bad;
    END IF;
  END LOOP;
END $pre$;

-- ── pulse_geo_tags ──────────────────────────────────────────────────────────
REVOKE SELECT ON TABLE public.pulse_geo_tags FROM anon, authenticated;
GRANT SELECT (id, post_id, user_id, created_at)
  ON TABLE public.pulse_geo_tags TO anon, authenticated;

-- ── passport_postcards ──────────────────────────────────────────────────────
REVOKE SELECT ON TABLE public.passport_postcards FROM anon, authenticated;
GRANT SELECT (
  id, post_id, user_id, media_url, caption, stamp_style,
  stamp_revoked, stamp_revoked_reason, stamp_revoked_at,
  stamp_revoked_by, visibility, status, created_at, updated_at,
  deleted_at, primary_media_type, media_count, has_video,
  pinned_at, note
) ON TABLE public.passport_postcards TO anon, authenticated;

-- ── post_media ──────────────────────────────────────────────────────────────
REVOKE SELECT ON TABLE public.post_media FROM anon, authenticated;
GRANT SELECT (
  id, post_id, user_id, media_type, storage_bucket,
  storage_path, public_url, thumbnail_url, thumbnail_storage_path,
  mime_type, file_size_bytes, duration_seconds, width, height,
  processing_status, moderation_status, sort_order, created_at,
  updated_at, phash, dedup_processed, feed_storage_path, feed_url
) ON TABLE public.post_media TO anon, authenticated;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  spec jsonb := $spec${
    "pulse_geo_tags":     ["id","post_id","user_id","created_at"],
    "passport_postcards": ["id","post_id","user_id","media_url","caption","stamp_style",
                           "stamp_revoked","stamp_revoked_reason","stamp_revoked_at",
                           "stamp_revoked_by","visibility","status","created_at","updated_at",
                           "deleted_at","primary_media_type","media_count","has_video",
                           "pinned_at","note"],
    "post_media":         ["id","post_id","user_id","media_type","storage_bucket",
                           "storage_path","public_url","thumbnail_url","thumbnail_storage_path",
                           "mime_type","file_size_bytes","duration_seconds","width","height",
                           "processing_status","moderation_status","sort_order","created_at",
                           "updated_at","phash","dedup_processed","feed_storage_path","feed_url"]
  }$spec$;
  -- The place itself, and presence evidence: never readable by a client role.
  never jsonb := $never${
    "pulse_geo_tags":     ["venue_name","display_label","district","geo_zone_id","hotel_blur_applied","approx_distance_label"],
    "passport_postcards": ["location_name","verified_distance_meters"],
    "post_media":         ["canonical_place_id","stamp_overlay"]
  }$never$;
  t       text;
  rel     regclass;
  granted text[];
  leak    text;
  lost    text;
  svc     text;
BEGIN
  FOR t IN SELECT jsonb_object_keys(spec) LOOP
    rel     := ('public.' || t)::regclass;
    granted := ARRAY(SELECT jsonb_array_elements_text(spec -> t));

    SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
      FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
     WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname::text IN (SELECT jsonb_array_elements_text(never -> t))
       AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
    IF leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363): a client role can still read a place column of %: %.', t, leak;
    END IF;

    -- Exactly the granted set is readable: nothing more, nothing less.
    SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
      FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
     WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname::text <> ALL (granted)
       AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
    IF leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363): a client role can read a withheld column of %: %.', t, leak;
    END IF;
    SELECT string_agg(r || '.' || a.attname, ', ') INTO lost
      FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
     WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname::text = ANY (granted)
       AND NOT has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
    IF lost IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363): a client role lost a column of % it must keep: %.', t, lost;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
                WHERE c.oid = rel AND x.privilege_type = 'SELECT'
                  AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363): a client role or PUBLIC still holds table-level SELECT on %.', t;
    END IF;

    SELECT string_agg(a.attname, ', ') INTO svc
      FROM pg_attribute a
     WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT');
    IF svc IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363): service_role cannot read column(s) % of %; the API would break.', svc, t;
    END IF;
  END LOOP;
END $post$;
