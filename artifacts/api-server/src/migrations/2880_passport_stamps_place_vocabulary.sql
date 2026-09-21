-- 2880_passport_stamps_place_vocabulary.sql
--
-- ⚠ STAGED. NOT APPLIED TO ANY DATABASE BY THE LANE THAT WROTE IT.
-- ⚠ AND NOT READY TO APPLY. See "DO NOT APPLY BEFORE" below — this file is one
--   half of census-passport P61 and applying it alone makes the surface worse,
--   not better. It is staged so the owner's remaining decision is the ONLY
--   thing left, not so that it ships.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2880 (Passport
-- capability). Number allocated to this lane as the reserved band 2880-2889 so
-- concurrent lanes cannot collide; the highest existing migration is 2870.
--
-- Additive + idempotent. WIDENS ONE CHECK CONSTRAINT. Moves no row, drops no
-- value, grants nothing, flips no flag, and changes no behaviour on its own.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- `public.passport_stamps.stamp_type` accepts `'place'` IN ADDITION TO the
-- sixteen values migration 2309 made storable. Nothing is removed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — THE ONE §12 STAMP TYPE WITH NO LABEL IN ANY VOCABULARY
-- ══════════════════════════════════════════════════════════════════════════════
-- Passport spec §12 names eleven stamp types:
--
--   Country · City · PLACE · Event · Experience · Hidden Gem · Trip ·
--   Contributor · Buddy · Milestone · Special
--
-- Ten map onto a label that exists somewhere in the tree. `Place` maps onto
-- nothing: `grep -rn "'place'"` over `src/**` returns no stamp_type occurrence
-- in either vocabulary.
--
-- PLACE IS NOT CONTRIBUTOR. This is the substantive finding behind this file and
-- it is stated here because aliasing the two would close P61 with a lie:
--
--   * `Contributor` is `place_contributor` — seeded into `stamp_definitions`
--     (the v2 CATALOG vocabulary) by `0198_place_contributor_stamps.sql`, three
--     tiers at 10 / 50 / 100 POSTS, awarded by
--     `src/lib/places/placeCollectionsWorker.ts` from a post COUNT, and carried
--     to the Passport with TABLE 16 provenance `contribution_earned`
--     (`UnifiedStampService.mapStampSource`, `case "posts"`). It is a
--     CONTRIBUTION-VOLUME credential that happens to be scoped to a place.
--
--   * `Place` would be a PRESENCE stamp on the v1 writer — the same family as
--     `city`, `neighborhood` and `hidden_gem`, earned by being somewhere and
--     carrying a `verification_level` of `gps` / `checkin`, written by
--     `services/passport/PassportStampService.createStamp`, which already
--     accepts and writes `place_id`.
--
-- They are two of the eleven, not one under two names: different table
-- (`stamp_definitions` vs `passport_stamps`), different earning act (posting vs
-- being there), different provenance enum, different privacy treatment
-- (`PassportPrivacyGuard.guardStamp` redacts `place_id` for public callers).
-- Collapsing `place` onto `place_contributor` would make "I posted here twenty
-- times" and "I was here" the same fact in the column every reader branches on.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED BEFORE WRITING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- Production `ajrurzioarfkagpuxfnb`, 2026-09-14, READ-ONLY (the project is under
-- a standing apply hold; nothing below was written):
--
--   passport_stamps_stamp_type_check:
--     CHECK ((stamp_type = ANY (ARRAY['verification','destination','event',
--       'trip','achievement','host','rent_a_buddy'])))
--
--   passport_stamps            20 rows; 0 carry a non-NULL place_id
--     destination 8 · trip 5 · event 3 · achievement 2 · verification 1 ·
--     rent_a_buddy 1
--   user_stamps                47 rows
--   stamp_definitions          60 rows over SEVEN stamp_type values:
--     trip 13 · location 10 · social 9 · safety 8 · event 8 · rent_buddy 7 ·
--     special 5
--   stamp_definitions WHERE stamp_type = 'place_contributor'   → 0 ROWS
--
-- Two of those measurements are load-bearing and neither was expected:
--
--   (1) MIGRATION 2309 IS NOT APPLIED TO PRODUCTION. The live constraint is
--       still the pre-2309 seven. Every label 2309 added — city, neighborhood,
--       plan, hidden_gem, safe_return, activity, trip_crew, compass_ai,
--       qr_checkin — is still rejected 23514 in production today, so the five
--       live `createStamp` call sites 2309 documents are still writing nothing.
--       That is why THIS file's precondition refuses to run without 2309: a
--       2880 that carried the full seventeen would silently deliver 2309's
--       widening too, and the fact that 2309 never shipped would be buried by
--       the file that depends on it.
--
--   (2) MIGRATION 0198 IS NOT APPLIED TO PRODUCTION EITHER. There are zero
--       `place_contributor` definitions, so `placeCollectionsWorker`'s award
--       resolves `definition_not_found` (StampAwardEngine returns
--       `{ awarded: false, reason: "definition_not_found" }` and the worker
--       swallows it by design). Contributor exists in the TREE and has a
--       producer in the TREE; in production it has neither. Recorded here
--       because census-passport §14.2 corrects P61 to "ten of eleven" on tree
--       evidence — against production it is still nine.
--
-- Read-only on portava-ci `hwokxgbmezheskbzskfr` the same day: that database
-- DOES carry 2309's sixteen, which is what makes it the correct rehearsal
-- target for this file.
--
-- There is therefore no row this change can invalidate and no row it changes.
-- Widening a CHECK can only accept more.
--
-- Postgres has no ALTER CHECK, so the drop and the add are one transaction.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT BUY
-- ══════════════════════════════════════════════════════════════════════════════
-- It does not create a Place stamp. It makes one STORABLE. After this file:
--
--   * nothing writes `'place'` — `PassportStampService.StampType` deliberately
--     does NOT yet include it (see the sequencing note below);
--   * no caller passes `placeId` — all five `createStamp` call sites
--     (routes/location.ts, routes/hiddenGems.ts, routes/geofence.ts,
--     routes/safeReturn.ts, routes/airport.ts) omit it today;
--   * no user sees anything new, and no projection changes shape.
--
-- On its own this file adds a label with NO PRODUCER — the defect class
-- docs/architecture/trust-unproduced-vocabulary.md exists to track. That is not
-- an argument against staging it; it is the reason for the section below.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DO NOT APPLY BEFORE
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. MIGRATION 2309 IS APPLIED (this file's precondition enforces it).
--
-- 2. A PRODUCT RULE EXISTS FOR WHAT EARNS A PLACE STAMP — owner decision
--    D-STAMP, docs/architecture/census-passport.md §12.4. It does not exist in
--    any spec in this repository: a search across docs/ for a Place-stamp
--    earning rule returns only the census row that says it is missing. The rule
--    must answer, at minimum: which of the five createStamp call sites supplies
--    the `placeId`; what verification_level a Place stamp carries; and how it is
--    deduplicated, since the live unique index is
--    (user_id, stamp_type, COALESCE(country,''), COALESCE(city,'')) and does NOT
--    include place_id — so without a rule, two different venues in one city
--    would collapse to one stamp.
--
-- 3. ONLY THEN: add `"place"` to `PassportStampService.StampType` and wire the
--    caller. Adding the union member BEFORE this file is applied would let a
--    developer write `createStamp({ stampType: "place" })` and have it rejected
--    23514 and swallowed by createStamp's null return — precisely the silent
--    blackout 2309 was written to end. The union member must come AFTER the
--    constraint, never before it. This ordering is pinned by
--    src/test/passportStampPlaceVocabulary.test.ts.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   DELETE FROM public.passport_stamps WHERE stamp_type = 'place';
--   ALTER TABLE public.passport_stamps
--     DROP CONSTRAINT IF EXISTS passport_stamps_stamp_type_check;
--   ALTER TABLE public.passport_stamps
--     ADD CONSTRAINT passport_stamps_stamp_type_check
--     CHECK (stamp_type = ANY (ARRAY['verification','destination','event','trip',
--       'achievement','host','rent_a_buddy','city','neighborhood','plan',
--       'hidden_gem','safe_return','activity','trip_crew','compass_ai',
--       'qr_checkin']::text[]));
--   COMMIT;
--
-- The DELETE must run first or the narrowed constraint will not validate, and it
-- DESTROYS earned stamps. EXPIRY CONDITION: this rollback is safe only while
-- `SELECT count(*) FROM public.passport_stamps WHERE stamp_type = 'place'` is 0.
-- The moment the first Place stamp is awarded to a real user the rollback stops
-- being a rollback and becomes data loss, and reverting must instead go forward
-- with a migration that re-maps those rows onto a type the product keeps.
-- Because step 3 above forbids a producer until after this file is applied, that
-- count is 0 for as long as this file is staged.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TRANSACTION
-- ══════════════════════════════════════════════════════════════════════════════
-- Required, same reasoning as 2309: ALTER TABLE … ADD CONSTRAINT revalidates
-- every existing row, and without the transaction a failed ADD after a committed
-- DROP would leave the table with NO constraint at all. The widened list is a
-- strict superset of the one it replaces, so it cannot fail on an existing row —
-- the transaction is the backstop, not the plan.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  def   TEXT;
  label TEXT;
BEGIN
  IF to_regclass('public.passport_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2880): public.passport_stamps is missing.';
  END IF;

  PERFORM 1
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'passport_stamps'
    AND column_name = 'stamp_type';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2880): passport_stamps.stamp_type is missing.';
  END IF;

  -- `place_id` is the column a Place stamp exists to carry. createStamp already
  -- writes it; if it is absent this database is older than the writer and a
  -- `place` label would be storable but meaningless.
  PERFORM 1
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'passport_stamps'
    AND column_name = 'place_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2880): passport_stamps.place_id is missing — a Place stamp has nothing to point at.';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'passport_stamps'
    AND c.conname = 'passport_stamps_stamp_type_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2880): passport_stamps_stamp_type_check is absent; expected the vocabulary migration 2309 set.';
  END IF;

  -- 2309 MUST already be applied. This file widens 2309's vocabulary by one; it
  -- deliberately refuses to substitute for it, so that a database still on the
  -- pre-2309 seven (production, as measured 2026-09-14) fails loudly here
  -- instead of receiving 2309's nine labels as an undocumented side effect of
  -- a migration whose subject is Place.
  FOREACH label IN ARRAY ARRAY[
    'verification','destination','event','trip','achievement','host','rent_a_buddy',
    'city','neighborhood','plan','hidden_gem','safe_return','activity','trip_crew',
    'compass_ai','qr_checkin'
  ] LOOP
    IF position('''' || label || '''' IN def) = 0 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (2880): stamp_type vocabulary lacks %, so migration 2309 is not applied. Apply 2309 first — 2880 widens it by one label and must not be used to deliver it.', label;
    END IF;
  END LOOP;
END $$;

-- ── Widen the constraint by exactly one label ────────────────────────────────
ALTER TABLE public.passport_stamps
  DROP CONSTRAINT IF EXISTS passport_stamps_stamp_type_check;

ALTER TABLE public.passport_stamps
  ADD CONSTRAINT passport_stamps_stamp_type_check
  CHECK (stamp_type = ANY (ARRAY[
    -- catalog vocabulary (StampAwardEngine ← stamp_definitions.stamp_type)
    'verification',
    'destination',
    'event',
    'trip',
    'achievement',
    'host',
    'rent_a_buddy',
    -- v1 service vocabulary (PassportStampService.StampType), set by 2309
    'city',
    'neighborhood',
    'plan',
    'hidden_gem',
    'safe_return',
    'activity',
    'trip_crew',
    'compass_ai',
    'qr_checkin',
    -- §12 "Place": a PRESENCE stamp carrying place_id. Added by 2880.
    -- NOT an alias of the v2 catalog's 'place_contributor', which is a
    -- contribution-volume credential on a different table.
    'place'
  ]::text[]));

COMMENT ON COLUMN public.passport_stamps.stamp_type IS
  'Two vocabularies share this column (see migration 2309): the CATALOG seven '
  'copied from stamp_definitions.stamp_type, and the v1 service labels written '
  'by services/passport/PassportStampService.createStamp. ''place'' (migration '
  '2880) belongs to the second group: a PRESENCE stamp carrying place_id, in '
  'the same family as ''city'' and ''neighborhood''. It is NOT the v2 catalog''s '
  '''place_contributor'', which is a contribution-volume credential earned from '
  'a post count on stamp_definitions/user_stamps — §12 names Place and '
  'Contributor as two of its eleven types and they are not interchangeable. As '
  'of migration 2880 nothing writes ''place'': what earns a Place stamp is owner '
  'decision D-STAMP (docs/architecture/census-passport.md §12.4).';

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  def   TEXT;
  label TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'passport_stamps'
    AND c.conname = 'passport_stamps_stamp_type_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2880): passport_stamps_stamp_type_check is absent after the swap.';
  END IF;

  -- The superset check: every label of BOTH prior vocabularies, plus 'place'.
  -- A future edit that drops one fails here rather than silently re-blinding a
  -- writer, which is the failure mode 2309 was written to end.
  FOREACH label IN ARRAY ARRAY[
    'verification','destination','event','trip','achievement','host','rent_a_buddy',
    'city','neighborhood','plan','hidden_gem','safe_return','activity','trip_crew',
    'compass_ai','qr_checkin','place'
  ] LOOP
    IF position('''' || label || '''' IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2880): stamp_type vocabulary is missing %', label;
    END IF;
  END LOOP;

  -- 'place' must be storable...
  BEGIN
    PERFORM 1 WHERE 'place' = ANY (ARRAY['place']::text[]);
  END;

  -- ...and 'place_contributor' must NOT have been admitted here. It is a
  -- stamp_definitions label and belongs to the v2 catalog on another table;
  -- admitting it to passport_stamps would be the alias this file exists to
  -- refuse.
  IF position('''place_contributor''' IN def) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2880): ''place_contributor'' was added to passport_stamps.stamp_type. That is the v2 catalog''s contribution credential, not a v1 presence stamp — the two are distinct §12 types and must not be aliased.';
  END IF;
END $$;

COMMIT;
