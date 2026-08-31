-- 2220_map_contribution_claim_types.sql
-- Freshness policies for the four §22 map-contribution claim types.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION
-- ========================================
-- 4-digit prefix in the 2100-2999 band (src/scripts/migrationPrefixRules.ts).
--
-- WHAT THIS DOES
-- ==============
-- Seeds four rows in public.freshness_policies:
--
--   crowd.direction   900    /  2700   (15 min / hard 45 min)
--   vibe.state        1800   /  5400   (30 min / hard 90 min)
--   event.status      3600   / 21600   (60 min / hard  6 h)
--   closure.state     21600  / 86400   ( 6 h  / hard 24 h)
--
-- and nothing else. No table, no column, no policy, no grant, no feature flag.
--
-- WHY THESE ROWS ARE NOT OPTIONAL
-- ===============================
-- src/lib/freshnessPolicy.ts treats an UNKNOWN claim_type as STALE and returns
-- no expiry (fail-closed). Without these rows the four claim types would be
-- capturable — the validators in lib/quickSignal admit them — and then
-- permanently un-live, which is a silent hole rather than a loud one. The
-- capture path is what makes this migration owed: POST /api/map/observations
-- now maps vibe / event_status / closure / crowd_direction onto them.
--
-- THE THREE-WAY MIRROR, AND WHICH FILE OWNS WHICH ROWS
-- ====================================================
-- There are three seed sites and they are deliberately disjoint. Nothing here
-- touches the other two:
--
--   2122  the four FLAT types (crowd, vibe, price, structural). Mirrored by
--         SEED_FRESHNESS_POLICIES in src/lib/freshnessPolicy.ts, which is
--         described there as "the single source of truth for the seed" — for
--         THAT seed. It is left exactly as it is. In particular the flat 'vibe'
--         row (1800s) is NOT the dotted 'vibe.state' row added below: they are
--         different keys, and freshnessPolicy looks up by exact key. The TTL is
--         reused on purpose (see below), the row is not.
--
--   2128  the thirteen dotted Phase-1 types. Mirrors PHASE1_CLAIM_TYPES in
--         src/lib/intelContracts.ts. Untouched.
--
--   2220  this file. Mirrors MAP_CONTRIBUTION_CLAIM_TYPES in the same module.
--
-- src/test/mapContributionClaimTypes.test.ts pins this file against
-- MAP_CONTRIBUTION_CLAIM_TYPES and asserts it seeds NO row belonging to either
-- of the other two lists, so the three-way split cannot quietly merge.
--
-- ON CONFLICT DO NOTHING, for the reason 2128 states at length: 2122 shipped a
-- DO UPDATE seed whose re-apply silently reverts every owner-tuned ttl_seconds.
-- A claim type already present keeps its tuned value; re-applying this file is
-- a no-op by construction, asserted at the end rather than assumed.
--
-- WHY THESE FOUR TTLs
-- ===================
-- The full argument is in MAP_CONTRIBUTION_CLAIM_TYPES' header comment; the
-- short form, because the numbers are the part an operator will retune:
--
--   crowd.direction  Flow is more volatile than intensity — 'arriving' is what
--                    stops the moment everyone has arrived — so it must not
--                    outlive crowd.level (2700s). 900s is the blueprint's
--                    original crowd default; the 2700s ceiling is exactly one
--                    crowd.level TTL.
--
--   vibe.state       1800s is the blueprint's own answer for atmosphere,
--                    deliberately reused rather than re-litigated. Ceiling at
--                    three TTLs: ninety minutes on it is a different crowd, and
--                    no confirmation should keep the ORIGINAL report alive.
--
--   event.status     A conservative fixed proxy for one phase of an event, and
--                    honestly a proxy: the §22 payload carries no schedule and
--                    intel_observations.subject_id FKs public.places, not an
--                    events table, so a genuinely event-bound expiry is not
--                    expressible yet. A three-hour-old 'starting_soon' is not
--                    merely stale, it is misleading — hence 60 min, ceiling 6 h.
--                    Retire this row when an event subject carries a schedule.
--
--   closure.state    Nearly structural, and deliberately NOT given a structural
--                    TTL. Both error directions hurt (a wrong 'temporarily_
--                    closed' turns people away from an open business; a wrong
--                    'open' sends them to a shut one) and, unlike crowd level,
--                    nobody re-taps a closure every quarter hour to correct it.
--                    Expiry is this claim's only self-healing mechanism, so it
--                    is set to a business day's operational span with a 24-hour
--                    ceiling past which the map stops asserting anything.
--                    The flat 'structural' policy (180 days) is for hours of
--                    operation from an owner or an official source — never for
--                    a stranger's single tap. 'permanently_closed' additionally
--                    carries a standing never-live bar in code
--                    (STRUCTURAL_CLOSURE_STATES / CLAIM_TYPE_LIVE_LABEL_RULING).
--
-- All four are ordinary data rows: the owner may UPDATE any ttl_seconds or
-- hard_expiry_seconds without a migration, and re-applying this file will not
-- undo that.
--
-- RUNTIME EFFECT: these rows go live the moment BOTH map_contributions_enabled
-- and intel_capture_quick_signal are on. Until then the capture route is an
-- inert no-op and the rows are unread reference data.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
-- Fail loudly rather than seeding into a shape this file does not expect.
DO $$
BEGIN
  IF to_regclass('public.freshness_policies') IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: public.freshness_policies does not exist. Apply 2122_freshness_policies.sql to this target first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'freshness_policies'
       AND column_name  = 'hard_expiry_seconds'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: freshness_policies.hard_expiry_seconds is missing. Apply 2128_intel_contracts_seed.sql to this target first.';
  END IF;
END $$;

-- ── Seed ────────────────────────────────────────────────────────────────────
-- Mirrors MAP_CONTRIBUTION_CLAIM_TYPES in src/lib/intelContracts.ts. The two are
-- pinned together by src/test/mapContributionClaimTypes.test.ts; change both or
-- neither.
INSERT INTO public.freshness_policies (claim_type, ttl_seconds, hard_expiry_seconds, note) VALUES
  ('crowd.direction', 900,   2700,  'Direction of crowd FLOW (not intensity) — 15 min, hard 45 min.'),
  ('vibe.state',      1800,  5400,  'Venue atmosphere — 30 min, hard 90 min.'),
  ('event.status',    3600,  21600, 'Event lifecycle phase — 60 min, hard 6 h. Fixed proxy until an event subject carries a schedule.'),
  ('closure.state',   21600, 86400, 'Open / closed operational state — 6 h, hard 24 h. Never a structural permanent-closure fact.')
ON CONFLICT (claim_type) DO NOTHING;

-- ── Postcondition ───────────────────────────────────────────────────────────
DO $$
DECLARE
  seeded_types int;
  bad_ceiling  int;
BEGIN
  SELECT count(*) INTO seeded_types
    FROM public.freshness_policies
   WHERE claim_type IN ('crowd.direction','vibe.state','event.status','closure.state');
  IF seeded_types <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 4 map-contribution claim types present, found %', seeded_types;
  END IF;

  SELECT count(*) INTO bad_ceiling
    FROM public.freshness_policies
   WHERE hard_expiry_seconds IS NOT NULL AND hard_expiry_seconds < ttl_seconds;
  IF bad_ceiling > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % row(s) have hard_expiry_seconds < ttl_seconds', bad_ceiling;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Data-only and safely reversible, but read this first: removing these rows
-- does NOT disable the capture path. lib/freshnessPolicy fails closed, so the
-- four claim types would still be capturable and would simply never be live or
-- expire. To actually stop the capture, turn OFF map_contributions_enabled.
--
--   DELETE FROM public.freshness_policies
--    WHERE claim_type IN ('crowd.direction','vibe.state','event.status','closure.state');
--
-- Any owner-tuned TTL is lost by that DELETE; capture the current values first.
