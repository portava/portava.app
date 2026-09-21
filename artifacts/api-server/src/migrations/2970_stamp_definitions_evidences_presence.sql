-- 2970_stamp_definitions_evidences_presence.sql
--
-- ⚠ STAGED. NOT APPLIED TO ANY DATABASE BY THE LANE THAT WROTE IT.
--   Nothing below has been run against production (`ajrurzioarfkagpuxfnb`) or
--   against `portava-ci` (`hwokxgbmezheskbzskfr`). Every number this header
--   quotes was measured by READING MIGRATION FILES IN THIS TREE, not by
--   querying a database. Where that distinction matters it is said again.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2970
-- (Passport presence). Number allocated from the reserved band 2970-2979 so
-- concurrent lanes cannot collide; the highest existing migration is 2930.
--
-- Additive + idempotent. ADDS ONE COLUMN and sets it on rows that already
-- exist. Drops nothing, moves no row, grants nothing, flips no flag, creates no
-- table, and changes no behaviour on its own — the reader that acts on it is
-- `services/passport/PassportMapService.ts#buildStats`, changed in the same
-- commit.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- `public.stamp_definitions.evidences_presence BOOLEAN NOT NULL DEFAULT false`
--
--   TRUE  — earning this stamp is evidence that the traveller was PHYSICALLY AT
--           the city/country recorded on the `user_stamps` row.
--   FALSE — the stamp may be earned without having been there.
--
-- It is a property of the DEFINITION, so every one of the readers below can ask
-- the same question and get the same answer.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — A TRIP YOU PLANNED AND NEVER TOOK COUNTED AS A COUNTRY YOU VISITED
-- ══════════════════════════════════════════════════════════════════════════════
-- Recorded at docs/architecture/census-highlights-memories.md §K.4. The chain,
-- each link read at 7778f3189:
--
--   1. `src/routes/trips.ts` `POST /api/trips` awards `first_trip_created` and
--      `trip_planner` AT CREATION, passing
--      `city: destinationCity, country: destinationCountry`. There is no
--      occurrence evidence of any kind; the trip has not happened.
--   2. `src/services/passport/StampAwardEngine.ts#awardStamp` writes that
--      city/country into `user_stamps`.
--   3. `src/services/passport/PassportMapService.ts#buildStats` did
--      `if (r.country) countries.add(r.country)` for EVERY non-revoked row.
--      The `STATS_SLUG_BUCKETS` counters below it feed only the
--      plan/host/gem/safe-return numbers and do NOT filter the country/city sets.
--   4. Served by `src/routes/passportStamps.ts` and
--      `src/services/passport/PassportProjectionService.ts`.
--   5. `travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx`
--      renders it as "Countries" (`:294`), and a "World Traveler — 5 or more
--      countries visited" watermark (`:372`) is written against the same idea.
--
-- ONE CORRECTION TO §K.4, MEASURED HERE AND NOT ASSUMED. Link 5 overstates the
-- client reach. `PassportIdentityCard` is imported by NO production file in
-- this tree (`grep -rn "PassportIdentityCard" travel-buddy-standalone/src`
-- returns the component itself, its own tests, and one stale `jest.mock` in
-- `PassportContent.focusTTL.component.test.tsx`), and the watermark's only
-- input is a `countriesVisited` PROP THAT NOTHING PASSES — so it can never
-- render. `MyWorldScreen.tsx:332`'s "Countries" tile is a different number,
-- built by `buildMapPayload` over the LEGACY `passport_stamps` table, which
-- carries its own `verification_level` and is not affected by this defect.
--
-- So the over-claim is real in the API RESPONSE of GET /me/passport/stats, and
-- real and REACHABLE in `SharedContextService`'s "N shared cities" fact (served
-- through `routes/passport.ts`) — but NOT, today, in the watermark. The defect
-- is a false statement this server sends, not yet a pixel a traveller sees.
-- It is worth fixing on that basis alone, and because the card is one import
-- away from being live.
--
-- Plan five trips, take none, and the server says you have been to five
-- countries. That is
-- census-highlights-memories H4's prohibition ("Planned/saved/nearby never
-- represented as 'experienced' without occurrence evidence or user
-- confirmation") and H239's invariant ("planned activity without occurrence
-- cannot earn a visit Memory/Stamp"), on a shipping screen.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A COLUMN AND NOT A LIST IN ONE SERVICE
-- ══════════════════════════════════════════════════════════════════════════════
-- Spec `10` §1: "Extend existing canonical tables where appropriate. Avoid
-- parallel systems." §K.4 counts 26 non-test read sites of `user_stamps` across
-- 20 files. A `PRESENCE_SLUGS` set private to `PassportMapService` would have
-- been the first of twenty copies, and the second copy is where they disagree.
--
-- NEITHER EXISTING COLUMN CAN CARRY THIS. Measured over the seeding migrations:
--   * `category` — `trip_planner` is 'community' and `first_trip_created` is
--     'trip', while `first_trip_completed` is ALSO 'trip'. The planned/occurred
--     line cuts straight through 'trip'.
--   * `stamp_type` — same: 'trip' holds both `first_trip_created` and
--     `first_trip_completed`.
--   * `criteria_type` — 'automatic' for both halves.
-- There is no existing column whose value differs between a trip created and a
-- trip completed, which is exactly the distinction the Passport is claiming.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFAULT FAILS SAFE — AND WHICH DIRECTION THAT IS
-- ══════════════════════════════════════════════════════════════════════════════
-- DEFAULT false. The two failure directions are NOT symmetric:
--
--   * Over-claiming — "you have been to 5 countries" when the traveller has
--     been to none — is a FALSE STATEMENT ABOUT A PERSON printed on their
--     Passport, and it mints an achievement watermark from it. That is the
--     defect this file repairs.
--   * Under-claiming — a country the traveller really visited missing from the
--     count — is a stamp that does not show up. It is wrong, it is visible to
--     the person who would notice first (they know where they went), and it
--     asserts nothing untrue.
--
-- So a slug NOBODY HAS THOUGHT ABOUT must not count. A definition seeded by a
-- future migration that does not know this column exists gets `false` and is
-- silently excluded from the been-there claim until somebody decides otherwise.
-- The alternative default would silently re-open this defect for every slug
-- added from here on.
--
-- NOT NULL is part of the same choice: a nullable column would push the
-- three-valued decision out to 20 readers, and `NULL` read as anything but
-- "not presence" is the same over-claim in a new disguise.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FULL SLUG VOCABULARY, AND HOW EACH WAS CLASSIFIED
-- ══════════════════════════════════════════════════════════════════════════════
-- 63 distinct slugs are seeded into `stamp_definitions` by the migrations in
-- this tree — 0081 (40), 0082 (12), 0145 (2), 0179 (4), 0189 (2), 0198 (3).
-- No migration DELETEs from the table; 0193 only sets `globe_trotter`
-- `is_active = false`.
--
-- THE CLASSIFICATION RULE, stated so it can be argued with:
--
--   A slug is marked TRUE only when an ACTUAL AWARD SITE in this tree can be
--   named, AND that site's gate is evidence of having been at the place, AND
--   that site attaches the city/country the claim is made from.
--
--   Description text is NOT sufficient. `first_trip` is worded "Complete your
--   first trip" but NOTHING AWARDS IT; marking it TRUE would plant a trap for
--   whoever writes its first writer. The marketing copy is not the gate.
--
-- ── TRUE (13) ────────────────────────────────────────────────────────────────
-- (a) Awarded by `routes/trips.ts#awardTripCompletionStamps` (lines 115-230),
--     gate = the trip reached `status = 'completed'`, and the call passes the
--     trip's `city, country`:
--       first_trip_completed · long_haul · weekend_wanderer ·
--       international_voyager · solo_traveler · group_tripper · good_host ·
--       road_warrior · frequent_flyer
--     WEAKEST LINK, STATED: completion is the trip owner PATCHing
--     `status='completed'`; it is self-attested, not GPS. It is admitted as
--     presence because it is the system's own record that the journey OCCURRED
--     — the exact thing "created" is not — and because excluding it would leave
--     Countries near-permanently 0 for real users, which is under-claiming past
--     the point where the number means anything. If the owner wants a stricter
--     bar, the change is this one column, in one row per slug.
--
-- (b) Awarded by `routes/posts.ts` (lines 721-780) INSIDE
--     `if (verdict.stampEligible && locationCity)` — a GPS-verified postcard —
--     and the call passes `locationCity, locationCountry`:
--       city_explorer · world_citizen · globe_trotter_5 · globe_trotter_10
--     This is the strongest evidence in the system: a verified location fix.
--
-- ── FALSE (50), and why ──────────────────────────────────────────────────────
-- (c) THE DEFECT ITSELF — awarded at trip CREATION with the destination
--     attached, no occurrence of any kind (`routes/trips.ts:413-440`):
--       first_trip_created · trip_planner
--
-- (d) Awarded with a location attached, but the gate is not being there:
--       hidden_gem_explorer — `routes/hiddenGems.ts:1546-1560` awards it to the
--         gem's SUBMITTER when an ADMIN APPROVES the submission, passing the
--         gem's city/country. Approval verifies the gem, not the submitter's
--         presence. Submit an approved gem for Kyoto without going, and Kyoto
--         counted. This is a SECOND live instance of the same defect.
--       first_postcard — `routes/posts.ts:810-825` passes the postcard's
--         city/country but is NOT inside the `verdict.stampEligible` guard the
--         location milestones sit in. The location is user-entered and
--         unverified.
--
-- (e) Awarded with NO city/country at all, so inert for this claim either way,
--     and FALSE because the rule above finds no presence gate WITH a location:
--       safe_return_ready · safe_return_completed (`routes/safeReturn.ts`)
--       first_event_joined · first_event_hosted · event_participant ·
--         event_host (`routes/events.ts`) — note `event_participant` IS gated
--         on real check-ins, but no place is written, so there is nothing to
--         count; if a location is ever attached, revisit this row FIRST.
--       first_buddy_booking · top_rated_buddy (`routes/rentABuddy.ts`)
--       verified_traveler (`routes/admin.ts`, identity verification)
--
-- (f) Seeded but awarded by NO writer in this tree — no row can exist, and the
--     default must not pre-authorise a future writer:
--       ambassador · beta_tester · buddy_veteran · city_trusted_member ·
--       community_connector · continent_hopper · crew_captain · early_adopter ·
--       event_regular · first_buddy_hosted · first_post · first_session ·
--       first_trip · food_guide · foodie_explorer · founding_member ·
--       globe_trotter (retired is_active=false by 0193) · hidden_gem_hunter ·
--       music_lover · neighborhood_local · night_owl · nightlife_guide ·
--       outdoor_adventurer · photographer · place_contributor_bronze ·
--       place_contributor_silver · place_contributor_gold · popular_traveler ·
--       safe_traveler · safety_advocate · solo_adventurer · storyteller ·
--       sunrise_chaser · travel_influencer · trusted_member · verified_identity ·
--       weekend_warrior
--     Several of these READ as presence ("Complete a solo trip",
--     "Check in to 5 neighborhoods") and several read as obviously not
--     ("Reach 500 followers"). They are all FALSE for the same reason: there is
--     no writer, so there is no gate to inspect, so the rule above does not
--     admit them.
--
-- ── SLUGS I COULD NOT CLASSIFY CONFIDENTLY, named as required ────────────────
--   * safe_return_completed — a completed Safe Return is a real return from a
--     real journey and would be presence IF a place were attached. It is FALSE
--     here only because no place is attached. Inert today; a judgement call
--     tomorrow.
--   * event_participant — gated on actual event check-ins (`routes/events.ts`
--     builds its award list from `checkinUserIds`). Same shape: presence-like
--     gate, no location written. FALSE, inert, revisit if that changes.
--   * good_host — its DESCRIPTION is "Host a trip with all attendees rating 4+
--     stars" (a ratings property), but its only WRITER is the trip-completion
--     path, which requires the trip to have completed and passes its place. It
--     is TRUE on the writer, and the description is stale. Flagged because the
--     two disagree.
--
-- ── A SLUG AWARDED BUT NEVER SEEDED (not this file's to fix) ─────────────────
--   `src/lib/places/placeCollectionsWorker.ts` awards `place_contributor`.
--   NO migration seeds that slug — only `place_contributor_bronze` / `_silver`
--   / `_gold`. The precondition block below therefore does NOT name it, and
--   this migration cannot classify a definition that does not exist. Reported
--   rather than papered over.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES *NOT* FIX
-- ══════════════════════════════════════════════════════════════════════════════
--   * `src/lib/stamps/criteria/metrics.ts:104`
--       countries_visited: (sc, u) => distinctStampField(sc, u, "country")
--     counts distinct `user_stamps.country` over the SAME unfiltered rows. So a
--     planned-never-taken trip also pushes `countries_visited` toward the
--     `globe_trotter_5` threshold ("Visit 5 different countries"). Plan five
--     trips and the criteria engine MINTS the Globe Trotter stamp. Same for
--     `cities_visited` at :103. Outside this lane's edit set; reported.
--   * `src/compass/CompassGraphEngine.ts:570-582` writes a
--     `person —visited→ city` graph EDGE for every non-revoked `user_stamps`
--     row with a city. Same claim, same rows, different surface. Reported.
--   * `src/services/passport/SharedContextService.ts#loadStampCities` — fixed
--     in this commit, it is inside `services/passport/**`.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSAL (exact, and lossless for every pre-existing row)
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   ALTER TABLE public.stamp_definitions DROP COLUMN IF EXISTS evidences_presence;
--   COMMIT;
--
-- That is the whole of it. This file adds one column and writes only to that
-- column; dropping it restores `stamp_definitions` byte-for-byte to its prior
-- shape and touches no other table, no row of `user_stamps`, and no row of any
-- other table in either direction. NO DATA IS LOST BY REVERSING, because the
-- only data this file creates lives in the dropped column.
--
-- WHAT REVERSING COSTS: `buildStats` selects the column. With the column gone
-- PostgREST fails the embed, `buildStats` takes its `readFailed: true` branch
-- and the Passport reports "we could not look" rather than a wrong number — so
-- reversing this migration WITHOUT reverting the service commit degrades the
-- Passport stats to unavailable. It does NOT re-open the over-claim. Revert
-- both, or neither.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  missing TEXT[];
  slug_name TEXT;
BEGIN
  IF to_regclass('public.stamp_definitions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2970): public.stamp_definitions is missing. Apply 0081/0082 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stamp_definitions' AND column_name = 'slug'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2970): stamp_definitions.slug is missing — this file keys every decision on slug.';
  END IF;

  -- EVERY slug this file names must exist. A seed naming a slug that is not
  -- there is a no-op that READS LIKE A DECISION, which is worse than an error:
  -- the next person sees `trip_planner` listed as FALSE and believes it was
  -- set. Fail loudly instead.
  missing := ARRAY[]::TEXT[];
  FOREACH slug_name IN ARRAY ARRAY[
    -- the 13 marked TRUE
    'first_trip_completed','long_haul','weekend_wanderer','international_voyager',
    'solo_traveler','group_tripper','good_host','road_warrior','frequent_flyer',
    'city_explorer','world_citizen','globe_trotter_5','globe_trotter_10',
    -- the slugs named explicitly as FALSE in the postconditions
    'first_trip_created','trip_planner','hidden_gem_explorer','first_postcard',
    'safe_return_ready','safe_return_completed','event_participant',
    'first_event_joined','first_event_hosted','verified_traveler'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.stamp_definitions WHERE slug = slug_name) THEN
      missing := missing || slug_name;
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2970): stamp_definitions is missing slug(s): %. The seeding migrations (0081/0082/0145/0189) are not all applied; applying 2970 against a partial catalog would record decisions about rows that do not exist.', array_to_string(missing, ', ');
  END IF;
END $$;

-- ── The column ───────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT false: every row that already exists becomes `false`, which
-- is the fail-safe direction (see the header). The seed below then raises the
-- 13 that earn it.
ALTER TABLE public.stamp_definitions
  ADD COLUMN IF NOT EXISTS evidences_presence BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.stamp_definitions.evidences_presence IS
  'TRUE when earning this stamp is evidence the traveller was PHYSICALLY AT the '
  'city/country recorded on the user_stamps row. Read by '
  'services/passport/PassportMapService.buildStats to decide which stamps may '
  'contribute to the Passport''s "Countries"/"Cities" numbers, and by '
  'SharedContextService for "N shared cities". DEFAULT false is deliberate and '
  'fails SAFE: over-claiming "you have been to N countries" is a false statement '
  'about a person and mints the World Traveler watermark from it (migration '
  '2970, census-highlights-memories §K.4); under-claiming only hides a stamp. A '
  'new definition is NOT a visit until somebody decides it is. The property is '
  'on the DEFINITION, not on user_stamps, so all 26 readers of user_stamps can '
  'ask one question and get one answer.';

-- ── Seed: the slugs that DO evidence presence ────────────────────────────────
-- Idempotent: re-running sets the same rows to the same values. Every slug here
-- was proved to exist by the precondition block above.
--
-- The delimiters below are load-bearing: src/test/passportPresenceEvidence.test.ts
-- parses this list and fails if any slug in it is seeded by no migration.
UPDATE public.stamp_definitions
SET    evidences_presence = true
WHERE  slug IN (
  -- PRESENCE-TRUE-SLUGS-BEGIN
  --   (a) trip COMPLETION — routes/trips.ts#awardTripCompletionStamps, gated on
  --       trips.status = 'completed', passes the trip's city/country.
  'first_trip_completed',
  'long_haul',
  'weekend_wanderer',
  'international_voyager',
  'solo_traveler',
  'group_tripper',
  'good_host',
  'road_warrior',
  'frequent_flyer',
  --   (b) GPS-VERIFIED postcard — routes/posts.ts, inside
  --       `if (verdict.stampEligible && locationCity)`.
  'city_explorer',
  'world_citizen',
  'globe_trotter_5',
  'globe_trotter_10'
  -- PRESENCE-TRUE-SLUGS-END
);

-- ── Seed: the planning slugs, set FALSE BY NAME ──────────────────────────────
-- These are already false from the DEFAULT. They are written explicitly anyway
-- so that a reader of this file sees a DECISION about `trip_planner` rather
-- than an absence, and so the postcondition below asserts something that was
-- stated rather than something that merely happened.
UPDATE public.stamp_definitions
SET    evidences_presence = false
WHERE  slug IN (
  'first_trip_created',   -- awarded at POST /api/trips, destination attached, nothing occurred
  'trip_planner',         -- same call site, same payload
  'hidden_gem_explorer',  -- awarded to the SUBMITTER on admin approval, gem's city attached
  'first_postcard',       -- postcard city attached but NOT gated on stampEligible
  'safe_return_ready',    -- opt-in, no place
  'safe_return_completed',-- no place attached
  'event_participant',    -- real check-in gate but no place attached
  'first_event_joined',
  'first_event_hosted',
  'verified_traveler'     -- identity verification, not a journey
);

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n_true       INTEGER;
  n_total      INTEGER;
  slug_name    TEXT;
  offenders    TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stamp_definitions'
      AND column_name = 'evidences_presence'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): evidences_presence is absent after the ALTER.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stamp_definitions'
      AND column_name = 'evidences_presence' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): evidences_presence is NULLABLE. A three-valued presence flag pushes the NULL decision out to 26 readers, and NULL read as anything but "not presence" is the same over-claim in a new disguise.';
  END IF;

  SELECT count(*) INTO n_total FROM public.stamp_definitions;
  SELECT count(*) INTO n_true  FROM public.stamp_definitions WHERE evidences_presence;

  -- THE VACUITY GUARD. Every assertion below is about which rows are TRUE. If
  -- the catalog were empty or tiny, "0 planning slugs are TRUE" would be true
  -- of nothing and this file would pass while having decided nothing at all.
  IF n_total < 60 THEN
    RAISE NOTICE 'VACUITY WARNING (2970): stamp_definitions holds only % row(s). This tree''s migrations seed 63 slugs, so the postconditions below are asserting over a PARTIAL catalog and prove much less than they appear to. Verify the seeding migrations (0081/0082/0145/0179/0189/0198) are all applied before trusting this run.', n_total;
  END IF;

  IF n_true = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): no definition evidences presence. The Passport''s Countries/Cities numbers would be 0 for every traveller — under-claiming past the point of meaning, and a sign the seed UPDATE matched nothing.';
  END IF;

  -- EXACT COUNT. 13 slugs are named TRUE and they all exist (preconditions), so
  -- anything else means a later migration flipped a row or the seed drifted.
  IF n_true <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): expected exactly 13 presence-evidencing definitions, found %. Either a slug outside this file''s list was set true, or the seed list was edited without updating this assertion.', n_true;
  END IF;

  -- THE ROW THIS FILE EXISTS FOR, and its neighbours, asserted BY NAME.
  offenders := ARRAY[]::TEXT[];
  FOREACH slug_name IN ARRAY ARRAY[
    'first_trip_created','trip_planner','hidden_gem_explorer','first_postcard',
    'safe_return_ready','safe_return_completed','event_participant',
    'first_event_joined','first_event_hosted','verified_traveler'
  ] LOOP
    IF EXISTS (SELECT 1 FROM public.stamp_definitions WHERE slug = slug_name AND evidences_presence) THEN
      offenders := offenders || slug_name;
    END IF;
  END LOOP;

  IF array_length(offenders, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): slug(s) % evidence presence. first_trip_created and trip_planner are awarded AT TRIP CREATION with the destination attached and no occurrence of any kind — marking either TRUE re-opens census-highlights-memories §K.4 exactly.', array_to_string(offenders, ', ');
  END IF;

  -- POSITIVE CONTROL for the assertion above: it must be possible to fail the
  -- "is TRUE" test, or the block proves nothing. A genuine visit stamp is TRUE.
  IF NOT EXISTS (
    SELECT 1 FROM public.stamp_definitions
    WHERE slug = 'first_trip_completed' AND evidences_presence
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): first_trip_completed does NOT evidence presence. A completed trip is the clearest visit this system records; if it is false, the exclusion assertions above are passing vacuously.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.stamp_definitions
    WHERE slug = 'city_explorer' AND evidences_presence
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2970): city_explorer does NOT evidence presence. It is awarded only from a GPS-VERIFIED postcard (routes/posts.ts, inside `verdict.stampEligible`) — the strongest location evidence in the system.';
  END IF;
END $$;

COMMIT;
