-- 2085_converge_absent_seeded_flags.sql
--
-- OUTCOME: KEEP — apply the existing seed. Six flags that ARE seeded by a
-- migration, ARE read by shipping code, and are MISSING from production.
--
--   MEDIA_ACTIVE_CREATOR_BOOST_ENABLED     2040:7   read MediaFeedRankingService.ts:902
--   MEDIA_NEW_CREATOR_BOOST_ENABLED        2040:9   read MediaFeedRankingService.ts:903
--   MEDIA_RETURNING_CREATOR_BOOST_ENABLED  2040:11  read MediaFeedRankingService.ts:904
--   MEDIA_UNDEREXPOSED_BOOST_ENABLED       2040:13  read MediaFeedRankingService.ts:905
--   MEDIA_CREATOR_FATIGUE_ENABLED          2040:15  read MediaFeedRankingService.ts:906
--   rent_buddy_allow_bookings_without_kyc  2074:37  read lib/rentBuddyKycGate.ts:62
--
-- Unlike 2084 — which adds definitions the repository never had — these six are
-- already defined. The repository is right and PRODUCTION is the side missing
-- the row. This migration exists because an applied migration does not re-run:
-- neither 2040 nor 2074 will ever create these rows again on a database that has
-- already passed them.
--
-- ALL FIVE OF 2040'S FLAGS ARE ABSENT — THAT MIGRATION NEVER RAN
-- ==============================================================
--
-- 2040 seeds exactly these five MEDIA_* names in ONE statement with
-- ON CONFLICT DO NOTHING. A single statement cannot insert partially, so the
-- explanation is not five separate deletions: 2040 was never applied to
-- production. Recorded in docs/ops/data-seed-drift.md, where a sweep of every
-- data-seeding migration confirmed it is valid SQL that simply never ran.
--
-- The consequence today is benign, which is why this is a convergence and not an
-- incident: all five seed `false`, and getFlagDefaults() initialises every one to
-- `false` before its query and leaves it there when the row is absent. Media
-- ranking runs base-score-only either way. Creating the rows changes no
-- behaviour; it makes the operator surface honest and gives the flags somewhere
-- to be toggled from.
--
-- ⚠ rent_buddy_allow_bookings_without_kyc — ABSENT IS THE SAFE STATE
-- ==================================================================
--
-- This is the override permitting Rent-a-Buddy booking creation WHILE IDENTITY
-- VERIFICATION IS NON-OPERATIONAL. rentBuddyKycGate.ts:38 describes enabling it
-- as "an explicit statement that you accept unverified strangers meeting in
-- person." Production has no working KYC provider: both real adapters are stubs
-- and the mock is refused in production.
--
-- It is read through isFlagEnabled(), which returns false on any DB error, so a
-- MISSING ROW READS false AND THE GATE STAYS CLOSED. Production is in the safe
-- state precisely because the row is absent.
--
-- So this migration seeds it **false** — the value 2074 seeds — and then ASSERTS
-- that value. Creating this row must never be the thing that opens bookings. If
-- the override is ever wanted, that is a deliberate, logged toggle against a row
-- that reads false, not a side effect of a drift reconciliation.
--
-- SCOPE: creates rows only. No reader, no seed and no other flag is touched.

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('MEDIA_ACTIVE_CREATOR_BOOST_ENABLED', false,
   'Apply an active-creator boost to posts from creators who post regularly. Diminishing-returns curve; configurable ceiling.'),
  ('MEDIA_NEW_CREATOR_BOOST_ENABLED', false,
   'Grant new creators an evaluation window where their first posts receive a fair-test boost, making them discoverable.'),
  ('MEDIA_RETURNING_CREATOR_BOOST_ENABLED', false,
   'Give a temporary recovery boost to creators returning after ≥N days of inactivity.'),
  ('MEDIA_UNDEREXPOSED_BOOST_ENABLED', false,
   'Surface items with low view-count relative to their age so quality posts get a fair test before being buried.'),
  ('MEDIA_CREATOR_FATIGUE_ENABLED', false,
   'Deprioritise creators the viewer has already seen many times in the current session (per-session fatigue layer).'),
  ('rent_buddy_allow_bookings_without_kyc', false,
   'Override: permit Rent-a-Buddy booking creation while identity verification is non-operational. Unsafe; for supervised pilots only.')
ON CONFLICT (flag) DO NOTHING;

-- ── Post-condition: all six present ─────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag IN (
     'MEDIA_ACTIVE_CREATOR_BOOST_ENABLED',
     'MEDIA_NEW_CREATOR_BOOST_ENABLED',
     'MEDIA_RETURNING_CREATOR_BOOST_ENABLED',
     'MEDIA_UNDEREXPOSED_BOOST_ENABLED',
     'MEDIA_CREATOR_FATIGUE_ENABLED',
     'rent_buddy_allow_bookings_without_kyc'
   );

  IF n <> 6 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: expected 6 converged flags present, found %.', n;
  END IF;
END $$;

-- ── Post-condition: the KYC override must read FALSE ────────────────────────
-- The whole point of the row is that it reads false. If this database already
-- had it true, that is a pre-existing decision this migration must not ratify by
-- passing quietly — it stops and makes someone look.
DO $$
DECLARE
  v boolean;
BEGIN
  SELECT enabled INTO v
    FROM public.feature_flags
   WHERE flag = 'rent_buddy_allow_bookings_without_kyc';

  IF v IS DISTINCT FROM false THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: rent_buddy_allow_bookings_without_kyc is %, expected false. '
      'This flag permits bookings with NO working identity verification. It must not be left on '
      'by a reconciliation migration. Investigate who enabled it before proceeding.', v;
  END IF;
END $$;

-- ── Post-condition: the five MEDIA_* boosts must all read FALSE ─────────────
-- Same argument, lower stakes: 2040's seeded default is false for all five, and
-- a convergence that switched a ranking boost on would be a behaviour change
-- smuggled in as a drift fix.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(flag, ', ') INTO bad
    FROM public.feature_flags
   WHERE flag IN (
     'MEDIA_ACTIVE_CREATOR_BOOST_ENABLED',
     'MEDIA_NEW_CREATOR_BOOST_ENABLED',
     'MEDIA_RETURNING_CREATOR_BOOST_ENABLED',
     'MEDIA_UNDEREXPOSED_BOOST_ENABLED',
     'MEDIA_CREATOR_FATIGUE_ENABLED'
   )
     AND enabled IS DISTINCT FROM false;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % should read false (2040 seeded default) but does not. '
      'If an operator deliberately enabled it, remove it from this assertion; do not flip the row.', bad;
  END IF;
END $$;

COMMIT;
