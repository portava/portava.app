-- 2975_highlights_permanent_lifetime.sql
--
-- WHAT: `public.highlights.expires_at` becomes NULLABLE, and a single CHECK
-- constraint pins the one meaning a NULL expiry is allowed to have — the
-- Highlight is §4 PERMANENT. Nothing is created, nothing is dropped, no row is
-- written, no flag is flipped, no RLS policy is added, altered or dropped, and
-- no other column is touched.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2975
-- (Highlights & Memories).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY: PERMANENT IS NOT UNIMPLEMENTED, IT IS STRUCTURALLY IMPOSSIBLE
-- ══════════════════════════════════════════════════════════════════════════════
-- Highlights/Memories Development Architecture Spec v1 §4 names five
-- HighlightLifetime values — LIVE, DAY, TRIP, SEASONAL, PERMANENT — and §12
-- gives PERMANENT its behaviour: "Explicit or milestone-driven durable
-- Highlight."
--
-- Migration 2723 added `lifetime_class` to `public.highlights` and was applied
-- to production on 2026-09-15, so four of the five became storable. The fifth
-- did not, and 2723 says so in its own header at
-- `2723_highlight_class_lifecycle_and_pin.sql:33`: IT DOES NOT MAKE
-- `expires_at` nullable.
--
-- The census records the consequence at §O.3, and records it as the one row a
-- reader would expect to move with its four siblings and which deliberately did
-- not:
--
--     H98 | N | N | "DELIBERATELY NOT MOVED … PERMANENT is not representable no
--     matter what `lifetime_class` says, because `highlights.expires_at` is NOT
--     NULL and a PERMANENT Highlight is one with no expiry. Four of five moved;
--     the fifth is structurally impossible and stays N."
--
-- `services/highlights/highlightLifecycle.ts` says the same thing in code:
-- `representableLifetimeClasses({ lifetimeClassColumn: true, expiresAtNullable:
-- false })` returns PERMANENT in `unrepresentable` with the reason
-- "highlights.expires_at is NOT NULL; a PERMANENT Highlight has no expiry", and
-- `describeHighlightLifetime` grades a row claiming PERMANENT while carrying an
-- expiry as `invalid` rather than as PERMANENT. Neither of those changes here.
-- What changes is that the answer they give stops being "no" on production.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A CHECK CONSTRAINT AND NOT JUST A DROP NOT NULL
-- ══════════════════════════════════════════════════════════════════════════════
-- DROP NOT NULL on its own makes every Highlight in the product capable of
-- never expiring by accident. `public.highlights` is a 24-hour surface: every
-- read path filters on `expires_at`, and a row that arrives with a NULL expiry
-- because an INSERT omitted the column — a client bug, a partial write, a
-- future migration's DEFAULT change — would sit on those feeds forever with
-- nobody having chosen that, and nothing anywhere would call it an error.
--
-- So nullability is granted for exactly one declared reason and the constraint
-- says which:
--
--     expires_at IS NOT NULL  OR  lifetime_class = 'PERMANENT'
--
-- A NULL expiry is legal only on a row that has SAID it is permanent. An INSERT
-- that omits `expires_at` without naming the class is refused by the database
-- rather than served forever by the feeds. This is the same direction
-- `describeHighlightLifetime` already takes from the other side — it calls a
-- PERMANENT row carrying an expiry `invalid` — and after this migration the two
-- halves of that contradiction are both enforced, one in code and one in
-- storage.
--
-- Note what the constraint deliberately does NOT do: it does not require a
-- PERMANENT row to have a NULL expiry. A Highlight may be reclassified to
-- PERMANENT while still carrying the expiry it was created with, and the code
-- path that does so clears the expiry in the same statement. Requiring it here
-- would make that a two-statement operation with an illegal state in between.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- MEASURED BEFORE WRITING THIS
-- ══════════════════════════════════════════════════════════════════════════════
--   * `expires_at` is NOT NULL today: `baseline/20260819_baseline_structure.sql`
--     and `migrations/0026_highlights.sql:19`.
--   * `lifetime_class` EXISTS in production —
--     `lib/capability/snapshots/20260915-production-schema.json` lists it on
--     `public.highlights`, and `production-applied-migrations.json` records
--     2723 applied on 2026-09-15.
--   * NO ROW can violate the new constraint at apply time, because every
--     existing row has a NOT NULL `expires_at` by construction — the column is
--     NOT NULL until the statement above it runs. The constraint is therefore
--     added NOT VALID-free and validates instantly; there is no backfill and no
--     lock beyond the ALTER itself.
--   * This migration does NOT touch migration 2313 / PR #461, which also makes
--     this column nullable AND reintroduces a `trip_members` self-join that
--     applied migration 2530 removed. That migration must not be adopted; this
--     one does the nullable half and nothing else.
--
-- REVERSIBLE BY:
--   ALTER TABLE public.highlights DROP CONSTRAINT IF EXISTS highlights_permanent_has_no_expiry;
--   UPDATE public.highlights SET expires_at = now() + interval '24 hours' WHERE expires_at IS NULL;
--   ALTER TABLE public.highlights ALTER COLUMN expires_at SET NOT NULL;
-- The UPDATE is required and is not a no-op if any PERMANENT Highlight exists
-- by then; that is the cost of the reversal and it is named here rather than
-- discovered during one.
--
-- NOT APPLIED BY THIS LANE. Written only.

-- ── 1. The column becomes nullable ───────────────────────────────────────────
-- Idempotent: DROP NOT NULL on a column that is already nullable is a no-op.
ALTER TABLE public.highlights
  ALTER COLUMN expires_at DROP NOT NULL;

-- ── 2. And the nullability means exactly one thing ───────────────────────────
-- Idempotent through the DROP: ADD CONSTRAINT has no IF NOT EXISTS, and adding
-- the same named constraint twice is an error rather than a no-op. Dropping
-- first makes the pair re-runnable, and there is no window in which the table
-- is unconstrained for any other session because both statements are in one
-- transaction.
ALTER TABLE public.highlights
  DROP CONSTRAINT IF EXISTS highlights_permanent_has_no_expiry;

ALTER TABLE public.highlights
  ADD CONSTRAINT highlights_permanent_has_no_expiry CHECK (
    expires_at IS NOT NULL OR lifetime_class = 'PERMANENT'
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
--
-- Re-runnable standalone by `certify:migrations`: every assertion below reads
-- the CURRENT catalog or runs a probe that rolls itself back. There is no temp
-- table, no before/after comparison and no dependence on this session having
-- run the statements above.
-- ═══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_is_nullable   boolean;
  v_has_check     boolean;
  v_null_refused  boolean;
  v_perm_accepted boolean;
  v_probe_rows    integer;
  v_has_subject   boolean;
BEGIN
  -- 1. The column is nullable. Read from the catalog, not inferred from the
  --    statement having run without error.
  SELECT a.attnotnull = false INTO v_is_nullable
  FROM pg_attribute a
  WHERE a.attrelid = 'public.highlights'::regclass
    AND a.attname = 'expires_at'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_is_nullable IS NULL THEN
    RAISE EXCEPTION '2975 postcondition 1 FAILED: public.highlights.expires_at does not exist';
  END IF;
  IF NOT v_is_nullable THEN
    RAISE EXCEPTION '2975 postcondition 1 FAILED: public.highlights.expires_at is still NOT NULL, so PERMANENT remains unrepresentable — which is the whole point of this migration';
  END IF;

  -- 2. The constraint exists AND is validated. An unvalidated constraint is
  --    enforced for new rows and is silently absent for the ones already there,
  --    which is the failure mode worth asserting against rather than the
  --    typo-level "is it spelled right".
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.highlights'::regclass
      AND conname = 'highlights_permanent_has_no_expiry'
      AND contype = 'c'
      AND convalidated
  ) INTO v_has_check;

  IF NOT v_has_check THEN
    RAISE EXCEPTION '2975 postcondition 2 FAILED: constraint highlights_permanent_has_no_expiry is missing or NOT VALID. Without it, DROP NOT NULL lets any Highlight never expire by accident on a 24-hour surface.';
  END IF;

  -- 3 AND 4 NEED A SUBJECT ROW, AND A DATABASE THAT HAS NONE IS NOT A FAILURE.
  --
  -- Both probes insert `SELECT … FROM public.profiles LIMIT 1`, so on a database
  -- whose `profiles` table is EMPTY the INSERT matches nothing, inserts ZERO
  -- ROWS, and raises nothing at all. The original code read that silence as the
  -- row having been ACCEPTED and failed postcondition 3 — on a database where
  -- the constraint is present, validated and perfectly correct.
  --
  -- That is not a hypothetical. It is exactly what happens on a fresh database,
  -- which is what `api-server · kernel SQL executed on a throwaway database`
  -- builds, and this file could not be applied to one. Reproduced before fixing:
  -- with the source emptied, `GET DIAGNOSTICS ROW_COUNT` is 0 and
  -- `v_null_refused` is false, which is the reported failure exactly.
  --
  -- THE FIX IS NOT TO LOOSEN THE ASSERTION. `IS DISTINCT FROM true` stays, and a
  -- zero-row probe is never read as a pass OR as a refusal — it is read as
  -- "this probe did not run", which is the truth. Two things enforce that:
  --
  --   * the probes are guarded on a subject row EXISTING, and are SKIPPED WITH A
  --     LOUD WARNING when there is none. 2921 sets this precedent in this
  --     repository for the same reason ("seam-refusal probe SKIPPED — profiles
  --     is empty on this database"), and postconditions 1, 2 and 5 still run
  --     everywhere: 2 is the one that proves the constraint exists AND is
  --     VALIDATED, so an empty database still refuses a broken migration.
  --   * ROW_COUNT is checked INSIDE each probe anyway, so if the guard is ever
  --     removed or the source changes, a vacuous probe raises rather than
  --     quietly reporting whatever the uninitialised path happens to say. A
  --     silent vacuous pass is the failure mode worth spending four lines on.
  SELECT EXISTS (SELECT 1 FROM public.profiles) INTO v_has_subject;

  IF NOT v_has_subject THEN
    RAISE WARNING '2975: postconditions 3 and 4 SKIPPED — public.profiles is empty on this database, so the probe INSERT would match no row and prove nothing. 1, 2 and 5 ran: expires_at is nullable and highlights_permanent_has_no_expiry exists and is VALIDATED. The refusal and acceptance behaviour is unproven HERE and is proven on any database carrying a profile.';
  ELSE

  -- 3. THE CONSTRAINT ACTUALLY REFUSES. Asserting that a CHECK exists is worth
  --    little — the question is whether a NULL expiry without a PERMANENT class
  --    is turned away. So this INSERTS one and requires the failure. The whole
  --    probe runs inside a subtransaction that is rolled back on BOTH paths, so
  --    no row survives either outcome.
  BEGIN
    INSERT INTO public.highlights (id, owner_id, media_url, media_type, visibility, expires_at, lifetime_class)
    SELECT
      '00000000-0000-4000-8000-000000002975'::uuid,
      p.id,
      'https://example.invalid/2975-postcondition.jpg',
      'image/jpeg',
      'private',
      NULL,
      'DAY'
    FROM public.profiles p
    LIMIT 1;
    GET DIAGNOSTICS v_probe_rows = ROW_COUNT;
    IF v_probe_rows = 0 THEN
      RAISE EXCEPTION '2975 postcondition 3 COULD NOT RUN: the probe insert matched no source row, so nothing was offered to the constraint. This is not an acceptance and must never be reported as one.';
    END IF;
    v_null_refused := false;   -- it was accepted: the constraint is not effective
    RAISE EXCEPTION 'rollback_2975_negative' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN v_null_refused := true;
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_2975_negative' THEN RAISE; END IF;
    WHEN OTHERS THEN RAISE;
  END;

  IF v_null_refused IS DISTINCT FROM true THEN
    RAISE EXCEPTION '2975 postcondition 3 FAILED: a Highlight with a NULL expires_at and lifetime_class = DAY was ACCEPTED. A row that never expires on a 24-hour surface would sit on every feed forever with nobody having chosen that.';
  END IF;

  -- 4. THE POSITIVE CONTROL, without which 3 is worth nothing. A constraint
  --    that refuses EVERY null expiry satisfies 3 perfectly and makes PERMANENT
  --    exactly as impossible as it was before this migration. So the same
  --    insert is made again WITH the class named, and this time a refusal is
  --    the failure.
  BEGIN
    INSERT INTO public.highlights (id, owner_id, media_url, media_type, visibility, expires_at, lifetime_class)
    SELECT
      '00000000-0000-4000-8000-000000002975'::uuid,
      p.id,
      'https://example.invalid/2975-postcondition.jpg',
      'image/jpeg',
      'private',
      NULL,
      'PERMANENT'
    FROM public.profiles p
    LIMIT 1;
    GET DIAGNOSTICS v_probe_rows = ROW_COUNT;
    IF v_probe_rows = 0 THEN
      RAISE EXCEPTION '2975 postcondition 4 COULD NOT RUN: the positive control matched no source row, so it proved nothing. Reporting it as an acceptance would make postcondition 3 worthless, which is the whole reason this control exists.';
    END IF;
    v_perm_accepted := true;
    RAISE EXCEPTION 'rollback_2975_positive' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN v_perm_accepted := false;
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_2975_positive' THEN RAISE; END IF;
    WHEN OTHERS THEN RAISE;
  END;

  IF v_perm_accepted IS DISTINCT FROM true THEN
    RAISE EXCEPTION '2975 postcondition 4 FAILED: a PERMANENT Highlight with no expiry was REFUSED. The constraint is too strict and PERMANENT is still unrepresentable, which is the state this migration exists to end.';
  END IF;

  END IF;  -- v_has_subject

  -- 5. Nothing was left behind by either probe. Both raised inside their own
  --    block so the inserts are rolled back, but a future edit that removed a
  --    RAISE would leak a row onto a live surface, and that is exactly the kind
  --    of change a postcondition should catch rather than a reviewer.
  IF EXISTS (
    SELECT 1 FROM public.highlights
    WHERE id = '00000000-0000-4000-8000-000000002975'::uuid
  ) THEN
    RAISE EXCEPTION '2975 postcondition 5 FAILED: a postcondition probe row survived. It is on the live Highlights surface right now.';
  END IF;

  RAISE NOTICE '2975 postconditions PASSED: expires_at is nullable, the PERMANENT-only constraint is validated, it refuses a NULL expiry without the class and accepts one with it, and no probe row survived.';
END
$post$;
