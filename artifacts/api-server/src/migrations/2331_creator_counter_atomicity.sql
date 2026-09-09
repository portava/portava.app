-- 2331_creator_counter_atomicity.sql
--
-- Give `profiles.featured_count` a single-statement, atomic writer.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2331.
-- Additive + idempotent. Safe to re-run. Changes no existing data: the function
-- is created, nothing is backfilled and no counter is recomputed.
--
-- ── THE DEFECT (docs/architecture/12 §3.3 C1; 07 §3 D6) ─────────────────────
-- Every one of the FOUR places that move `profiles.featured_count` does it as a
-- read-modify-write across two round trips:
--
--     const { data } = await sc.from("profiles").select("featured_count")…
--     const current  = data?.featured_count ?? 0;
--     await sc.from("profiles").update({ featured_count: current + 1 })…
--
--   routes/adminFeatured.ts  approve            (was :333-342)
--   routes/adminFeatured.ts  accept-permission  (was :444-449)
--   routes/adminFeatured.ts  revoke             (was :561-565)
--   routes/adminFeatured.ts  DELETE /:id        (was :718-724)   <- not named in
--                                                                  the register
--
-- supabase-js issues each statement in its own implicit transaction, so two
-- admins approving two different posts by the same author interleave as
-- read(3) / read(3) / write(4) / write(4): two features, one increment. The
-- decrements are worse — they lose a decrement AND they clamp with
-- `Math.max(0, current - 1)` computed off a value that may already be stale, so
-- the counter can drift both ways and never self-corrects, because nothing
-- recounts it from `portava_featured`.
--
-- `.agents/memory/counter-update-atomicity.md` records this exact pattern as
-- REJECTED in completion review, and names the required form: a SECURITY
-- DEFINER SQL function with a column allowlist and `GREATEST(0, col + delta)`.
--
-- ── WHY A FUNCTION AND NOT ROUTE CODE ───────────────────────────────────────
-- There is no PostgREST expression for `col = col + 1`. Every client-side shape
-- reads then writes, which is the defect. One UPDATE statement is atomic under
-- Postgres' row locking by construction: concurrent updaters of the same row
-- serialise on the row lock and each re-evaluates the expression against the
-- committed value, so N concurrent +1s land exactly +N. That property is not
-- available from Node at all.
--
-- ── MODELLED ON rb_adjust_buddy_counter ─────────────────────────────────────
-- `public.rb_adjust_buddy_counter` (2305:57-75, originally 0135) is the
-- established shape in this repository for exactly this problem on
-- `rent_buddy_profiles`. This is the same function for `profiles`, and it is
-- deliberately a SEPARATE function rather than a widening of that one:
--
--   * the two write different tables, and `format(%I)` on a column name cannot
--     also parameterise the table without turning one allowlist into a matrix;
--   * `rb_adjust_buddy_counter` keys on `rent_buddy_profiles.id`, which is the
--     buddy-profile id and NOT a user id. Merging them would put two different
--     identity spaces behind one argument name — the confusion 2304 exists to
--     undo;
--   * `profiles` is the identity table. Its writer's blast radius should be
--     stated in its own allowlist, not inherited from a marketplace lane.
--
-- ── THE ALLOWLIST IS THE SECURITY BOUNDARY ──────────────────────────────────
-- A SECURITY DEFINER function that takes a column name and EXECUTEs a `format`
-- against `profiles` is, without an allowlist, an arbitrary-column writer on
-- the identity table running as the owner. The IN-list is what makes it a
-- counter writer instead. It admits exactly ONE column today —
-- `featured_count`. Adding a name to it is a security decision, not a
-- convenience: `%I` quotes an identifier safely, so the allowlist is not there
-- to stop injection, it is there to stop `role`, `is_official`,
-- `account_status` and every other authority column on `profiles` from being
-- reachable through a counter API.
--
-- Note the ordering inside the body: the allowlist check runs BEFORE the
-- format/EXECUTE, so a rejected column never reaches a constructed statement.
--
-- ── GRANTS ──────────────────────────────────────────────────────────────────
-- REVOKE ALL from PUBLIC, anon, authenticated AND service_role, then GRANT
-- EXECUTE to service_role only. The service_role revoke is not redundant
-- ceremony: Supabase's `public` schema carries ALTER DEFAULT PRIVILEGES that
-- grant ALL on new objects, so a fresh function can arrive already granted to
-- roles this file never named. 2092 -> 2093 is the worked failure in this
-- repository. Revoking unconditionally first makes the final grant set a
-- statement of intent rather than a hope about defaults.
--
-- `featured_count` is a granted-standing counter (07 §3: "Featured by Portava"
-- is GRANTED, written by an admin) and D4 requires that a granted artifact never
-- feed an earned score — so its only writer is an admin route running as
-- service_role. No client role has any business calling this.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────────────
-- It does not backfill or recount `featured_count` from `portava_featured`.
-- Existing drift is not this file's to silently "correct": a recount is a data
-- change with its own evidence requirements, and running one here would make an
-- additive migration rewrite user-visible rows. It does not touch RLS, any
-- feature flag, or any grant on `profiles` itself.

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
-- The function is generated against columns that must exist. A missing column
-- would otherwise surface as a runtime 42703 inside a SECURITY DEFINER EXECUTE,
-- i.e. at admin-approval time rather than at apply time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'featured_count'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles.featured_count does not exist (0107_portava_featured.sql).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'updated_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles.updated_at does not exist; the writer stamps it.';
  END IF;
END $$;

-- ── The writer ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.portava_adjust_profile_counter(
  p_user_id uuid,
  p_column  text,
  p_delta   integer
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  v_new integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'portava_adjust_profile_counter: p_user_id is required';
  END IF;
  IF p_delta IS NULL THEN
    RAISE EXCEPTION 'portava_adjust_profile_counter: p_delta is required';
  END IF;

  -- THE ALLOWLIST. Checked before anything is formatted or executed.
  IF p_column NOT IN ('featured_count') THEN
    RAISE EXCEPTION 'portava_adjust_profile_counter: invalid column %', p_column;
  END IF;

  -- One statement. GREATEST(0, …) clamps at the floor inside the same
  -- expression that reads the value, so a decrement can never take the counter
  -- negative and can never be computed off a value another transaction has
  -- already moved. COALESCE covers a NULL column value even though the column
  -- is NOT NULL DEFAULT 0 today — a future ALTER dropping the NOT NULL must not
  -- turn every adjustment into a silent no-op.
  EXECUTE format(
    'UPDATE profiles
        SET %I = GREATEST(0, COALESCE(%I, 0) + $1),
            updated_at = NOW()
      WHERE id = $2
      RETURNING %I',
    p_column, p_column, p_column
  )
  INTO v_new
  USING p_delta, p_user_id;

  -- NULL means no row matched. Returned rather than raised: the caller is an
  -- admin route acting on a post whose author may have been deleted between the
  -- post read and this call, and that is a "nothing to count" outcome, not a
  -- failure of the featuring operation. The caller distinguishes the two — a
  -- NULL return is logged, an `error` is a failed write.
  RETURN v_new;
END;
$_$;

COMMENT ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) IS
  'Atomic single-statement adjustment of an allowlisted denormalised counter on public.profiles (today: featured_count only), clamped with GREATEST(0, col + delta). Replaces the read-modify-write increments in routes/adminFeatured.ts, which lose updates under concurrency. Returns the new value, or NULL when no profile row matched. SECURITY DEFINER, pinned search_path, service_role only.';

REVOKE ALL ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) FROM authenticated;
-- Unconditionally, BEFORE the grant below. See the header: Supabase's public
-- schema default privileges can hand service_role ALL at CREATE time, and a
-- grant that was never stated is a grant nobody can audit.
REVOKE ALL ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) FROM service_role;

GRANT EXECUTE ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) TO service_role;

-- ── Postconditions ────────────────────────────────────────────────────────────
-- Each of these asserts a claim the header makes. They run in the same
-- transaction as the DDL above deliberately: a failure here must roll the
-- function back, because a half-correct security posture is worse than none.
DO $$
DECLARE
  v_prosecdef boolean;
  v_config    text[];
  v_src       text;
  v_rejected  boolean;
  v_result    integer;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.prosrc
    INTO v_prosecdef, v_config, v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'portava_adjust_profile_counter';

  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: portava_adjust_profile_counter does not exist.';
  END IF;
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: portava_adjust_profile_counter must be SECURITY DEFINER.';
  END IF;

  -- Substring match rather than an exact array compare: Postgres preserves the
  -- SET text verbatim in proconfig and its quoting is not worth depending on.
  -- Matches the check in migrations 2199 and 2325.
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: portava_adjust_profile_counter must pin search_path.';
  END IF;

  -- The clamp is the whole point of the function; assert it is in the body and
  -- not merely in this file's prose.
  IF v_src NOT LIKE '%GREATEST(0,%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: portava_adjust_profile_counter lost its GREATEST(0, …) clamp.';
  END IF;

  -- The grant posture: service_role only.
  IF has_function_privilege('anon',
       'public.portava_adjust_profile_counter(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon must not hold EXECUTE on portava_adjust_profile_counter.';
  END IF;
  IF has_function_privilege('authenticated',
       'public.portava_adjust_profile_counter(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated must not hold EXECUTE on portava_adjust_profile_counter.';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.portava_adjust_profile_counter(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role must hold EXECUTE on portava_adjust_profile_counter.';
  END IF;

  -- THE ALLOWLIST ACTUALLY REJECTS. Not "the IN-list is present in the source"
  -- — the function is called with an authority column and must refuse. The uuid
  -- is the all-zero id, which matches no profile, so even a total failure of
  -- the allowlist writes nothing: this probe cannot damage a row.
  v_rejected := false;
  BEGIN
    PERFORM public.portava_adjust_profile_counter(
      '00000000-0000-0000-0000-000000000000'::uuid, 'role', 1);
  EXCEPTION WHEN OTHERS THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the column allowlist admitted ''role'' — portava_adjust_profile_counter is an arbitrary-column writer on the identity table.';
  END IF;

  -- AND IT ADMITS THE ONE COLUMN IT IS FOR. Same all-zero id, so the UPDATE
  -- matches no row and returns NULL; what is being asserted is that the call
  -- itself is accepted and reaches the UPDATE, which distinguishes a working
  -- allowlist from one that rejects everything.
  BEGIN
    v_result := public.portava_adjust_profile_counter(
      '00000000-0000-0000-0000-000000000000'::uuid, 'featured_count', 1);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: portava_adjust_profile_counter rejected its own allowlisted column: %', SQLERRM;
  END;
  IF v_result IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a counter adjustment against a non-existent profile returned % instead of NULL.', v_result;
  END IF;
END $$;

COMMIT;

-- ── ROLLBACK (manual; run as the migration owner) ─────────────────────────────
-- Reverses this file completely. Nothing else in the chain references the
-- function, and no data was written, so the drop is the whole reversal. The
-- routes fall back to their read-modify-write path when the RPC is absent, so
-- dropping this restores the old (lossy) behaviour rather than breaking the
-- admin routes.
--
--   BEGIN;
--   REVOKE ALL ON FUNCTION public.portava_adjust_profile_counter(uuid, text, integer) FROM service_role;
--   DROP FUNCTION IF EXISTS public.portava_adjust_profile_counter(uuid, text, integer);
--   COMMIT;
