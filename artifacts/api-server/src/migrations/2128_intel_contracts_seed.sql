-- 2128_intel_contracts_seed.sql
-- Intelligence Gathering IG-01 — contract seed. Reference data only.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION
-- ========================================
-- 4-digit prefix in the 2100-2999 band (src/scripts/migrationPrefixRules.ts).
-- Prefix 2128 deliberately skips 2124-2127, which are reserved for the Journey
-- observation files currently unpushed in the Replit workspace. This is the
-- third numbering collision in this band; leaving the gap is cheaper than a
-- fourth renumber.
--
-- WHAT THIS DOES
-- ==============
--   1. Adds freshness_policies.hard_expiry_seconds — the ceiling past which a
--      claim can never be extended, which the table has no way to express today.
--   2. Seeds the thirteen Phase-1 claim types (dotted `family.type` namespace).
-- It deliberately seeds NO feature-flag rows — see section 3.
--
-- RUNTIME EFFECT: NONE. No route reads any of this yet; the rows are inert
-- until IG-02/IG-03 wire a producer.
--
-- ── THE CLOBBER FIX, WHICH IS THE REASON THIS FILE IS NOT A ONE-LINER ────────
-- 2122_freshness_policies.sql seeds with ON CONFLICT (claim_type) DO UPDATE, and
-- its own header promises the owner may retune any ttl_seconds without a
-- migration. Those two statements contradict each other: re-applying 2122
-- silently reverts every tuned value. This file therefore uses
-- ON CONFLICT DO NOTHING: a claim type already present keeps its owner-tuned
-- TTL. Re-applying this migration is a no-op by construction. That property is
-- asserted at the end rather than assumed, and pinned by intelContracts.test.ts.
--
-- ── WHY THE FLAT CLAIM TYPES ARE NOT DELETED ────────────────────────────────
-- 2122 seeded four flat types (crowd, vibe, price, structural). The thirteen
-- dotted types REPLACE them semantically, but lib/freshnessPolicy.ts treats an
-- unknown claim_type as stale (fail-closed), so deleting the flat rows would
-- change behaviour for any reader still passing them. They are left in place and
-- retired in the unit that removes their last reader. Additive only.

BEGIN;

-- ── Precondition ────────────────────────────────────────────────────────────
-- Fail loudly rather than seeding into a shape this file does not expect.
DO $$
BEGIN
  IF to_regclass('public.freshness_policies') IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: public.freshness_policies does not exist. Apply 2122_freshness_policies.sql to this target first.';
  END IF;
END $$;

-- ── 1. Hard expiry ceiling ──────────────────────────────────────────────────
-- Nullable: a policy with no ceiling is legitimate (a claim family may be
-- extendable indefinitely by fresh evidence). NULL means "no hard ceiling",
-- which is why this is not NOT NULL with a default.
ALTER TABLE public.freshness_policies
  ADD COLUMN IF NOT EXISTS hard_expiry_seconds integer;

COMMENT ON COLUMN public.freshness_policies.hard_expiry_seconds IS
  'Ceiling in seconds past which a claim of this type may never be extended, even by fresh qualifying evidence. NULL means no ceiling. Distinct from ttl_seconds, which is when the claim stops being live.';

ALTER TABLE public.freshness_policies
  DROP CONSTRAINT IF EXISTS freshness_policies_hard_expiry_check;
ALTER TABLE public.freshness_policies
  ADD CONSTRAINT freshness_policies_hard_expiry_check
  CHECK (hard_expiry_seconds IS NULL OR hard_expiry_seconds >= ttl_seconds);

-- ── 2. Claim-type registry ──────────────────────────────────────────────────
-- Mirrors CLAIM_TYPES in src/lib/intelContracts.ts. The two are pinned together
-- by src/test/intelContracts.test.ts; change both or neither.
INSERT INTO public.freshness_policies (claim_type, ttl_seconds, hard_expiry_seconds, note) VALUES
  ('crowd.level',          2700,    7200,    'How busy it is — 45 min, hard 120 min.'),
  ('crowd.trajectory',     2700,    5400,    'Direction of change — 45 min, hard 90 min.'),
  ('queue.wait',           1200,    2700,    'Queue wait — 20 min, hard 45 min.'),
  ('access.walk_in',       1800,    7200,    'Walk-in acceptance — 30 min.'),
  ('access.reservation',   1209600, 7776000, 'Reservation policy — 14 days, hard 90 days.'),
  ('access.dress',         1814400, 7776000, 'Dress policy — 21 days, hard 90 days.'),
  ('price.cover',          604800,  7776000, 'Cover price — 7 days, hard 90 days.'),
  ('crowd.mix',            5400,    10800,   'Crowd composition bands — 90 min, hard 180 min.'),
  ('music.current',        5400,    10800,   'Current genre — 90 min, hard 180 min.'),
  ('inventory.status',     1800,    86400,   'Item/service availability — 30 min, hard 1 day.'),
  ('service.wait',         2700,    7200,    'Service wait — 45 min.'),
  ('transit.condition',    1800,    86400,   'Route/mode condition — 30 min; official clearance may end it sooner.'),
  ('experience.next_move', 1800,    5400,    'Aggregate next-stop movement — 30 min. Cohort-gated.')
ON CONFLICT (claim_type) DO NOTHING;

-- ── 3. Feature flags — DELIBERATELY NOT SEEDED HERE ────────────────────────
-- The eight intel_* flag NAMES and their dependency chain are declared in
-- src/lib/intelContracts.ts, but no feature_flags row is created here.
--
-- WHY. scripts/check-flag-polarity.mjs refuses a flag that is seeded in a
-- migration and read by nothing under src/ ("SEEDED BUT NEVER READ"), and it is
-- right to: a flag row with no reader is dead config that an operator can toggle
-- expecting an effect. IG-01 has no readers by design — it is a contracts unit
-- with zero runtime effect. Each flag row is therefore seeded by the unit that
-- introduces its first reader (IG-03 for capture, IG-04 for projection, and so
-- on), together with that flag's CLASSIFIED entry.
--
-- Declaring the names here without rows costs nothing and keeps one vocabulary.

-- ── Postcondition ───────────────────────────────────────────────────────────
-- Assert what this migration promised, in the 2084 style: the rows exist, the
-- ceiling is coherent.
DO $$
DECLARE
  seeded_types int;
  bad_ceiling int;
BEGIN
  SELECT count(*) INTO seeded_types
    FROM public.freshness_policies
   WHERE claim_type IN (
     'crowd.level','crowd.trajectory','queue.wait','access.walk_in',
     'access.reservation','access.dress','price.cover','crowd.mix',
     'music.current','inventory.status','service.wait','transit.condition',
     'experience.next_move');
  IF seeded_types <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 13 dotted claim types present, found %', seeded_types;
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
-- Data-only and safely reversible:
--   DELETE FROM public.freshness_policies WHERE claim_type LIKE '%.%';
--   ALTER TABLE public.freshness_policies DROP COLUMN IF EXISTS hard_expiry_seconds;
-- Dropping the column loses owner-set ceilings; capture them first if any have
-- been tuned. Nothing reads these rows until IG-02, so reversal before then is
-- inert.
