-- Rollback for 3814_memory_social_client_privileges_revoked.sql (lane MEM-ACL-2,
-- B58; follow-up to 3813 / PR #726, owner question OQ-MEM-ACL-2-1).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3814 DID: REVOKE ALL ON public.memory_saves, public.memory_likes,
-- public.memory_tags and public.memory_items FROM PUBLIC, anon, authenticated.
-- Nothing else: no policy, row, function, trigger or service_role privilege.
--
-- WHAT THIS DOES: re-grants SELECT, INSERT, UPDATE and DELETE on the four tables
-- to anon and authenticated, and deletes 3814's ledger row so the runner
-- re-applies 3814 later. That is the state the chain left before 3814 on every
-- database 2490 is applied to (production, portava-ci): the baseline's GRANT ALL
-- (:36647-36676) as 2490 narrowed it. It deliberately does NOT re-issue the
-- baseline's GRANT ALL: TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are privileges
-- RLS never polices, and 2490 took them from every table; a rollback of 3814 must
-- not undo 2490. (The PostgreSQL 16 replica in CI's local-db job cannot replay
-- 2490, so there the four classic extras were present before 3814 and stay gone
-- after this rollback.)
--
-- ⚠ IT RE-OPENS EVERY DOOR 3814 CLOSED: a signed-in user saves and likes any
-- Memory id directly (and learns from the foreign key whether that id exists), a
-- tagged person re-points their tag row at another Memory, and an owner writes
-- tags and photos past the API's checks. Use it only to recover from a client
-- reader 3814 broke, and re-apply 3814 as soon as that reader is on the API.
--
-- Refuses unless, on each table, RLS is on and every policy that bounds the
-- re-granted privileges is present (without them the re-grant would expose or
-- open every row), and unless memory_items_public_read still keeps an only_me
-- photo (3672) from strangers wherever the visibility column exists.

BEGIN;

DO $pre$
DECLARE
  v_t   text;
  v_rel regclass;
  v_pol text[];
  v_has int;
  v_q   text;
BEGIN
  FOR v_t, v_pol IN
    SELECT * FROM (VALUES
      ('memory_saves', ARRAY['memory_saves_own']),
      ('memory_likes', ARRAY['memory_likes_own', 'memory_likes_read']),
      ('memory_tags',  ARRAY['memory_tags_owner_delete', 'memory_tags_owner_insert', 'memory_tags_owner_read', 'memory_tags_tagged_update']),
      ('memory_items', ARRAY['memory_items_public_read', 'memory_items_via_memory'])) t(tbl, pols)
  LOOP
    v_rel := to_regclass('public.' || v_t);
    IF v_rel IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814 rollback): public.% does not exist.', v_t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814 rollback): RLS is not enabled on public.%; re-granting the client roles would expose every row.', v_t;
    END IF;
    SELECT count(*) INTO v_has FROM pg_policy WHERE polrelid = v_rel AND polname = ANY (v_pol);
    IF v_has <> cardinality(v_pol) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814 rollback): public.% does not carry all of %; the rows the re-granted privileges reach would need re-deriving.', v_t, v_pol;
    END IF;
  END LOOP;

  -- 3672: a photo kept only_me must not become readable through the re-grant.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.memory_items'::regclass AND attname = 'visibility' AND NOT attisdropped) THEN
    SELECT pg_get_expr(polqual, polrelid) INTO v_q FROM pg_policy
     WHERE polrelid = 'public.memory_items'::regclass AND polname = 'memory_items_public_read';
    IF v_q IS NULL OR position('visibility IS NULL' in v_q) = 0 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814 rollback): memory_items has a visibility column but memory_items_public_read does not exclude an only_me photo (qual: %); re-granting SELECT would show it to strangers.', v_q;
    END IF;
  END IF;
END $pre$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.memory_saves, public.memory_likes, public.memory_tags, public.memory_items
  TO anon, authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3814_memory_social_client_privileges_revoked.sql';

COMMIT;

DO $post$
DECLARE
  v_missing text;
  v_extra   text;
BEGIN
  SELECT string_agg(t || ' ' || r || ':' || p, ', ')
    INTO v_missing
    FROM unnest(ARRAY['memory_saves', 'memory_likes', 'memory_tags', 'memory_items']) t,
         unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE NOT has_table_privilege(r, ('public.' || t)::regclass::oid, p);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3814 rollback): the pre-3814 client grants are not back: %.', v_missing;
  END IF;
  SELECT string_agg(t || ' ' || r || ':' || p, ', ')
    INTO v_extra
    FROM unnest(ARRAY['memory_saves', 'memory_likes', 'memory_tags', 'memory_items']) t,
         unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE has_table_privilege(r, ('public.' || t)::regclass::oid, p);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3814 rollback): a client role holds a privilege RLS does not police (2490): %.', v_extra;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3814_memory_social_client_privileges_revoked.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3814 rollback): the ledger still records 3814 as applied.';
  END IF;
END $post$;
