-- 2893_rank_events_retire_writerless_surfaces.sql
--
-- ⚠ STAGED AND REHEARSED. Applied by the lane that wrote it to portava-ci
--   (hwokxgbmezheskbzskfr) ONLY. NOT applied to production.
--
-- ⚠⚠ THIS IS THE ONE FILE IN THE 2890-2899 BAND THAT **NARROWS** A CONSTRAINT,
--    AND THE ONLY ONE WHOSE REVERSAL IS NOT FREE. IT IS OPTIONAL. Read
--    "WHAT REVERSING THIS COSTS" before applying it, and apply it LAST or not
--    at all. Everything else in this lane is purely additive; skipping 2893
--    changes nothing about 2890, 2891 or 2892.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Discovery
-- MIGRATIONS lane, band 2890-2899.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT — census DV-44 (census-discovery:919)
-- ══════════════════════════════════════════════════════════════════════════════
-- `04` §10.2: "audit every allowed `surface`; prove at least one intentional
-- writer OR RETIRE IT." DV-44 records that the audit happened (DV-43) and the
-- retirement did not, and that 2298 "pins the dead vocabulary AS DEAD rather
-- than removing it: documents the gap, does not close it."
--
-- This file performs the retirement. `rank_events_surface_check` loses SEVEN
-- labels and keeps EIGHT. Nothing else on the table changes.
--
--   RETIRED (no writer anywhere in the tree):
--     search · nearby · story · event · trip · profile · explore
--
--   KEPT (each has at least one intentional writer, cited):
--     pulse        lib/rankLog.ts:96  logRankedServe(surface: "pulse"|…)
--     discovery    lib/discoveryServeLog.ts:439 · lib/rankLog.ts:96
--     events       lib/rankLog.ts:96 · routes/rankEvents.ts:169 SURFACE_VALUES
--     compass      lib/rankLog.ts:283  surface: "compass"
--     live_pulse   lib/rankLog.ts:442  surface: "live_pulse" (0199)
--     living_page  routes/rankEvents.ts:68  surface: "living_page"
--     watch_feed   routes/mediaFeed.ts:1751/1787/2081/2111 → :1759 insert
--     wall         routes/wall.ts:163  surface: "wall" (2298)
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE CENSUS SAYS NINE. IT IS SEVEN. — the substantive finding in this file
-- ══════════════════════════════════════════════════════════════════════════════
-- DV-44 names nine surfaces with zero production rows and no retirement:
--
--     search · nearby · story · event · trip · profile · explore ·
--     living_page · watch_feed
--
-- TWO OF THOSE NINE HAVE INTENTIONAL WRITERS and must NOT be retired:
--
--   * `living_page` — routes/rankEvents.ts:68 writes it as a hard-coded literal
--     on the outcome path. It has zero production rows for the reason
--     lib/discoveryServeLog.ts:14-35 already records: living_page impressions
--     were REJECTED by the surface CHECK until migration 0202 added the label,
--     and 0202's own header notes the surfaces "written by the code but ZERO
--     rows present". Zero rows here is the SCAR of a past blackout, not the
--     absence of a writer, and retiring the label would re-open exactly the
--     blackout 0202 closed.
--
--   * `watch_feed` — routes/mediaFeed.ts builds impression rows at :1751 and
--     :1787 and inserts them at :1759 (`sc.from("rank_events").insert(...)`),
--     with three further write paths at :2081, :2111 and :2259. This is one of
--     the most heavily exercised media surfaces in the product.
--
-- "Zero rows" and "no writer" are different claims and DV-44 conflates them for
-- these two. THE ROW COUNT ALONE IS NOT SUFFICIENT EVIDENCE FOR RETIREMENT —
-- which is precisely why this file retires on WRITER evidence (a grep of the
-- tree, cited per label above) and uses the row count only as a SAFETY VETO.
-- A proposed verdict note for the integration owner, who grades: DV-44's
-- "nine" should read "seven", with living_page and watch_feed moved to the
-- writer-backed column.
--
-- The seven that ARE retired were checked the same way. `SurfaceName`
-- (services/ranking/DiscoveryRankingService.ts:29-39) is a TYPE union that
-- lists all seven, and its three analytics writers (rankingAnalytics,
-- FeedSlotAllocator.writeSlotAnalytic, CreatorCapEnforcer.writeDiversityAnalytic)
-- take `surface: SurfaceName` as a PARAMETER — so the union makes them
-- expressible. No production call site passes any of the seven: the only
-- occurrences outside the type declaration are
-- services/ranking/__tests__/feedSlotAllocator.test.ts:204 (`surface: "search"`,
-- which reaches allocateFeedSlots and never rank_events) and the doc comments.
-- A type union is not a writer.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED, AND WHAT THE REHEARSAL COULD NOT ESTABLISH
-- ══════════════════════════════════════════════════════════════════════════════
-- THE LIVE DISTRIBUTION ON portava-ci `hwokxgbmezheskbzskfr`, 2026-09-14, after
-- this lane's own seeding, immediately before applying this file:
--
--     SELECT surface, count(*) FROM public.rank_events GROUP BY surface;
--       discovery   239
--       (no other surface appears)
--
-- THIS IS NOT EVIDENCE ABOUT PRODUCTION AND MUST NOT BE READ AS SUCH.
-- portava-ci's rank_events held ZERO rows before this lane seeded it, and every
-- row in it now was written by this rehearsal on surface='discovery'. A
-- narrowing that succeeds against that table has been proved to succeed against
-- a table containing none of the values it removes — which is a tautology, not
-- a test. The distribution that decides whether this file can apply is
-- PRODUCTION's, and this lane is forbidden to read production.
--
-- So the file does not rely on a measurement at all. Its precondition COUNTS
-- THE ROWS CARRYING EACH RETIRED SURFACE ON WHATEVER DATABASE IT IS RUN
-- AGAINST, and RAISES with the per-surface counts if any are found. On a
-- database where the census's "zero rows for these" holds, it applies. On one
-- where it does not, it aborts inside its own transaction, names the surfaces
-- and the counts, and changes nothing. The integration owner does not have to
-- trust my reading of production, and neither do I.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT REVERSING THIS COSTS — READ BEFORE APPLYING
-- ══════════════════════════════════════════════════════════════════════════════
-- Structurally the reversal is one ALTER (below) and it restores the exact
-- pre-2893 vocabulary. What it CANNOT restore is any row that was REJECTED
-- while the narrowed constraint was in force.
--
-- Every rank_events writer in this codebase is fire-and-forget: the insert's
-- error is passed to a logger.warn and the row is gone. So if a writer for one
-- of the seven appears between this file and its reversal — a new feature, a
-- merged branch, a call site that starts passing `surface: "search"` — its rows
-- are lost silently for the whole window, and no rollback brings them back.
--
-- The loss set is EMPTY BY CONSTRUCTION AT THE MOMENT OF APPLY, because no such
-- writer exists (the grep above). It stops being empty the moment one is
-- written. THAT is the asymmetry: this is the only file in the band whose risk
-- GROWS with time rather than staying fixed.
--
-- MITIGATION, and the reason this is still worth doing: a developer who adds
-- `surface: "search"` AFTER this file gets a 23514 that the existing
-- logger.warn reports, in CI, against a constraint whose definition names
-- exactly which labels are live — instead of silently writing into a
-- vocabulary nobody has proved anybody reads. The `04` §10 sequence is
-- "prove a writer OR RETIRE"; a label kept alive with no writer is the state
-- §10.3-4 ("remove silent failure catches", "instrument rejected event writes")
-- exists to end.
--
-- IF THAT TRADE IS NOT WANTED, SKIP THIS FILE. It is deliberately the last in
-- the band and nothing depends on it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY — structurally total, see the caveat above
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
--   ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_surface_check
--     CHECK (surface = ANY (ARRAY['pulse','discovery','events','compass','search',
--       'nearby','story','event','trip','profile','explore','live_pulse',
--       'living_page','watch_feed','wall']::text[]));
--   COMMIT;
--
-- That is the post-2298 fifteen — the exact vocabulary this file narrows, and
-- the one its precondition requires to be in place before it will run. The
-- widened list is a strict superset of the narrowed one, so the reversal can
-- never fail on an existing row.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE REFUSES TO RUN ON A DATABASE THAT HAS NOT HAD 2298
-- ══════════════════════════════════════════════════════════════════════════════
-- Production's `rank_events_surface_check` was NOT read by this lane. If it is
-- still the pre-2298 FOURTEEN (no 'wall'), then a 2893 that simply wrote its
-- eight would DELIVER 'wall' as an undocumented side effect of a file whose
-- subject is retirement — the same error 2880 refuses to make about 2309. And
-- if it is something else again, narrowing blind would be worse still. So the
-- precondition reads the live definition and requires ALL FIFTEEN post-2298
-- labels to be present before it will touch anything. A database on the
-- fourteen fails here and is told to apply 2298 first.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TRANSACTION
-- ══════════════════════════════════════════════════════════════════════════════
-- Required, and here it is the PLAN rather than a backstop — unlike 2298 and
-- 2880, which widen. The new list is a strict SUBSET, so ADD CONSTRAINT CAN
-- fail on an existing row. Without the transaction a failed ADD after a
-- committed DROP would leave rank_events with NO surface constraint at all:
-- every surface, including misspellings, would become storable, and the
-- partition key every exposure denominator groups on would silently start
-- accepting anything.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  def      TEXT;
  label    TEXT;
  n        BIGINT;
  offenders TEXT := '';
  total    BIGINT := 0;
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2893): public.rank_events does not exist.';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t      ON t.oid = c.conrelid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname='public' AND t.relname='rank_events'
    AND c.conname='rank_events_surface_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2893): rank_events_surface_check is absent. This file narrows a vocabulary it expects to find; it must not be used to create one.';
  END IF;

  -- The exact post-2298 fifteen. See the header: a database on the pre-2298
  -- fourteen must apply 2298 first rather than receive 'wall' as a side effect.
  FOREACH label IN ARRAY ARRAY[
    'pulse','discovery','events','compass','search','nearby','story','event',
    'trip','profile','explore','live_pulse','living_page','watch_feed','wall'
  ] LOOP
    IF position('''' || label || '''' IN def) = 0 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (2893): rank_events_surface_check does not permit %, so this database is not on the post-2298 fifteen. Apply 2298_dead_check_vocabularies.sql first — 2893 narrows that vocabulary and must not be used to deliver it.', label;
    END IF;
  END LOOP;

  -- ── THE SAFETY VETO ────────────────────────────────────────────────────────
  -- Counted on THIS database, at apply time, rather than trusted from a reading
  -- taken elsewhere. A single row on a retired surface aborts the file and is
  -- named with its count, because that row is a writer this lane failed to find
  -- and the correct response is to investigate it, not to delete it.
  --
  -- NOTE WHAT THIS DELIBERATELY DOES NOT DO: it does not offer to migrate,
  -- relabel or delete such rows. Relabelling would corrupt the surface it
  -- borrowed (2298's argument), and deleting would be destructive DDL on a
  -- populated table to make a constraint fit — which is the trade this lane is
  -- forbidden to make.
  FOREACH label IN ARRAY ARRAY['search','nearby','story','event','trip','profile','explore'] LOOP
    EXECUTE 'SELECT count(*) FROM public.rank_events WHERE surface = $1' INTO n USING label;
    IF n > 0 THEN
      offenders := offenders || label || '=' || n || ' ';
      total := total + n;
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2893): % row(s) carry a surface this file retires — %. Those rows are evidence of a writer this migration''s audit did not find. Nothing has been changed. Investigate the writer and either keep the label or retire the writer; do NOT delete the rows to make the constraint fit.', total, btrim(offenders);
  END IF;
END $$;

-- ── Narrow to the eight surfaces with proven writers ─────────────────────────
ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_surface_check;

ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_surface_check
  CHECK (surface = ANY (ARRAY[
    -- lib/rankLog.ts:96 logRankedServe — the three original ranked surfaces
    'pulse',
    'discovery',
    'events',
    -- lib/rankLog.ts:283 — Compass's own writer
    'compass',
    -- lib/rankLog.ts:442 — Live Pulse's own key space, permitted by 0199
    'live_pulse',
    -- routes/rankEvents.ts:68 — the outcome path, permitted by 0202
    'living_page',
    -- routes/mediaFeed.ts:1759 — the media impression insert, permitted by 0202
    'watch_feed',
    -- routes/wall.ts:163 — permitted by 2298
    'wall'
  ]::text[]));

COMMENT ON COLUMN public.rank_events.surface IS
  '`04` §10.2 / census DV-44. Exactly the surfaces with at least one intentional '
  'writer in the tree, as of migration 2893. 2893 RETIRED seven labels that had '
  'none — search, nearby, story, event, trip, profile, explore — which existed '
  'only as members of the SurfaceName type union '
  '(services/ranking/DiscoveryRankingService.ts:29). A type union is not a '
  'writer. living_page and watch_feed were KEPT despite zero production rows: '
  'both have writers (routes/rankEvents.ts:68, routes/mediaFeed.ts:1759) and '
  'their zero counts are the scar of the pre-0202 CHECK blackout, not an absence '
  'of a producer. ADDING A SURFACE HERE REQUIRES A WRITER FIRST, and adding a '
  'writer for a label not in this list produces a 23514 that the fire-and-forget '
  'handlers only logger.warn — check this list before writing a new surface.';

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  def   TEXT;
  label TEXT;
  n     BIGINT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t      ON t.oid = c.conrelid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  WHERE ns.nspname='public' AND t.relname='rank_events'
    AND c.conname='rank_events_surface_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2893): rank_events_surface_check is ABSENT after the swap. Every surface would now be storable.';
  END IF;

  -- 1. Every KEPT label is still permitted. Asserted first and individually:
  --    dropping one of these is how a working writer goes dark, and it is the
  --    failure this whole file could most easily cause.
  FOREACH label IN ARRAY ARRAY[
    'pulse','discovery','events','compass','live_pulse','living_page','watch_feed','wall'
  ] LOOP
    IF position('''' || label || '''' IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2893): surface % has an intentional writer and was dropped from the vocabulary. That writer is now silently rejected 23514.', label;
    END IF;
  END LOOP;

  -- 2. Every RETIRED label is gone. Otherwise the file did nothing and DV-44
  --    would be reported as closed on a constraint that never changed.
  FOREACH label IN ARRAY ARRAY['search','nearby','story','event','trip','profile','explore'] LOOP
    IF position('''' || label || '''' IN def) > 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2893): surface % was not retired; the vocabulary is unchanged.', label;
    END IF;
  END LOOP;

  -- 3. NO ROW WAS LOST. The data-preservation assertion: narrowing a CHECK must
  --    never be accompanied by a deletion, and this proves none happened by
  --    showing every surviving row is on a KEPT surface.
  SELECT count(*) INTO n FROM public.rank_events
   WHERE surface <> ALL (ARRAY['pulse','discovery','events','compass','live_pulse',
                               'living_page','watch_feed','wall']::text[]);
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2893): % row(s) survive on a retired surface, which should have been impossible past the precondition.', n;
  END IF;

  -- 4. Behavioural: a KEPT surface is still writable and a RETIRED one is not.
  --    Read as a pair, because asserting only the second would pass on a
  --    constraint that rejected everything.
  BEGIN
    INSERT INTO public.rank_events (id,user_id,item_id,features,outcome,served_at,surface)
    VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','2893-probe',
            '{}'::jsonb,'impression',now(),'search');
    RAISE EXCEPTION 'POSTCONDITION FAILED (2893): surface=''search'' was still accepted after retirement.';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- correct
    WHEN foreign_key_violation OR not_null_violation THEN
      RAISE WARNING 'POSTCONDITION (2893): retired-surface probe could not reach the CHECK (blocked by an FK/NOT NULL first). The vocabulary is still asserted textually above.';
  END;
END $$;

COMMIT;
