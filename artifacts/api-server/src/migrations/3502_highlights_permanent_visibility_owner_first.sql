-- 3502_highlights_permanent_visibility_owner_first.sql
--
-- Both SELECT policies on `public.highlights` are restructured to the
-- owner-first / NULL-arm shape: the owner disjunct is evaluated FIRST, and the
-- expiry test — given a NULL arm — moves into the non-owner arm together with
-- the blocked guard. ONE head fragment of ONE policy changes per policy; every
-- other character of each qual is carried across byte-for-byte, and the
-- migration proves that before it writes.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane 3502
-- (Highlights & Memories). Read 2530 first — this file follows its technique
-- rather than a DROP/CREATE, for the same reason: the two databases disagree.
--
-- Policy-only: it rewrites two policies. It creates no function, and touches no
-- table, column, constraint, grant, index or row. Idempotent, with an
-- early-return guard PER POLICY, because portava-ci already carries the target
-- shape while production does not — this file must be a no-op on one and a real
-- change on the other, and must not error on either.
--
-- NOT APPLIED BY THIS LANE. Written only.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS IS A PREREQUISITE FOR 2975 ON PRODUCTION, NOT A FOLLOW-UP
-- ══════════════════════════════════════════════════════════════════════════════
-- `2975_highlights_permanent_lifetime.sql` makes `public.highlights.expires_at`
-- NULLABLE and pins the NULL to `lifetime_class = 'PERMANENT'`. Its header at
-- `2975_highlights_permanent_lifetime.sql:6` states, correctly for what that
-- file does, that "no RLS policy is added, altered or dropped." The newest
-- migration on this branch touching `highlights_select*` is 2530.
--
-- `NULL > now()` is NULL, not TRUE. Both SELECT policies on `public.highlights`
-- are PERMISSIVE, so a row must satisfy at least one of them, and PostgreSQL
-- admits a row only when a policy's USING expression IS TRUE — NULL is a
-- refusal. On production BOTH policies carry `(expires_at > now())` as a
-- TOP-LEVEL AND conjunct, ahead of the owner disjunct. So after 2975 alone, a
-- PERMANENT Highlight — the row 2975 exists to make storable — would be
-- selectable by NOBODY, its own owner included, and therefore also not
-- insertable or updatable through PostgREST, which reads the row back.
--
-- MEASURED, NOT INFERRED (2026-10-02, read-only, both databases):
--
--   production  ajrurzioarfkagpuxfnb
--     expires_at           attnotnull = true  (is_nullable = NO)
--     2975 in ledger       NO  (0 rows matching '%2975%' of 469 ledger rows)
--     policies             5 on public.highlights, 0 RESTRICTIVE
--     SELECT policies      highlights_select        PERMISSIVE  TO {public}
--                          highlights_select_active PERMISSIVE  TO {authenticated}
--     both quals carry `(expires_at > now())` as a top-level AND conjunct
--     ahead of the owner disjunct.
--     On production's OWN planner:
--       ((true) AND (NULL::timestamptz > now()) AND (true)) IS TRUE  =  false
--     No RESTRICTIVE policy admits it either, because there is none.
--
--   portava-ci  hwokxgbmezheskbzskfr
--     expires_at           attnotnull = false (is_nullable = YES)
--     2975 in ledger       YES (hand-applied 2026-09-16)
--     both SELECT quals LEAD with the owner disjunct and carry
--     `((expires_at IS NULL) OR (expires_at > now()))` inside the non-owner arm.
--
-- CI IS GREEN BY CONSTRUCTION, NOT BY CORRECTNESS. The CI shape is migration
-- 2313_highlights_permanent from PR #461 — UNMERGED, now closed — hand-applied
-- to portava-ci on 2026-09-07 (`supabase_migrations.schema_migrations` version
-- `20260907024317`, confirmed present 2026-10-02; note the table is in the
-- `supabase_migrations` schema, not `public`). 2530 records both databases'
-- shapes from a 2026-09-07 dry run at
-- `2530_highlights_trip_only_accepted_crew.sql:52-60`; both are unchanged today
-- except that production's trip_only branch now routes through
-- `authz.shares_accepted_trip(owner_id)`, which is 2530 itself having been
-- applied (production ledger `20260907223359`).
--
-- APPLY ORDER ON PRODUCTION: 3502 BEFORE 2975. The band cannot express that in
-- the filename — every prefix below 2975 is taken, and lexicographic replay
-- therefore puts 2975 first. On a fresh replay that window is harmless (nothing
-- is served mid-replay, and 2975's own postconditions insert and roll back
-- rather than read). On production it is not harmless and the order is a
-- runbook instruction, stated here because a filename cannot carry it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT A DROP/CREATE, AND WHY THE GUARD IS PER POLICY
-- ══════════════════════════════════════════════════════════════════════════════
-- Writing the target qual whole would mean choosing one database's text and
-- hoping the other matches it. 2530 refused that for this exact policy family
-- and the reason has not changed. So, per policy:
--
--   1. read the live qual out of `pg_policies`;
--   2. EARLY-RETURN when the qual ALREADY begins with this migration's own
--      replacement head — a verified no-op, not a guess, and additionally
--      checked for the absence of a top-level expiry conjunct;
--   3. otherwise require the declared head fragment to be an EXACT prefix and
--      to occur EXACTLY ONCE — any other shape is refused, never guessed at;
--   4. replace that one head; the remainder (`rest`) is not touched;
--   5. PROVE MINIMALITY CHARACTER-FOR-CHARACTER before writing: masking `rest`
--      out of the old qual must leave exactly the declared old head, and
--      masking it out of the new qual must leave exactly the declared new head
--      plus the declared tail. Both equalities also prove `rest` occurs once on
--      each side, so nothing inside the visibility logic — the public arm, the
--      circle arm, the trip_only arm — can have moved by one character;
--   6. DROP and re-CREATE with the same command, roles and permissiveness, each
--      read back from `pg_policies` and asserted, never assumed.
--
-- DERIVED, NOT TRANSCRIBED. The four head constants below were derived by
-- diffing production's measured quals against portava-ci's measured quals and
-- checking that `new_head || rest || tail` reproduces CI's stored text
-- CHARACTER FOR CHARACTER for both policies — 558 and 478 characters, equal,
-- not merely equivalent. The same identity is asserted again in
-- `src/test/highlightsOwnerFirstSelectShape.test.ts` against the measured
-- fixtures, so a future edit to a constant here fails a test rather than a
-- database.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE trip_only BRANCH IS CARRIED, NEVER RE-EMITTED
-- ══════════════════════════════════════════════════════════════════════════════
-- `highlights_select_active`'s trip_only branch must read exactly
--
--     ((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))
--
-- and NEVER the `trip_members tm1 JOIN trip_members tm2` self-join. That
-- self-join admitted pending invitees and removed members; 2530 removed it from
-- production on 2026-09-07, and `docs/architecture/blocker-ledger.md:22` marks
-- the blocker **CLOSED** ("Re-read on production 2026-09-08: the `tm1 JOIN tm2`
-- self-join shape is gone") while warning in the same cell that "PR #461's
-- `2313` restores the self-join byte-for-byte, so merging it would reopen
-- this". Confirmed by reading that file, and confirmed again by reading
-- production's live qual on 2026-10-02: the branch is the helper call.
--
-- Because this migration CARRIES `rest` rather than re-emitting it, the branch
-- cannot regress by construction — there is no code path here that writes a
-- trip_only predicate. It is asserted anyway, both as a positive (the branch
-- text appears exactly once) and as a negative (no policy on `highlights`
-- mentions `trip_members`), because "cannot happen by construction" is the
-- claim an assertion is for.
--
-- `highlights_select` has no trip_only arm and never had one (`2033`'s header:
-- "No trip_id in live schema -> trip_only branch omitted"), so the positive
-- assertion is declared per policy rather than applied blindly to both.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS PROVED AFTER THE WRITE, AND HOW
-- ══════════════════════════════════════════════════════════════════════════════
-- A qual that LOOKS right is not evidence that a row is visible. So the
-- postconditions are three, in increasing strength:
--
--   $truth$  A TRUTH TABLE EVALUATED BY THE SERVER, over the live qual read
--            back from `pg_policies`, against a synthetic one-row relation
--            aliased `highlights`. Six rows of truth table x two policies.
--            Needs no fixture row and no DDL, so it runs on an EMPTY database
--            and on production today, where `expires_at` is still NOT NULL and
--            a NULL expiry cannot be stored at all. This is how the NULL-expiry
--            case is established BEFORE 2975 lands.
--
--   $probe$  A REAL RLS PROBE: real rows inserted, `SET LOCAL ROLE` to
--            `authenticated` and to `anon`, `request.jwt.claim.sub` /
--            `request.jwt.claims` set the way PostgREST sets them, and an
--            actual `SELECT` for each case. Everything is inside a
--            subtransaction that is rolled back on every path. Guarded on
--            three profiles existing and SKIPPED WITH A LOUD WARNING when they
--            do not (2921/2975 precedent) — and the NULL-expiry ROWS are
--            skipped, loudly, while `expires_at` is still NOT NULL, because
--            they cannot be inserted. $truth$ covers those cases everywhere.
--
--   $post$   An ASSERTION-ONLY catalog re-read, re-runnable standalone by
--            `certify:migrations` (no mutation keyword, no EXECUTE), so the
--            shape claim is checkable after the commit and forever after.
--
-- A probe that cannot run is never reported as a pass. `$truth$` raises if the
-- qual it read back is missing, if a case's verdict is not the expected
-- boolean, or if any case could not be evaluated.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- RED BEFORE GREEN
-- ══════════════════════════════════════════════════════════════════════════════
-- `src/test/db/highlightsPermanentOwnerFirst.db.test.ts` is the executing
-- witness. It runs against `scripts/local-db/up.sh`'s throwaway PostgreSQL,
-- which restores production's baseline and replays the canonical chain, so the
-- quals it starts from are byte-identical to production's (verified
-- 2026-10-02: both 532/448-character quals matched production's character for
-- character).
--
--   WITHOUT this migration (LOCAL_DB_TO=3502, the documented exclusive upper
--   bound that stops the replay before this file):
--     6 pass, 5 FAIL — H1a the owner cannot see their own PERMANENT
--     (NULL-expiry) Highlight; H1b the owner cannot see their own EXPIRED
--     Highlight; H2a a non-owner cannot see a public PERMANENT Highlight; and
--     H3 x2, both policies' stored quals failing the owner-first shape.
--
--   WITH this migration (full chain):
--     11 pass, 0 fail.
--
-- `src/test/highlightsOwnerFirstSelectShape.test.ts` is the DB-free witness: it
-- re-derives the transformation from THIS FILE's own constants and requires it
-- to turn production's measured qual into portava-ci's measured qual character
-- for character, and it evaluates the six-case truth table under Kleene
-- three-valued logic over both quals, requiring production's qual to get
-- exactly three of the six cases WRONG. Measured:
--
--   this file absent                               1 pass, 10 FAIL
--   this file as committed                        11 pass,  0 fail
--   one character (a trailing space) removed from
--   highlights_select's new_head constant          9 pass,  2 FAIL (S3, S5)
--
-- The last line is the negative case that makes the middle one worth reporting:
-- the suite is sensitive to a single character of the constant it checks.
--
-- APPLY-TIME EVIDENCE, by execution rather than by reading (2026-10-02):
--
--   * on a hand-built PostgreSQL 16 carrying production's exact policy text and
--     production's NOT NULL expires_at: before, 3 of the 6 truth-table cases
--     are wrong on BOTH policies (owner + NULL expiry, owner + past expiry,
--     non-owner + NULL expiry); after, 0 are. The stored quals come out
--     558 and 478 characters with md5 3226a69f019cce3113175c48bb1b81d1 and
--     ff90ce3d9e6608e49caf38e692e28cb5 — BYTE-IDENTICAL to the quals read off
--     portava-ci the same day. Policy count 5 before and after; 0 highlight
--     rows and 0 block rows survived the probe.
--   * a SECOND apply on that same database reports both policies already in the
--     target shape, changes nothing, and exits 0 — which is the portava-ci path.
--   * on scripts/local-db's baseline + chain replay (where 2975 HAS run, so
--     expires_at is nullable): all 8 real-RLS probe cases ran and passed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * It does NOT make `expires_at` nullable. That is 2975's statement and this
--     file must be applicable BEFORE it.
--   * It does NOT touch `public.stories`. `stories.expires_at` is NOT NULL on
--     both databases and no migration proposes otherwise, so stories do not
--     share the defect and bundling them would widen a policy change to a
--     surface with no measurement behind it.
--   * It does NOT touch application code, and it does not need to: MEASURED on
--     this tree 2026-10-02, `routes/highlights.ts` has NO bare
--     `.gt("expires_at", now)`. All three of its expiry filters (`:983`,
--     `:1183`, `:2709`) route through the `NOT_EXPIRED` helper at
--     `routes/highlights.ts:145`, which emits
--     `expires_at.is.null,expires_at.gt.<now>` under `.or(...)` — already
--     NULL-aware — and whose own header at `:134-145` gives this exact reason
--     ("`NULL > now` is NULL, which is not TRUE, so a PERMANENT Highlight would
--     silently vanish from every feed the moment the migration landed").
--
--     The one application-layer site that IS affected is elsewhere:
--     `services/telegraph/shareables.ts:626-627` does
--     `Date.parse(String(r.expires_at ?? ""))` and returns
--     `UNAVAILABLE("unknown")` when that is not finite, so after 2975 a shared
--     PERMANENT Highlight renders as an unavailable card. Its header at `:599`
--     states "`expires_at` is NOT NULL on the table" as its premise, which is
--     true today and stops being true when 2975 lands. That site FAILS CLOSED
--     (it hides a card rather than leaking one), it is owned by Telegraph
--     rather than by this lane, and this migration is not meaningless without
--     it: the direct-PostgREST path is the one RLS owns, and `anon` and
--     `authenticated` both hold SELECT on `public.highlights` on both databases
--     (verified 2026-10-02). It is reported, not fixed here.
--
-- DEPENDS ON: 2530 (production's trip_only branch already routes through
-- `authz.shares_accepted_trip`). It does not call the helper itself — it only
-- carries the branch — but a database that has not had 2530 applied has a
-- different `rest`, and this migration will refuse rather than guess.

BEGIN;

-- pg_policies deparses expressions under the CURRENT search_path. With public
-- on it, `viewer_is_blocked` and the bare table names come back unqualified and
-- `authz.*` / `auth.*` come back qualified, which is the text the constants
-- below were measured against. 2530 pins it for the same reason.
SET LOCAL search_path = public, pg_catalog;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE REWRITE
-- ═══════════════════════════════════════════════════════════════════════════
DO $rewrite$
DECLARE
  TRIP_BRANCH constant text :=
    $tb$((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))$tb$;
  TOP_EXPIRY  constant text := $te$) AND (expires_at > now()) AND $te$;
  NULL_ARM    constant text := $na$((expires_at IS NULL) OR (expires_at > now()))$na$;
  OWNER_FIRST constant text := $of$((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR $of$;

  spec       record;
  pol        record;
  old_qual   text;
  new_qual   text;
  rest       text;
  n_occ      int;
  n_before   int;
  n_after    int;
  n_changed  int := 0;
  n_skipped  int := 0;
BEGIN
  -- ── Preconditions ─────────────────────────────────────────────────────────
  IF to_regclass('public.highlights') IS NULL THEN
    RAISE EXCEPTION '3502 PRECONDITION FAILED: public.highlights is missing.';
  END IF;
  IF to_regprocedure('authz.shares_accepted_trip(uuid)') IS NULL THEN
    RAISE EXCEPTION '3502 PRECONDITION FAILED: authz.shares_accepted_trip(uuid) is missing -- apply 2337 and 2530 first. This migration carries the trip_only branch rather than writing it, so a database without the helper has a different qual and must not be guessed at.';
  END IF;

  SELECT count(*) INTO n_before
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'highlights';

  FOR spec IN
    SELECT * FROM (VALUES
      -- highlights_select -- TO PUBLIC. Its blocked guard is ALREADY inside the
      -- non-owner arm; only the expiry test moves, and it gains a NULL arm.
      (
        'highlights_select',
        ''::text,
        '{public}'::name[],
        $oh$((deleted_at IS NULL) AND (expires_at > now()) AND ((owner_id = auth.uid()) OR ($oh$,
        $nh$((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND $nh$,
        ''::text,
        false
      ),
      -- highlights_select_active -- TO authenticated. Here BOTH the expiry test
      -- and the blocked guard are top-level conjuncts and both move into the
      -- non-owner arm, which is why this head is the longer of the two and why
      -- its replacement opens two groups the old head did not (tail = '))').
      (
        'highlights_select_active',
        'TO authenticated'::text,
        '{authenticated}'::name[],
        $oh$((deleted_at IS NULL) AND (expires_at > now()) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ((owner_id = auth.uid()) OR $oh$,
        $nh$((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ($nh$,
        '))'::text,
        true
      )
    ) AS t(pname, to_clause, want_roles, old_head, new_head, tail, want_trip)
  LOOP
    SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check
      INTO pol
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 'highlights'
       AND p.policyname = spec.pname;
    IF NOT FOUND THEN
      RAISE EXCEPTION '3502 PRECONDITION FAILED: policy % does not exist on public.highlights.', spec.pname;
    END IF;
    old_qual := pol.qual;
    IF old_qual IS NULL THEN
      RAISE EXCEPTION '3502 PRECONDITION FAILED: policy % has a NULL qual, which a SELECT policy cannot.', spec.pname;
    END IF;

    -- ── Early return, PER POLICY ────────────────────────────────────────────
    -- portava-ci already carries this exact shape (2313, hand-applied
    -- 2026-09-07). The test is an EXACT PREFIX match against the very constant
    -- this migration would write, so a skip cannot be a near-miss, and it is
    -- corroborated by the absence of a top-level expiry conjunct rather than
    -- taken on the prefix alone.
    IF left(old_qual, length(spec.new_head)) = spec.new_head THEN
      IF position(TOP_EXPIRY in old_qual) <> 0 THEN
        RAISE EXCEPTION '3502 REFUSING: % begins with the owner-first head AND still carries a top-level expiry conjunct (%). That is a shape this migration was not measured against. Live qual: %',
          spec.pname, TOP_EXPIRY, old_qual;
      END IF;
      IF position(NULL_ARM in old_qual) = 0 THEN
        RAISE EXCEPTION '3502 REFUSING: % begins with the owner-first head but has no NULL expiry arm (%). Live qual: %',
          spec.pname, NULL_ARM, old_qual;
      END IF;
      n_skipped := n_skipped + 1;
      RAISE NOTICE '3502: % is already owner-first with a NULL expiry arm and carries no top-level expiry conjunct; no change. (This is the portava-ci state.)', spec.pname;
      CONTINUE;
    END IF;

    -- ── Shape refusal, not shape guessing ──────────────────────────────────
    IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE'
       OR pol.roles <> spec.want_roles OR pol.with_check IS NOT NULL THEN
      RAISE EXCEPTION '3502 PRECONDITION FAILED: % is not (SELECT, PERMISSIVE, TO %, no WITH CHECK) -- found cmd=% permissive=% roles=% with_check=%. Refusing to guess, because re-emitting it would be the one way this migration could silently widen a policy.',
        spec.pname, spec.want_roles, pol.cmd, pol.permissive, pol.roles, pol.with_check;
    END IF;

    IF left(old_qual, length(spec.old_head)) <> spec.old_head THEN
      RAISE EXCEPTION '3502 PRECONDITION FAILED: % does not BEGIN with the measured head fragment. Expected prefix: % || Live qual: %',
        spec.pname, spec.old_head, old_qual;
    END IF;
    -- Occurrence count, so the head is unambiguous rather than merely present.
    n_occ := (length(old_qual) - length(replace(old_qual, spec.old_head, '')))
             / length(spec.old_head);
    IF n_occ <> 1 THEN
      RAISE EXCEPTION '3502 PRECONDITION FAILED: the head fragment appears % time(s) in %, not once. Live qual: %',
        n_occ, spec.pname, old_qual;
    END IF;

    rest := substr(old_qual, length(spec.old_head) + 1);
    IF rest = '' THEN
      RAISE EXCEPTION '3502 PRECONDITION FAILED: % has nothing after the head fragment, so there is no visibility logic to carry.', spec.pname;
    END IF;

    new_qual := spec.new_head || rest || spec.tail;

    -- ── Minimality, character for character ────────────────────────────────
    -- Masking `rest` out of each side must leave EXACTLY the declared scaffold.
    -- Each equality also proves `rest` occurs exactly once on its side: a second
    -- occurrence would be replaced too and the equality would fail. Together
    -- they say that no character outside the two declared heads (and the
    -- declared tail) differs, so the public arm, the circle arm and the
    -- trip_only arm are carried byte-for-byte.
    IF replace(old_qual, rest, '<rest>') IS DISTINCT FROM spec.old_head || '<rest>' THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: masking the carried remainder out of the OLD qual did not leave exactly the declared old head. Refusing to write. old=% rest=%',
        spec.pname, old_qual, rest;
    END IF;
    IF replace(new_qual, rest, '<rest>') IS DISTINCT FROM spec.new_head || '<rest>' || spec.tail THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: masking the carried remainder out of the NEW qual did not leave exactly the declared new head plus tail. Refusing to write. new=%',
        spec.pname, new_qual;
    END IF;
    -- A rearrangement cannot change the parenthesis balance.
    IF (length(new_qual) - length(replace(new_qual, '(', '')))
       <> (length(new_qual) - length(replace(new_qual, ')', ''))) THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: the rewritten qual is not parenthesis-balanced: %',
        spec.pname, new_qual;
    END IF;
    -- The three structural claims this migration is FOR.
    IF left(new_qual, length(OWNER_FIRST)) <> OWNER_FIRST THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: the owner disjunct is not the FIRST thing evaluated after the soft-delete test. Expected prefix % got %',
        spec.pname, OWNER_FIRST, new_qual;
    END IF;
    IF position(TOP_EXPIRY in new_qual) <> 0 THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: the rewritten qual still carries a top-level expiry conjunct (%), so a NULL expiry would still refuse the row: %',
        spec.pname, TOP_EXPIRY, new_qual;
    END IF;
    IF position(NULL_ARM in new_qual) = 0 THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: the rewritten qual has no NULL expiry arm (%): %',
        spec.pname, NULL_ARM, new_qual;
    END IF;
    IF new_qual ~ 'trip_members' THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: the rewritten qual mentions trip_members. 2530 removed that self-join; nothing here may put it back: %',
        spec.pname, new_qual;
    END IF;
    IF spec.want_trip THEN
      IF (length(new_qual) - length(replace(new_qual, TRIP_BRANCH, '')))
         / length(TRIP_BRANCH) <> 1 THEN
        RAISE EXCEPTION '3502 POSTCONDITION FAILED (pre-write) on %: the trip_only branch is not present exactly once as %. Live qual: %',
          spec.pname, TRIP_BRANCH, new_qual;
      END IF;
    END IF;

    -- ── The write ──────────────────────────────────────────────────────────
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.highlights', spec.pname);
    EXECUTE format(
      'CREATE POLICY %I ON public.highlights FOR SELECT %s USING (%s)',
      spec.pname, spec.to_clause, new_qual
    );

    -- ── Read back, never assume ────────────────────────────────────────────
    SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check
      INTO pol
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 'highlights'
       AND p.policyname = spec.pname;
    IF NOT FOUND THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED: % was dropped and not re-created.', spec.pname;
    END IF;
    IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE'
       OR pol.roles <> spec.want_roles OR pol.with_check IS NOT NULL THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED: % was not re-created as (SELECT, PERMISSIVE, TO %, no WITH CHECK) -- found cmd=% permissive=% roles=% with_check=%.',
        spec.pname, spec.want_roles, pol.cmd, pol.permissive, pol.roles, pol.with_check;
    END IF;
    -- PostgreSQL re-deparses what it stored. The only difference permitted from
    -- what was written is whitespace; a clause that moved survives no
    -- normalisation. portava-ci's stored text is byte-identical to this
    -- construction, which is how the expectation is known rather than hoped.
    IF regexp_replace(pol.qual, '\s+', '', 'g')
       IS DISTINCT FROM regexp_replace(new_qual, '\s+', '', 'g') THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED: the stored qual for % differs from the written qual by more than whitespace. stored=% written=%',
        spec.pname, pol.qual, new_qual;
    END IF;
    IF left(pol.qual, length(OWNER_FIRST)) <> OWNER_FIRST
       OR position(TOP_EXPIRY in pol.qual) <> 0
       OR position(NULL_ARM in pol.qual) = 0
       OR pol.qual ~ 'trip_members' THEN
      RAISE EXCEPTION '3502 POSTCONDITION FAILED: the re-read qual for % does not satisfy owner-first / NULL-arm / no-top-level-expiry / no-trip_members: %',
        spec.pname, pol.qual;
    END IF;

    n_changed := n_changed + 1;
    RAISE NOTICE '3502: % restructured owner-first (% -> % characters).',
      spec.pname, length(old_qual), length(pol.qual);
  END LOOP;

  -- ── Table-wide postconditions ────────────────────────────────────────────
  SELECT count(*) INTO n_after
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'highlights';
  IF n_after <> n_before THEN
    RAISE EXCEPTION '3502 POSTCONDITION FAILED: the policy count on public.highlights changed from % to %.', n_before, n_after;
  END IF;
  IF n_changed + n_skipped <> 2 THEN
    RAISE EXCEPTION '3502 POSTCONDITION FAILED: % changed + % skipped is not the two SELECT policies this migration owns. A loop that visited neither would otherwise report success having done nothing.',
      n_changed, n_skipped;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'highlights'
       AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%trip_members%'
  ) THEN
    RAISE EXCEPTION '3502 POSTCONDITION FAILED: a policy on public.highlights still references trip_members.';
  END IF;

  RAISE NOTICE '3502: % policy(ies) restructured, % already in the target shape.', n_changed, n_skipped;
END
$rewrite$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE TRUTH TABLE, EVALUATED BY THE SERVER OVER THE LIVE QUALS
--
-- No fixture row, no DDL, no write. The live qual is read back out of
-- pg_policies and evaluated against a synthetic one-row relation ALIASED
-- `highlights`, which is what lets the NULL-expiry rows be tested on a database
-- whose `expires_at` column is still NOT NULL — i.e. production, today, before
-- 2975. `auth.uid()` is driven through both GUCs real Supabase auth.uid() reads.
--
-- Six cases x two policies. The expectation per case is the UNION of the two
-- PERMISSIVE policies for a signed-in viewer, so each policy is asserted
-- separately and the union is asserted too.
-- ═══════════════════════════════════════════════════════════════════════════
DO $truth$
DECLARE
  v_owner  constant uuid := '00000000-0000-4000-8000-000000003502';
  v_other  constant uuid := '00000000-0000-4000-8000-000000003503';
  q_sel    text;
  q_act    text;
  c        record;
  got_sel  boolean;
  got_act  boolean;
  n_cases  int := 0;
BEGIN
  SELECT qual INTO q_sel FROM pg_policies
   WHERE schemaname='public' AND tablename='highlights' AND policyname='highlights_select';
  IF q_sel IS NULL THEN
    RAISE EXCEPTION '3502 truth table COULD NOT RUN: highlights_select has no qual to evaluate. A truth table that evaluated nothing must never be reported as a pass.';
  END IF;
  SELECT qual INTO q_act FROM pg_policies
   WHERE schemaname='public' AND tablename='highlights' AND policyname='highlights_select_active';
  IF q_act IS NULL THEN
    RAISE EXCEPTION '3502 truth table COULD NOT RUN: highlights_select_active has no qual to evaluate.';
  END IF;

  FOR c IN
    SELECT * FROM (VALUES
      -- label                         viewer    expiry (NULL = permanent)      visibility   want
      ('owner + NULL expiry',          'owner',  NULL::timestamptz,             'private',   true ),
      ('owner + past expiry',          'owner',  now() - interval '2 hours',    'private',   true ),
      ('non-owner + NULL expiry',      'other',  NULL::timestamptz,             'public',    true ),
      ('non-owner + future expiry',    'other',  now() + interval '2 hours',    'public',    true ),
      ('non-owner + past expiry',      'other',  now() - interval '2 hours',    'public',    false),
      -- The blocked case. `blocks` is empty for these synthetic ids, so the
      -- guard cannot bite here; it is exercised for real in $probe$. What this
      -- row establishes is the OTHER half of the requirement -- that the
      -- blocked guard is reachable at all on the non-owner path, i.e. that a
      -- private Highlight is NOT handed to a non-owner by the restructure.
      ('non-owner + future, private',  'other',  now() + interval '2 hours',    'private',   false)
    ) AS t(label, viewer, expiry, visibility, want)
  LOOP
    n_cases := n_cases + 1;
    PERFORM set_config('request.jwt.claim.sub',
      CASE c.viewer WHEN 'owner' THEN v_owner::text ELSE v_other::text END, true);
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub',
        CASE c.viewer WHEN 'owner' THEN v_owner::text ELSE v_other::text END,
        'role', 'authenticated')::text, true);

    EXECUTE format(
      'SELECT (%s) IS TRUE FROM (SELECT %L::uuid AS owner_id, %L::timestamptz AS expires_at, NULL::timestamptz AS deleted_at, %L::text AS visibility) AS highlights',
      q_sel, v_owner, c.expiry, c.visibility) INTO got_sel;
    EXECUTE format(
      'SELECT (%s) IS TRUE FROM (SELECT %L::uuid AS owner_id, %L::timestamptz AS expires_at, NULL::timestamptz AS deleted_at, %L::text AS visibility) AS highlights',
      q_act, v_owner, c.expiry, c.visibility) INTO got_act;

    IF got_sel IS NULL OR got_act IS NULL THEN
      RAISE EXCEPTION '3502 truth table COULD NOT RUN for "%": the evaluation returned no row. Not a refusal and not an admission -- unknown, which fails.', c.label;
    END IF;
    IF got_sel <> c.want THEN
      RAISE EXCEPTION '3502 TRUTH TABLE FAILED on highlights_select, case "%": the policy says % and the contract says %. qual=%',
        c.label, got_sel, c.want, q_sel;
    END IF;
    IF got_act <> c.want THEN
      RAISE EXCEPTION '3502 TRUTH TABLE FAILED on highlights_select_active, case "%": the policy says % and the contract says %. qual=%',
        c.label, got_act, c.want, q_act;
    END IF;
    IF (got_sel OR got_act) <> c.want THEN
      RAISE EXCEPTION '3502 TRUTH TABLE FAILED on the PERMISSIVE union, case "%": % expected %.', c.label, (got_sel OR got_act), c.want;
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  IF n_cases <> 6 THEN
    RAISE EXCEPTION '3502 truth table COULD NOT RUN: % case(s) evaluated, not 6. A loop that visited no row would otherwise print a pass.', n_cases;
  END IF;
  RAISE NOTICE '3502 truth table PASSED: 6 cases x 2 policies evaluated on the live quals, including both NULL-expiry rows, which needed no fixture row and no column change.';
END
$truth$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE REAL RLS PROBE
--
-- Real rows, real roles, real SELECTs, everything rolled back. A qual that
-- evaluates correctly in isolation is still not evidence that PostgreSQL hands
-- the row to a signed-in viewer, which is what this establishes.
-- ═══════════════════════════════════════════════════════════════════════════
DO $probe$
DECLARE
  SENTINEL_PERM_PRIV constant uuid := '00000000-0000-4000-8000-000000035021';
  SENTINEL_PAST_PRIV constant uuid := '00000000-0000-4000-8000-000000035022';
  SENTINEL_PERM_PUB  constant uuid := '00000000-0000-4000-8000-000000035023';
  SENTINEL_FUT_PUB   constant uuid := '00000000-0000-4000-8000-000000035024';
  SENTINEL_PAST_PUB  constant uuid := '00000000-0000-4000-8000-000000035025';

  v_role_before   name := current_user;
  v_nullable      boolean;
  v_owner         uuid;
  v_viewer        uuid;
  v_blocker       uuid;
  v_n_profiles    int;
  v_ran           boolean := false;
  v_null_rows     boolean := false;
  -- results, recorded in plpgsql variables, which survive the rollback below
  r_owner_perm    int := -1;
  r_owner_past    int := -1;
  r_other_perm    int := -1;
  r_other_fut     int := -1;
  r_other_past    int := -1;
  r_blocked_fut   int := -1;
  r_anon_fut      int := -1;
  r_anon_past     int := -1;
  v_survivors     int;
BEGIN
  SELECT a.attnotnull = false INTO v_nullable
    FROM pg_attribute a
   WHERE a.attrelid = 'public.highlights'::regclass AND a.attname = 'expires_at'
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_nullable IS NULL THEN
    RAISE EXCEPTION '3502 probe COULD NOT RUN: public.highlights.expires_at does not exist.';
  END IF;

  SELECT count(*) INTO v_n_profiles FROM (SELECT 1 FROM public.profiles LIMIT 3) s;

  IF v_n_profiles < 3 THEN
    RAISE WARNING '3502: the REAL RLS PROBE was SKIPPED -- public.profiles holds % row(s) and the probe needs three distinct subjects (owner, viewer, blocker). It inserted nothing and proved nothing. The six-case TRUTH TABLE above still ran against the live quals on this database, including both NULL-expiry cases, and the rewrite''s own pre-write and read-back postconditions still ran. What is unproven HERE and is proven on any database carrying three profiles: that PostgreSQL actually hands the row over, and that the blocked guard actually bites.', v_n_profiles;
  ELSE
    IF NOT pg_has_role(current_user, 'authenticated', 'MEMBER')
       OR NOT pg_has_role(current_user, 'anon', 'MEMBER') THEN
      RAISE EXCEPTION '3502 probe COULD NOT RUN: % is not a member of both anon and authenticated, so the probe cannot assume either role and cannot establish whether the row is visible. Reporting that as a pass is the failure mode this migration exists to avoid. Fix: GRANT anon, authenticated TO %;', current_user, current_user;
    END IF;

    SELECT id INTO v_owner   FROM public.profiles ORDER BY id LIMIT 1;
    SELECT id INTO v_viewer  FROM public.profiles WHERE id <> v_owner ORDER BY id LIMIT 1;
    SELECT id INTO v_blocker FROM public.profiles WHERE id NOT IN (v_owner, v_viewer) ORDER BY id LIMIT 1;
    v_null_rows := v_nullable;

    BEGIN
      -- ── seed ────────────────────────────────────────────────────────────
      INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (v_blocker, v_owner);

      INSERT INTO public.highlights (id, owner_id, media_url, media_type, visibility, expires_at, lifetime_class)
      VALUES
        (SENTINEL_PAST_PRIV, v_owner, 'https://example.invalid/3502.jpg', 'image/jpeg', 'private', now() - interval '2 hours', 'DAY'),
        (SENTINEL_FUT_PUB,   v_owner, 'https://example.invalid/3502.jpg', 'image/jpeg', 'public',  now() + interval '2 hours', 'DAY'),
        (SENTINEL_PAST_PUB,  v_owner, 'https://example.invalid/3502.jpg', 'image/jpeg', 'public',  now() - interval '2 hours', 'DAY');

      IF v_null_rows THEN
        INSERT INTO public.highlights (id, owner_id, media_url, media_type, visibility, expires_at, lifetime_class)
        VALUES
          (SENTINEL_PERM_PRIV, v_owner, 'https://example.invalid/3502.jpg', 'image/jpeg', 'private', NULL, 'PERMANENT'),
          (SENTINEL_PERM_PUB,  v_owner, 'https://example.invalid/3502.jpg', 'image/jpeg', 'public',  NULL, 'PERMANENT');
      END IF;

      -- ── probe, as a signed-in viewer, through RLS ───────────────────────
      -- The owner.
      PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      IF v_null_rows THEN
        SELECT count(*) INTO r_owner_perm FROM public.highlights WHERE id = SENTINEL_PERM_PRIV;
      END IF;
      SELECT count(*) INTO r_owner_past FROM public.highlights WHERE id = SENTINEL_PAST_PRIV;
      EXECUTE 'RESET ROLE';

      -- A different signed-in viewer.
      PERFORM set_config('request.jwt.claim.sub', v_viewer::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      IF v_null_rows THEN
        SELECT count(*) INTO r_other_perm FROM public.highlights WHERE id = SENTINEL_PERM_PUB;
      END IF;
      SELECT count(*) INTO r_other_fut  FROM public.highlights WHERE id = SENTINEL_FUT_PUB;
      SELECT count(*) INTO r_other_past FROM public.highlights WHERE id = SENTINEL_PAST_PUB;
      EXECUTE 'RESET ROLE';

      -- The blocked viewer, on the row most likely to be visible.
      PERFORM set_config('request.jwt.claim.sub', v_blocker::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_blocker::text, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO r_blocked_fut FROM public.highlights WHERE id = SENTINEL_FUT_PUB;
      EXECUTE 'RESET ROLE';

      -- anon: only highlights_select (TO PUBLIC) can admit anything, which is
      -- what isolates that policy from highlights_select_active.
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      EXECUTE 'SET LOCAL ROLE anon';
      SELECT count(*) INTO r_anon_fut  FROM public.highlights WHERE id = SENTINEL_FUT_PUB;
      SELECT count(*) INTO r_anon_past FROM public.highlights WHERE id = SENTINEL_PAST_PUB;
      EXECUTE 'RESET ROLE';

      v_ran := true;
      -- Roll the whole probe back. plpgsql variables are memory, not database
      -- state, so every count above survives this and the rows do not.
      RAISE EXCEPTION 'rollback_3502_probe' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM <> 'rollback_3502_probe' THEN RAISE; END IF;
      WHEN OTHERS THEN RAISE;
    END;

    -- The subtransaction abort reverts SET LOCAL ROLE; assert rather than hope.
    IF current_user <> v_role_before THEN
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION '3502 probe FAILED: the session is still acting as % after the probe rolled back (was %).', current_user, v_role_before;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{}', true);

    IF NOT v_ran THEN
      RAISE EXCEPTION '3502 probe COULD NOT RUN: it did not reach the end of its own body, so none of the counts below mean anything.';
    END IF;

    -- ── the assertions ─────────────────────────────────────────────────────
    IF v_null_rows THEN
      IF r_owner_perm <> 1 THEN
        RAISE EXCEPTION '3502 PROBE FAILED: the OWNER of a PERMANENT (NULL-expiry) Highlight selected % row(s), not 1. That row is write-only -- visible to nobody -- which is exactly the state applying 2975 without this migration produces.', r_owner_perm;
      END IF;
      IF r_other_perm <> 1 THEN
        RAISE EXCEPTION '3502 PROBE FAILED: a non-owner selected % row(s) of a PUBLIC PERMANENT Highlight, not 1.', r_other_perm;
      END IF;
    ELSE
      RAISE WARNING '3502: the two NULL-EXPIRY ROWS of the real probe were SKIPPED -- public.highlights.expires_at is still NOT NULL on this database, so a PERMANENT Highlight cannot be inserted here at all and no row could be offered to RLS. This is the EXPECTED state on production before 2975, and it is the reason this migration must be applied BEFORE 2975 rather than after. Those two cases ARE established on this database by the TRUTH TABLE above, which evaluates the live quals against a synthetic row and needs no column change. The other six probe cases ran.';
    END IF;

    IF r_owner_past <> 1 THEN
      RAISE EXCEPTION '3502 PROBE FAILED: the OWNER of an EXPIRED Highlight selected % row(s), not 1. The owner arm is still gated on expiry.', r_owner_past;
    END IF;
    IF r_other_fut <> 1 THEN
      RAISE EXCEPTION '3502 PROBE FAILED: a non-owner selected % row(s) of an unexpired PUBLIC Highlight, not 1. The restructure has broken the ordinary read path.', r_other_fut;
    END IF;
    IF r_other_past <> 0 THEN
      RAISE EXCEPTION '3502 PROBE FAILED: a non-owner selected % row(s) of an EXPIRED PUBLIC Highlight, expected 0. The expiry test has been lost rather than moved -- this migration would have turned a 24-hour surface into a permanent one.', r_other_past;
    END IF;
    IF r_blocked_fut <> 0 THEN
      RAISE EXCEPTION '3502 PROBE FAILED: a BLOCKED viewer selected % row(s) of an unexpired PUBLIC Highlight, expected 0. The blocked guard did not move into the non-owner arm intact.', r_blocked_fut;
    END IF;
    IF r_anon_fut <> 1 THEN
      RAISE EXCEPTION '3502 PROBE FAILED: anon selected % row(s) of an unexpired PUBLIC Highlight, not 1. Only highlights_select can admit anon, so this is that policy''s own read path and the restructure broke it.', r_anon_fut;
    END IF;
    IF r_anon_past <> 0 THEN
      RAISE EXCEPTION '3502 PROBE FAILED: anon selected % row(s) of an EXPIRED PUBLIC Highlight, expected 0.', r_anon_past;
    END IF;

    RAISE NOTICE '3502 real RLS probe PASSED: % of 8 cases ran through real RLS. The owner sees their own EXPIRED Highlight%; a non-owner sees the unexpired public one and not the expired one; a blocked viewer sees nothing; anon sees the unexpired public one and not the expired one.',
      CASE WHEN v_null_rows THEN 8 ELSE 6 END,
      CASE WHEN v_null_rows THEN ' and their own PERMANENT (NULL-expiry) one, and a non-owner sees the public PERMANENT one' ELSE ' (the two NULL-expiry rows were skipped -- see the WARNING above)' END;
  END IF;

  -- Nothing survived, asserted from OUTSIDE the rolled-back subtransaction.
  SELECT count(*) INTO v_survivors FROM public.highlights
   WHERE id IN (SENTINEL_PERM_PRIV, SENTINEL_PAST_PRIV, SENTINEL_PERM_PUB, SENTINEL_FUT_PUB, SENTINEL_PAST_PUB);
  IF v_survivors <> 0 THEN
    RAISE EXCEPTION '3502 PROBE FAILED: % probe row(s) survived and are on the live Highlights surface right now.', v_survivors;
  END IF;
  IF v_owner IS NOT NULL AND v_blocker IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.blocks WHERE blocker_id = v_blocker AND blocked_id = v_owner) THEN
    RAISE EXCEPTION '3502 PROBE FAILED: the probe''s block row survived. Two real accounts are now blocked because of a postcondition.';
  END IF;
END
$probe$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. POSTCONDITIONS
--
-- Re-runnable standalone by `certify:migrations`: assertion-only, catalog-only,
-- no mutation keyword and no EXECUTE, so stage 4 re-runs it AFTER the commit,
-- which is the only place it can observe what persisted. It depends on nothing
-- this session did.
-- ═══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  TRIP_BRANCH constant text :=
    $tb$((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))$tb$;
  TOP_EXPIRY  constant text := $te$) AND (expires_at > now()) AND $te$;
  NULL_ARM    constant text := $na$((expires_at IS NULL) OR (expires_at > now()))$na$;
  OWNER_FIRST constant text := $of$((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR $of$;
  p record;
  n int := 0;
BEGIN
  FOR p IN
    SELECT policyname, cmd, permissive, roles, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'highlights' AND cmd = 'SELECT'
     ORDER BY policyname
  LOOP
    n := n + 1;

    -- 1. The owner disjunct is the FIRST thing evaluated after the soft-delete
    --    test. This is the whole migration: an owner must reach their own row
    --    without an expiry test having a say.
    IF left(p.qual, length(OWNER_FIRST)) <> OWNER_FIRST THEN
      RAISE EXCEPTION '3502 postcondition 1 FAILED on %: the owner disjunct is not first. A PERMANENT Highlight (expires_at IS NULL) is then visible to nobody, its owner included, because NULL > now() is NULL and a PERMISSIVE policy admits only TRUE. qual=%',
        p.policyname, p.qual;
    END IF;

    -- 2. No top-level expiry conjunct survives anywhere in the qual. 1 says the
    --    owner arm is first; this says the expiry test is not ALSO ANDed over
    --    the whole expression, which would make 1 decorative.
    IF position(TOP_EXPIRY in p.qual) <> 0 THEN
      RAISE EXCEPTION '3502 postcondition 2 FAILED on %: a top-level `%` conjunct is still present, so every arm including the owner''s is still gated on expiry. qual=%',
        p.policyname, TOP_EXPIRY, p.qual;
    END IF;

    -- 3. The expiry test that remains has a NULL arm. Without it, moving the
    --    test into the non-owner arm would still hide every PERMANENT Highlight
    --    from everyone but its owner.
    IF position(NULL_ARM in p.qual) = 0 THEN
      RAISE EXCEPTION '3502 postcondition 3 FAILED on %: the expiry test has no NULL arm (%), so a PERMANENT Highlight is still invisible to every non-owner. qual=%',
        p.policyname, NULL_ARM, p.qual;
    END IF;

    -- 4. Still PERMISSIVE SELECT with no WITH CHECK, and still one of the two
    --    role sets this family has. A widened policy would satisfy 1-3 too.
    IF p.permissive <> 'PERMISSIVE' OR p.with_check IS NOT NULL
       OR p.roles NOT IN ('{public}'::name[], '{authenticated}'::name[]) THEN
      RAISE EXCEPTION '3502 postcondition 4 FAILED on %: expected PERMISSIVE SELECT TO {public} or {authenticated} with no WITH CHECK -- found permissive=% roles=% with_check=%.',
        p.policyname, p.permissive, p.roles, p.with_check;
    END IF;

    -- 5. No hand-rolled trip membership, on either policy. 2530's finding.
    IF p.qual LIKE '%trip_members%' THEN
      RAISE EXCEPTION '3502 postcondition 5 FAILED on %: the qual references trip_members directly. 2530 removed that self-join because it admitted pending invitees and removed members; the trip_only branch must read %. qual=%',
        p.policyname, TRIP_BRANCH, p.qual;
    END IF;
  END LOOP;

  -- 6. Both policies were actually visited. A loop over an empty result set
  --    satisfies every assertion above and proves nothing, which is the one
  --    way this block could report a pass having checked nothing.
  IF n <> 2 THEN
    RAISE EXCEPTION '3502 postcondition 6 FAILED: % SELECT policy(ies) found on public.highlights, expected 2 (highlights_select TO PUBLIC and highlights_select_active TO authenticated).', n;
  END IF;

  -- 7. And exactly one of them carries the trip_only branch, by name, so the
  --    branch is asserted present rather than only asserted un-regressed.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname='public' AND tablename='highlights' AND cmd='SELECT'
         AND position(TRIP_BRANCH in coalesce(qual,'')) <> 0) <> 1 THEN
    RAISE EXCEPTION '3502 postcondition 7 FAILED: the trip_only branch % does not appear on exactly one SELECT policy of public.highlights.', TRIP_BRANCH;
  END IF;

  RAISE NOTICE '3502 postconditions PASSED: both SELECT policies on public.highlights evaluate the owner disjunct first, carry no top-level expiry conjunct, give the remaining expiry test a NULL arm, keep their command/roles/permissiveness, and route trip_only through authz.shares_accepted_trip on the one policy that has that branch.';
END
$post$;

COMMIT;
