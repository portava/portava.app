-- 3809_memory_media_segments.sql
-- Highlights/Memories spec §20 (media pipeline): "Video scenes as logical
-- segments without duplicating originals". Census-highlights-memories H184
-- (§BP). B58 cluster MEM-SEGMENTS.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (B58 memories band 3802-3819).
-- APPLIED TO NO DATABASE by the lane that wrote it. Additive and idempotent: one
-- table, three indexes, one integrity trigger, grants. No flag, no row, no
-- change to any existing table.
--
-- ── WHAT A ROW IS ───────────────────────────────────────────────────────────
-- One LOGICAL segment of one video item on a Memory: the half-open window
-- [start_ms, end_ms) of the item's own stored object, with an optional owner
-- label. A row holds two ids of the Memory and item, the owner, two integers,
-- an optional short text and a time — NO storage path, URL or bucket. A segment
-- is played from the item's own media reference (memory_items.media_url, read
-- through the item at serve time), so nothing is written, uploaded, copied or
-- transcoded to make one, and deleting one deletes no bytes. That is the whole
-- of "without duplicating originals"; the exact column list is asserted below.
--
-- ── WHO READS AND WRITES IT ─────────────────────────────────────────────────
-- Written only by routes/memorySegments.ts (POST/DELETE, the Memory's owner
-- only), as service_role, after the window is checked against the item's
-- MEASURED duration (media_assets.duration_ms, written by routes/posts.ts
-- recordMeasuredDuration; unknown ⇒ refused). Read by GET
-- /memories/:id/segments for a viewer who may read the ITEM (the Memory's §23
-- ladder, the block check, and 3672's item audience): a segment adds no read
-- grant of any kind, and its label reaches exactly the item caption's audience.
-- Absent (this file not applied: 42P01 / PGRST205 only) ⇒ no segment exists,
-- reads say so, writes answer feature_disabled.
--
-- ── INTEGRITY THE ROUTE ALSO CHECKS, HELD HERE TOO ──────────────────────────
-- memory_media_segments_integrity (BEFORE INSERT OR UPDATE): the item must be
-- ON the Memory, and owner_id must be the Memory's owner. A segment can never
-- point one Memory at another Memory's video, and the owner_id the account-
-- deletion cascade follows is the Memory owner's, whatever a writer sends.
-- SECURITY INVOKER (it reads only what its writer, service_role, can read) and
-- RETURNS trigger, so 3813's precondition accepts it by construction; EXECUTE
-- is revoked from the client roles regardless.
--
-- ── NO CLIENT ROLE ──────────────────────────────────────────────────────────
-- Supabase's default privileges hand anon and authenticated a new table; both
-- are revoked here (check:client-privilege-boundary rule 4) and the table is in
-- rule 7's SERVER_ONLY_TABLES. RLS is on with no policy: service_role only,
-- holding SELECT, INSERT and DELETE — no UPDATE, because no path edits a
-- segment (an owner deletes and re-marks).
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────
-- memory_id cascades from public.memories, item_id from public.memory_items
-- (removing a video removes its segments), owner_id from auth.users (account
-- deletion's final step). lib/deletionDispositions.ts: ERASED_BY_CASCADE.
--
-- Rollback: db/rollback/2026-10-14-3809-memory-media-segments-rollback.sql
-- Proof: src/test/db/memoryMediaSegments.db.test.ts (CI local-db tier, the real
-- chain) and sql/rehearsals/3809_01_memory_media_segments.sql (PGlite).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL OR to_regclass('public.memory_items') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3809): public.memories / public.memory_items missing.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3809): auth.users is missing, so the erasure cascade cannot be created.';
  END IF;
  -- The trigger reads these two columns of memory_items and one of memories.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.memory_items'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('id', 'memory_id')) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = 'public.memories'::regclass AND attname = 'owner_id' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3809): memory_items(id, memory_id) or memories.owner_id is missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.memory_media_segments') AND relkind <> 'r') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3809): public.memory_media_segments exists and is not a table.';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.memory_media_segments (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  memory_id  uuid        NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  item_id    uuid        NOT NULL REFERENCES public.memory_items(id) ON DELETE CASCADE,
  owner_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_ms   integer     NOT NULL,
  end_ms     integer     NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_media_segments_bounds_check CHECK (start_ms >= 0 AND start_ms < end_ms),
  CONSTRAINT memory_media_segments_label_check CHECK (label IS NULL OR (char_length(label) >= 1 AND char_length(label) <= 120)),
  CONSTRAINT memory_media_segments_window_unique UNIQUE (item_id, start_ms, end_ms)
);

CREATE INDEX IF NOT EXISTS memory_media_segments_memory_idx ON public.memory_media_segments (memory_id);
CREATE INDEX IF NOT EXISTS memory_media_segments_owner_idx ON public.memory_media_segments (owner_id);

COMMENT ON TABLE public.memory_media_segments IS
  'Spec §20 (migration 3809, census H184): a LOGICAL segment [start_ms, end_ms) of one video item on a Memory, with an optional owner label. No storage path, URL or bucket: a segment plays from the item''s own media reference, so nothing is duplicated. Written by POST/DELETE /memories/:id/items/:itemId/segments and /memories/:id/segments/:segmentId (owner only, checked against the measured duration); read by GET /memories/:id/segments for a viewer who may read the item. service_role only (SELECT, INSERT, DELETE).';

-- ── The integrity trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.memory_media_segments_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_owner uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memory_items i WHERE i.id = NEW.item_id AND i.memory_id = NEW.memory_id) THEN
    RAISE EXCEPTION 'memory_media_segments: item % is not on Memory % (3809)', NEW.item_id, NEW.memory_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT m.owner_id INTO v_owner FROM public.memories m WHERE m.id = NEW.memory_id;
  IF v_owner IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'memory_media_segments: owner_id must be the owner of Memory % (3809)', NEW.memory_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_media_segments_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_media_segments_integrity ON public.memory_media_segments;
CREATE TRIGGER memory_media_segments_integrity
  BEFORE INSERT OR UPDATE ON public.memory_media_segments
  FOR EACH ROW EXECUTE FUNCTION public.memory_media_segments_integrity();

-- ── Access: RLS on, no policy, no client privilege ───────────────────────────
ALTER TABLE public.memory_media_segments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_media_segments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.memory_media_segments TO service_role;

COMMIT;

-- ── Postconditions (a separate request on the live applier: catalog reads only,
--    nothing from the applying session, re-runnable on the committed database) ──
DO $post$
DECLARE
  v_cols text;
  v_leak text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.memory_media_segments') AND relkind = 'r') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): memory_media_segments was not created';
  END IF;

  -- Exactly these columns: no path, URL or bucket, so a segment cannot hold a copy of anything.
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.memory_media_segments'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'id,memory_id,item_id,owner_id,start_ms,end_ms,label,created_at' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): memory_media_segments has columns % — a segment holds a window over the item''s own object, never a reference of its own', v_cols;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memory_media_segments'::regclass
               AND attname IN ('id', 'memory_id', 'item_id', 'owner_id', 'start_ms', 'end_ms', 'created_at') AND NOT attnotnull) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): a memory_media_segments column other than label is nullable';
  END IF;

  -- Keys and the three erasure cascades.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'p'
                   AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.memory_media_segments'::regclass AND attname = 'id')]::int2[]) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): id is not the primary key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'f'
                   AND confrelid = 'public.memories'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): memory_id does not cascade from public.memories';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'f'
                   AND confrelid = 'public.memory_items'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): item_id does not cascade from public.memory_items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'f'
                   AND confrelid = 'auth.users'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): owner_id does not cascade from auth.users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'u'
                   AND conname = 'memory_media_segments_window_unique'
                   AND conkey = ARRAY(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.memory_media_segments'::regclass
                                        AND attname IN ('item_id', 'start_ms', 'end_ms') ORDER BY attnum)::int2[]) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): UNIQUE (item_id, start_ms, end_ms) is missing';
  END IF;

  -- The window CHECK: 0 <= start_ms < end_ms. The label CHECK: absent, or 1-120 characters.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'c'
                   AND conname = 'memory_media_segments_bounds_check'
                   AND pg_get_constraintdef(oid) LIKE '%start_ms >= 0%' AND pg_get_constraintdef(oid) LIKE '%start_ms < end_ms%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): the CHECK 0 <= start_ms < end_ms is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_media_segments'::regclass AND contype = 'c'
                   AND conname = 'memory_media_segments_label_check'
                   AND pg_get_constraintdef(oid) LIKE '%char_length(label) <= 120%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): the label length CHECK is missing';
  END IF;

  -- The integrity trigger: present, enabled, BEFORE INSERT OR UPDATE, row level, not client-callable.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.memory_media_segments'::regclass AND t.tgname = 'memory_media_segments_integrity'
                    AND NOT t.tgisinternal AND t.tgenabled = 'O'
                    AND (t.tgtype & 1) = 1      -- ROW
                    AND (t.tgtype & 2) = 2      -- BEFORE
                    AND (t.tgtype & 4) = 4      -- INSERT
                    AND (t.tgtype & 16) = 16    -- UPDATE
                    AND t.tgfoid = 'public.memory_media_segments_integrity()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): the integrity trigger is missing, disabled or not BEFORE INSERT OR UPDATE FOR EACH ROW';
  END IF;
  IF has_function_privilege('anon', 'public.memory_media_segments_integrity()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_media_segments_integrity()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): a client role may execute memory_media_segments_integrity()';
  END IF;

  -- RLS on, no policy: service_role only.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_media_segments'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): RLS is not enabled on memory_media_segments';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_media_segments'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): memory_media_segments must carry no policy';
  END IF;

  -- No client role or PUBLIC holds anything, at table or column level.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO v_leak
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.memory_media_segments'::regclass
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): a client role or PUBLIC holds a privilege: %', v_leak;
  END IF;
  SELECT string_agg(a.attname, ', ')
    INTO v_leak
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.memory_media_segments'::regclass AND a.attnum > 0 AND a.attacl IS NOT NULL
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): a client role or PUBLIC holds a column privilege on: %', v_leak;
  END IF;
  SELECT string_agg(r || ':' || p, ', ')
    INTO v_leak
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE has_table_privilege(r, 'public.memory_media_segments', p)
      OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r, 'public.memory_media_segments', p));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): a client role can use: %', v_leak;
  END IF;

  -- The API's role: read, mark and remove; never rewrite.
  SELECT string_agg(p, ', ') INTO v_leak
    FROM unnest(ARRAY['SELECT', 'INSERT', 'DELETE']) p
   WHERE NOT has_table_privilege('service_role', 'public.memory_media_segments', p);
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): service_role lacks % on memory_media_segments', v_leak;
  END IF;
  IF has_table_privilege('service_role', 'public.memory_media_segments', 'UPDATE')
     OR has_table_privilege('service_role', 'public.memory_media_segments', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809): service_role may UPDATE or TRUNCATE memory_media_segments; a segment is marked and removed, never rewritten';
  END IF;
  RAISE NOTICE '3809 postcondition: memory_media_segments (a window over the item''s own object, no path) is service_role only.';
END $post$;
