-- Rollback for 3906_event_waitlist_seat_under_event_lock.sql (census-trust, the events waitlist's same-instant race;
-- wave 5, docs/ops/wave5-owner-decisions-20261018.md "Migrations").
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3906 DID: created TWO functions, each with a COMMENT, and set their EXECUTE to service_role only,
--   public.claim_waitlist_seat(p_event_id uuid, p_user_id uuid, p_offer_expires_at timestamptz) -> text
--   public.accept_waitlist_seat(p_event_id uuid, p_user_id uuid) -> text
-- both plpgsql, VOLATILE, SECURITY INVOKER, SET search_path = pg_catalog. Nothing else: no table, column, row,
-- policy, grant on a table or flag. The only row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops both functions (their comments and grants go with them), deletes 3906's ledger row so the
-- runner re-applies 3906 later, and asks PostgREST to reload its schema cache (delivered at the COMMIT). No row of
-- events, event_rsvps or event_waitlist is touched: offers claimed and seats taken under the lock stay as they are.
-- routes/events.ts then sees the function gone (PGRST202 once the cache is reloaded, 42883 before that: either way
-- nothing ran) and runs today's unlocked statements, exactly as before 3906.
--
-- ⚠ IT RE-OPENS THE SAME-INSTANT RACE: two promotion passes can again each offer one person for one seat, and two
-- accepts for the last seat can again both be seated.
--
-- Refuses, dropping nothing, unless the installed state is exactly 3906's or exactly the state before it:
--   * a function of either name with another signature exists (3906 never made one);
--   * one of the two exists without the other (3906 creates both in one transaction);
--   * either one differs from 3906's own: its body (sha256 of prosrc), its argument names, its comment (sha256),
--     plpgsql, VOLATILE, SECURITY INVOKER, not STRICT, search_path exactly pg_catalog;
--   * its EXECUTE is not 3906's: anon, authenticated or PUBLIC may execute it, or service_role may not;
--   * another object depends on it.
-- If neither function exists, it changes nothing and clears only the (already absent) ledger row: a second run is a
-- no-op.
--
-- LOCK: none on any table. DROP FUNCTION locks only the functions' catalog rows.

BEGIN;

DO $pre$
DECLARE
  v_fn      text;
  v_present text[] := ARRAY[]::text[];
  f         text;
  v_dep     text;
BEGIN
  -- A same-named function 3906 did not make (another signature) is someone else's: refuse rather than leave a state
  -- 3906's own precondition would then refuse to re-apply over.
  SELECT min(format('public.%s(%s)', p.proname, oidvectortypes(p.proargtypes))) INTO v_fn
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('claim_waitlist_seat', 'accept_waitlist_seat')
     AND format('%s(%s)', p.proname, oidvectortypes(p.proargtypes)) NOT IN ('claim_waitlist_seat(uuid, uuid, timestamp with time zone)', 'accept_waitlist_seat(uuid, uuid)');
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3906): a function % exists that 3906 did not make (another signature). Nothing was dropped.', v_fn;
  END IF;

  FOREACH f IN ARRAY ARRAY['public.claim_waitlist_seat(uuid,uuid,timestamptz)', 'public.accept_waitlist_seat(uuid,uuid)'] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      v_present := v_present || f;
    END IF;
  END LOOP;
  IF cardinality(v_present) = 0 THEN
    RAISE NOTICE '3906 rollback: neither claim_waitlist_seat nor accept_waitlist_seat exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF cardinality(v_present) = 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3906): only % exists; 3906 creates both functions in one transaction, so this state was made by hand. Nothing was dropped.', v_present[1];
  END IF;

  FOREACH f IN ARRAY v_present LOOP
    -- 3906's definition, exactly: the body byte for byte, the argument names PostgREST binds by, the comment, and the
    -- header 3906 wrote. The two sha256 pairs are of 3906's own text (prosrc is stored verbatim).
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE p.oid = to_regprocedure(f)
         AND l.lanname = 'plpgsql' AND p.prokind = 'f' AND NOT p.prosecdef AND p.provolatile = 'v' AND NOT p.proisstrict
         AND NOT p.proretset AND p.prorettype = 'text'::regtype AND p.pronargdefaults = 0
         AND p.proconfig = ARRAY['search_path=pg_catalog']
         AND (p.proname, pg_get_function_arguments(p.oid),
              encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
              encode(sha256(convert_to(coalesce(obj_description(p.oid, 'pg_proc'), ''), 'UTF8')), 'hex'))
             IN (('claim_waitlist_seat'::name, 'p_event_id uuid, p_user_id uuid, p_offer_expires_at timestamp with time zone',
                  'd14465f44bd487cf9f23b6ed7b4c138df6a673e35aad3e037203d701fae4ce6a',
                  '21798d9a8e499778888699d0e7c4265bd9bd1c6f73bc1d185771a083a071b8b1'),
                 ('accept_waitlist_seat'::name, 'p_event_id uuid, p_user_id uuid',
                  'f5c76fa58c6f4d51a6eef3960985bd55a79de5ece02b880a1b61c4d8544033e6',
                  'd04bd85ee2662a151d5d4c4a79edbfce61c6ac0354a47108bae3569f4880282b'))
    ) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3906): % exists but is not 3906''s definition (its body, argument names, comment, language, volatility, security or search_path differ). Nothing was dropped.', f;
    END IF;
    -- 3906's EXECUTE: service_role only (what its own $post$ asserts).
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3906): %''s EXECUTE is not 3906''s (service_role only; anon, authenticated and PUBLIC refused). Nothing was dropped.', f;
    END IF;
    -- Nothing 3906 made depends on either function; anything that does was made by hand, and DROP would refuse it.
    SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO v_dep
      FROM pg_catalog.pg_depend d
     WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = to_regprocedure(f);
    IF v_dep IS NOT NULL THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3906): % has dependent objects that 3906 did not make: %. Nothing was dropped.', f, v_dep;
    END IF;
  END LOOP;
END $pre$;

DROP FUNCTION IF EXISTS public.claim_waitlist_seat(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.accept_waitlist_seat(uuid, uuid);
DELETE FROM public.schema_migration_ledger WHERE filename = '3906_event_waitlist_seat_under_event_lock.sql';
-- PostgREST stops answering from its cached definitions; delivered only if this transaction commits.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_fn text;
BEGIN
  SELECT min(format('public.%s(%s)', p.proname, oidvectortypes(p.proargtypes))) INTO v_fn
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('claim_waitlist_seat', 'accept_waitlist_seat');
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3906): % still exists.', v_fn;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3906_event_waitlist_seat_under_event_lock.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3906): the ledger still records 3906 as applied.';
  END IF;
END $post$;
