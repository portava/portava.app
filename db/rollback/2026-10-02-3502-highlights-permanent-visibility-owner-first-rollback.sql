-- Rollback for 3502_highlights_permanent_visibility_owner_first.sql
--
-- ⚠ IT MAKES PERMANENT HIGHLIGHTS INVISIBLE AGAIN. This restores the top-level
-- `(expires_at > now())` conjunct ahead of the owner disjunct on both SELECT
-- policies of `public.highlights`. `NULL > now()` is NULL, and PostgreSQL
-- admits a row only when a PERMISSIVE policy's USING expression IS TRUE, so
-- after this runs any Highlight with a NULL expiry is selectable by NOBODY,
-- its own owner included. Measured, not argued: on a local database carrying
-- production's exact policy text, a PERMANENT Highlight returned 0 rows to its
-- owner, 0 to another signed-in user and 0 to anon.
--
-- THEREFORE: RUN 2975's ROLLBACK FIRST. The apply order is 3502 then 2975; the
-- reversal runs backwards through it. 2975's rollback removes every NULL
-- expiry, which is what makes this file safe. Running this one first reaches
-- the invisible-Highlight state through the exit instead of the entrance.
-- This file refuses to run while a NULL expiry exists, rather than trusting
-- the operator to have read this paragraph.
--
-- It is the exact inverse of 3502's transformation: per policy, the owner-first
-- head is swapped back for the measured production head and the two groups the
-- forward migration opened are closed again. Everything between the heads is
-- carried byte-for-byte, and the same masking equality 3502 uses proves it
-- before anything is written.
--
-- Run it only to reverse 3502 deliberately, never as routine cleanup.

BEGIN;

SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  spec       record;
  pol        record;
  old_qual   text;
  rest       text;
  new_qual   text;
  n_occ      int;
  n_done     int := 0;
  n_skipped  int := 0;
  n_null     bigint;
BEGIN
  -- Refusal, not advice: a NULL expiry under the restored policies is a row
  -- nobody can read.
  SELECT count(*) INTO n_null FROM public.highlights WHERE expires_at IS NULL;
  IF n_null > 0 THEN
    RAISE EXCEPTION '3502 rollback REFUSING: % Highlight(s) carry a NULL expiry. Restoring the top-level expiry conjunct would make every one of them selectable by nobody, its owner included. Run db/rollback/2026-10-02-2975-highlights-permanent-lifetime-rollback.sql first.', n_null;
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      (
        'highlights_select',
        '{public}'::name[],
        $oh$((deleted_at IS NULL) AND (expires_at > now()) AND ((owner_id = auth.uid()) OR ($oh$,
        $nh$((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND $nh$,
        ''::text
      ),
      (
        'highlights_select_active',
        '{authenticated}'::name[],
        $oh$((deleted_at IS NULL) AND (expires_at > now()) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ((owner_id = auth.uid()) OR $oh$,
        $nh$((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ($nh$,
        '))'::text
      )
    ) AS t(pname, want_roles, old_head, new_head, tail)
  LOOP
    SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check
      INTO pol
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 'highlights'
       AND p.policyname = spec.pname;
    IF NOT FOUND THEN
      RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: policy % does not exist on public.highlights.', spec.pname;
    END IF;
    old_qual := pol.qual;
    IF old_qual IS NULL THEN
      RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: policy % has a NULL qual, which a SELECT policy cannot.', spec.pname;
    END IF;

    -- Already in the production shape: a verified no-op, by exact prefix.
    IF left(old_qual, length(spec.old_head)) = spec.old_head THEN
      n_skipped := n_skipped + 1;
      RAISE NOTICE '3502 rollback: % already carries the production head; no change.', spec.pname;
      CONTINUE;
    END IF;

    IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE'
       OR pol.roles <> spec.want_roles OR pol.with_check IS NOT NULL THEN
      RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: % is not (SELECT, PERMISSIVE, TO %, no WITH CHECK) -- found cmd=% permissive=% roles=% with_check=%. Refusing to guess.',
        spec.pname, spec.want_roles, pol.cmd, pol.permissive, pol.roles, pol.with_check;
    END IF;

    IF left(old_qual, length(spec.new_head)) <> spec.new_head THEN
      RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: % begins with neither the owner-first head this reverses nor the production head it restores. Refusing to guess. Live qual: %',
        spec.pname, old_qual;
    END IF;
    n_occ := (length(old_qual) - length(replace(old_qual, spec.new_head, '')))
             / length(spec.new_head);
    IF n_occ <> 1 THEN
      RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: the owner-first head appears % time(s) in %, not once. Live qual: %', n_occ, spec.pname, old_qual;
    END IF;

    rest := substr(old_qual, length(spec.new_head) + 1);
    IF spec.tail <> '' THEN
      IF right(rest, length(spec.tail)) <> spec.tail THEN
        RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: % does not end with the two groups 3502 opened (%). Live qual: %', spec.pname, spec.tail, old_qual;
      END IF;
      rest := left(rest, length(rest) - length(spec.tail));
    END IF;
    IF rest = '' THEN
      RAISE EXCEPTION '3502 rollback PRECONDITION FAILED: % has nothing between the head and the tail, so there is no visibility logic to carry.', spec.pname;
    END IF;

    new_qual := spec.old_head || rest;

    -- Minimality, character for character, in both directions.
    IF replace(old_qual, rest, '<rest>') IS DISTINCT FROM spec.new_head || '<rest>' || spec.tail THEN
      RAISE EXCEPTION '3502 rollback POSTCONDITION FAILED (pre-write) on %: masking the carried remainder out of the LIVE qual did not leave exactly the owner-first head and tail. Refusing to write. live=% rest=%', spec.pname, old_qual, rest;
    END IF;
    IF replace(new_qual, rest, '<rest>') IS DISTINCT FROM spec.old_head || '<rest>' THEN
      RAISE EXCEPTION '3502 rollback POSTCONDITION FAILED (pre-write) on %: masking the carried remainder out of the REBUILT qual did not leave exactly the production head. Refusing to write. rebuilt=% rest=%', spec.pname, new_qual, rest;
    END IF;

    EXECUTE format('ALTER POLICY %I ON public.highlights USING (%s)', spec.pname, new_qual);
    n_done := n_done + 1;
    RAISE NOTICE '3502 rollback: % restored to the production head (% -> % characters).', spec.pname, length(old_qual), length(new_qual);
  END LOOP;

  RAISE NOTICE '3502 rollback: % policy(ies) restored, % already in the production shape.', n_done, n_skipped;
END
$$;

-- ── Postconditions: the top-level expiry conjunct is back on both policies ──
DO $post$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT policyname, qual FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'highlights' AND cmd = 'SELECT'
  LOOP
    IF position('(expires_at > now()) AND ' in r.qual) = 0 THEN
      RAISE EXCEPTION '3502 rollback postcondition FAILED: % does not carry the top-level expiry conjunct this file restores. Live qual: %', r.policyname, r.qual;
    END IF;
    IF position('(expires_at IS NULL)' in r.qual) <> 0 THEN
      RAISE EXCEPTION '3502 rollback postcondition FAILED: % still carries a NULL expiry arm, so 3502 was not fully reversed. Live qual: %', r.policyname, r.qual;
    END IF;
    n := n + 1;
  END LOOP;
  IF n <> 2 THEN
    RAISE EXCEPTION '3502 rollback postcondition FAILED: expected 2 SELECT policies on public.highlights, found %.', n;
  END IF;
  RAISE NOTICE '3502 rollback postconditions PASSED: both SELECT policies carry the top-level expiry conjunct again and neither carries a NULL expiry arm.';
END
$post$;

-- The applier wrote 3502's ledger row in 3502's own transaction; without this
-- delete the ledger would take 3502 as still applied and never re-apply it.
-- The repository's standard since 2026-09-28: every rollback removes its own
-- ledger row (docs/migrations.md).
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3502_highlights_permanent_visibility_owner_first.sql';

DO $ledger$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3502_highlights_permanent_visibility_owner_first.sql') THEN
    RAISE EXCEPTION '3502 rollback POSTCONDITION FAILED: the ledger still records 3502 as applied after the reversal.';
  END IF;
END
$ledger$;

COMMIT;
