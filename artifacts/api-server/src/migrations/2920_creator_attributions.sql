-- 2920_creator_attributions.sql
--
-- The CREATOR-TYPE dimension: attribution and versioned rules for all SIX of
-- `docs/specs/discovery-v1/07_Creator_Economy.md` §2's creator value types.
-- census-discovery DV-56, DV-58, DV-59, DV-60.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2920-2929.
--
-- ── THE DEFECT: ATTRIBUTION EXISTS PER SUBSYSTEM, NEVER PER CREATOR TYPE ────
-- `07` §2 names six types (lines 17, 20, 23, 26, 29, 32). Before this file, a
-- whole-tree grep for any of those six names matched NOTHING. What existed was
-- two SUBSYSTEM ledgers, and neither can be widened to carry a creator type:
--
--   public.intel_attributions (2277) is pinned to claim_id + observation_id and
--     Table 22's five `touch` labels. A Trail is not a claim; a Trail Builder's
--     contribution has no representation in it. It also cannot tell a Discovery
--     Creator from a Local Expert: both collapse to intel_observations.actor_id.
--   public.rent_buddy_earnings_entries (2901) carries
--     booking_id uuid NOT NULL REFERENCES public.rent_buddy_bookings(id)
--     and CONSTRAINT rbee_attribution_kind_check CHECK (attribution_kind IN ('booking')).
--     It is, correctly, a Rent-a-Buddy table.
--
-- So `07` §10's five properties held for at most two of six types. This file
-- adds the dimension rather than widening either of those tables: 2277 and 2901
-- are APPLIED and `10` §7 forbids editing an applied migration, and in any case
-- widening a booking-FK table to hold a Trail would be worse than a new one.
--
-- ── WHAT THIS FILE REFUSES TO PRETEND ──────────────────────────────────────
-- Four of the six types have no producer that records their value event, and
-- ONE (itinerary_creator) has no subject object either. An attribution row for
-- those is a SEAM, and a seam that looks like an attribution is a defect, not
-- coverage. So the honesty is STRUCTURAL, not a comment:
--
--   attribution_basis IN ('recorded_value_event','seam_no_producer')
--   CHECK ((attribution_basis = 'recorded_value_event') = (value_event_id IS NOT NULL))
--   CHECK (attribution_basis = 'recorded_value_event'
--          OR (gross_revenue_minor = 0 AND provisional_share_minor = 0))
--
-- A seam row cannot name an event it does not have, and cannot carry a share.
-- `SELECT ... WHERE attribution_basis = 'recorded_value_event'` is therefore the
-- query that means "value was really attributed", and it is not satisfiable by
-- writing seam rows.
--
-- ── PRE-MONEY, STRUCTURALLY ────────────────────────────────────────────────
-- `09` §1: "Portava moves no money." `07` §10 asks only that "earnings can be
-- recorded WITHOUT PAYING". So, following 2170:40 and 2901's shape:
--
--   settled_minor bigint NOT NULL DEFAULT 0 CHECK (settled_minor = 0)
--
-- There is no balance column, no wallet, no disbursement and no payout state on
-- this table. gross_revenue_minor and provisional_share_minor are `07` §8's
-- "store gross revenue … provisional share" — a RECORD of what a rule computed,
-- never an assertion that anything arrived. The percentages that produce them
-- stay configurable in creator_rule_versions.params (§8: "Actual percentages
-- must remain configurable"); nothing here hard-codes one.
--
-- ── RULES ARE VERSIONED, PER TYPE (§10) ────────────────────────────────────
-- creator_rule_versions is APPEND-ONLY and has no `active` column, so no UPDATE
-- grant is needed and no mutable flag decides which rule is current. The active
-- version for a type is DERIVED: the row with the greatest effective_from that
-- is not in the future. That is the same principle as the ledger's balance —
-- a fold, never a stored total — applied to configuration.
--
-- Six rows are seeded, one per type, at the generation named in
-- lib/creatorTypes.ts#CREATOR_TYPE_FACTS[*].defaultRuleVersion. They are
-- DISTINCT per type on purpose: one shared version would mean re-pricing Trails
-- silently re-prices intel, which is exactly the coupling §8 forbids.
--
-- ── FRAUD HOLDS (§9, §10) ──────────────────────────────────────────────────
-- A hold is expressed ON the attribution row (fraud_hold + fraud_hold_reason,
-- which must agree), and a held row is still RECORDED. `07` §9's controls are
-- detections; the hold is what a detection does to an earning. Suspending by
-- DELETING the attribution would destroy the evidence the detection produced.
--
-- ── COORDINATION ───────────────────────────────────────────────────────────
-- This file touches NO existing table, column, constraint, policy, grant or
-- feature-flag row. It creates two new tables and seeds six rows into one of
-- them. public.rent_buddy_earnings_ledger and public.intel_reward_ledger — both
-- of which carry live rows — are not read, not written and not altered; a
-- postcondition asserts 2170's and 2901's shapes are exactly as found.
--
-- RUNTIME EFFECT ON EXISTING SURFACES: NONE. Until this file is applied,
-- services/creators/CreatorAttributionService.ts reads a missing relation and
-- refuses with `degraded_unavailable`, which is the behaviour every deployment
-- has today. It is additionally gated fail-closed on the feature flag
-- `creator_attribution`, which this file deliberately does NOT create: an
-- absent flag reads false through lib/featureFlags.ts#isFlagEnabled, so the
-- surface stays off until an owner turns it on.
--
-- Readers: services/creators/CreatorAttributionService.ts,
--          lib/creatorTypes.ts, lib/creatorTypeAttribution.ts.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '2920: PRECONDITION FAILED: public.profiles is required for beneficiary references';
  END IF;
  IF to_regproc('public.intel_append_only') IS NULL THEN
    RAISE EXCEPTION '2920: PRECONDITION FAILED: public.intel_append_only() is required to block UPDATE';
  END IF;
  IF to_regclass('public.creator_attributions') IS NOT NULL
     OR to_regclass('public.creator_rule_versions') IS NOT NULL THEN
    RAISE EXCEPTION '2920: creator_attributions/creator_rule_versions already exist; this migration is not idempotent by design';
  END IF;
END
$pre$;

-- ── `07` §8/§10 — versioned, configurable rules, one lineage per creator type ─
CREATE TABLE IF NOT EXISTS public.creator_rule_versions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_type   text        NOT NULL,
  rule_version   text        NOT NULL,
  -- §8: "Actual percentages must remain configurable." They live HERE, as data,
  -- and no percentage appears in any CHECK or default in this file.
  params         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT now(),
  note           text        NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- `07` §2's six types, verbatim as slugs. Mirrored by CREATOR_TYPES in
  -- lib/creatorTypes.ts; src/test/creatorTypeMigrationShape.test.ts fails if
  -- the two ever disagree, and src/test/creatorTypeVocabulary.test.ts fails if
  -- lib/creatorTypes.ts drifts from the spec file itself.
  CONSTRAINT crv_creator_type_known CHECK (creator_type IN (
    'discovery_creator','trail_builder','local_expert',
    'itinerary_creator','experience_host','travel_partner')),
  CONSTRAINT crv_rule_version_shape CHECK (length(rule_version) BETWEEN 1 AND 200),
  -- One lineage per type: a type may not have two rows at the same instant, so
  -- "the greatest effective_from" is always a single row rather than a tie an
  -- ordering would have to break arbitrarily.
  CONSTRAINT crv_version_unique  UNIQUE (creator_type, rule_version),
  CONSTRAINT crv_instant_unique  UNIQUE (creator_type, effective_from)
);
COMMENT ON TABLE public.creator_rule_versions IS
  '07 §8/§10: the versioned, configurable rule set per creator value type. APPEND-ONLY and deliberately has NO active column — the current version for a type is DERIVED as the greatest effective_from not in the future, so no mutable flag decides which rule is in force. Percentages live in params; none is hard-coded anywhere (§8). Six seeded rows, one per §2 type, distinct versions so re-pricing one type cannot re-price another.';
COMMENT ON COLUMN public.creator_rule_versions.params IS
  '07 §8 "Actual percentages must remain configurable" — the whole point of this column. Seeded empty: no percentage has been decided, and inventing one would be the hard-coding §8 forbids.';

CREATE INDEX IF NOT EXISTS crv_type_effective_idx
  ON public.creator_rule_versions (creator_type, effective_from DESC);

-- ── `07` §7/§8/§10 — the multi-party attribution record ──────────────────────
CREATE TABLE IF NOT EXISTS public.creator_attributions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE DIMENSION THAT DID NOT EXIST. `07` §2.
  creator_type        text        NOT NULL,

  -- The OBJECT the contribution is attributed against. Polymorphic rather than
  -- a real FK because three of the six subject kinds resolve to relations
  -- (public.trails, public.intel_claims, public.rent_buddy_bookings), two to
  -- older relations (public.discovery_places, public.events), and ONE
  -- ('itinerary') to nothing at all — there is no published-itinerary object in
  -- this tree. A nullable FK per kind would be five mostly-null columns and a
  -- CHECK to keep them exclusive; this is the same guarantee with one column,
  -- and the missing kind is named in the COMMENT rather than hidden.
  subject_kind        text        NOT NULL,
  subject_id          uuid        NOT NULL,

  -- `07` §3's Traveler Impact outcome this attribution is FOR.
  value_event         text        NOT NULL,
  -- The row that recorded that outcome. NULL exactly when no producer exists
  -- yet -- see attribution_basis.
  value_event_id      uuid        NULL,

  -- THE HONESTY CONSTRAINT. A seam row is not an attribution and may not look
  -- like one; see the header.
  attribution_basis   text        NOT NULL,

  -- `07` §7: record the CONTRIBUTIONS before deciding payout weights. Several
  -- rows may share one (value_event, value_event_id); each names its own party.
  beneficiary_user_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  weight              numeric     NOT NULL DEFAULT 0,
  confidence          numeric     NOT NULL DEFAULT 0,

  -- `07` §8's storables. Records of a computation, never of a receipt.
  gross_revenue_minor     bigint  NOT NULL DEFAULT 0,
  provisional_share_minor bigint  NOT NULL DEFAULT 0,
  currency                char(3) NOT NULL DEFAULT 'USD',
  -- The financial-control boundary, 2170:40's shape. There is no wallet, no
  -- balance and no disbursement on this table, and a settlement is structurally
  -- impossible to record in either direction (`09` §1).
  settled_minor           bigint  NOT NULL DEFAULT 0,

  -- `07` §8/§10: which rule decided the numbers above.
  rule_version        text        NOT NULL,

  -- `07` §9/§10: a hold SUSPENDS the earning and PRESERVES the evidence.
  fraud_hold          boolean     NOT NULL DEFAULT false,
  fraud_hold_reason   text        NULL,

  -- `07` §10 "historical recalculation is possible". A recomputation is a NEW
  -- row naming the one it replaces -- 2277:36-40's principle, unchanged: never
  -- a rewrite. The superseded row stays readable under its own rule_version.
  supersedes_id       uuid        NULL REFERENCES public.creator_attributions(id),

  idempotency_key     text        NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ca_creator_type_known CHECK (creator_type IN (
    'discovery_creator','trail_builder','local_expert',
    'itinerary_creator','experience_host','travel_partner')),
  CONSTRAINT ca_subject_kind_known CHECK (subject_kind IN (
    'place','trail','intel_claim','itinerary','experience','booking')),
  -- `07` §3's seven outcomes, verbatim as slugs.
  CONSTRAINT ca_value_event_known CHECK (value_event IN (
    'save_to_trip','itinerary_adoption','verified_booking','verified_visit',
    'route_completion','repeat_use','post_visit_confirmation')),

  -- A creator type may only be attributed against ITS OWN kind of object. This
  -- is what makes the dimension real rather than decorative: without it a
  -- 'trail_builder' row could point at a booking and the type would be a label.
  CONSTRAINT ca_type_subject_agree CHECK (
    (creator_type, subject_kind) IN (
      ('discovery_creator','place'),
      ('trail_builder','trail'),
      ('local_expert','intel_claim'),
      ('itinerary_creator','itinerary'),
      ('experience_host','experience'),
      ('travel_partner','booking'))),

  CONSTRAINT ca_basis_known CHECK (
    attribution_basis IN ('recorded_value_event','seam_no_producer')),
  -- A seam names no event; a real attribution must name one.
  CONSTRAINT ca_basis_matches_event CHECK (
    (attribution_basis = 'recorded_value_event') = (value_event_id IS NOT NULL)),
  -- …and a seam carries no money figures at all. This is the constraint that
  -- makes "we have coverage" unwritable without a producer.
  CONSTRAINT ca_seam_earns_nothing CHECK (
    attribution_basis = 'recorded_value_event'
    OR (gross_revenue_minor = 0 AND provisional_share_minor = 0 AND weight = 0)),

  CONSTRAINT ca_weight_range     CHECK (weight >= 0 AND weight <= 1),
  CONSTRAINT ca_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT ca_gross_nonneg     CHECK (gross_revenue_minor >= 0),
  CONSTRAINT ca_share_nonneg     CHECK (provisional_share_minor >= 0),
  -- §8: a provisional share cannot exceed the gross it is a share OF.
  CONSTRAINT ca_share_within_gross CHECK (provisional_share_minor <= gross_revenue_minor),
  CONSTRAINT ca_no_settlement    CHECK (settled_minor = 0),
  CONSTRAINT ca_currency_shape   CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ca_rule_version_shape CHECK (length(rule_version) BETWEEN 1 AND 200),
  CONSTRAINT ca_idempotency_shape  CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  -- An unexplained hold is indistinguishable from a bug, and a reason with no
  -- hold is a claim nobody acted on. They must agree.
  CONSTRAINT ca_hold_is_explained CHECK (fraud_hold = (fraud_hold_reason IS NOT NULL)),
  CONSTRAINT ca_no_self_supersede CHECK (supersedes_id IS DISTINCT FROM id)
);

COMMENT ON TABLE public.creator_attributions IS
  '07 §7/§8/§10: the multi-party attribution record, carrying the CREATOR TYPE dimension (07 §2''s six types) that intel_attributions (2277) and rent_buddy_earnings_entries (2901) structurally cannot. Append-only; a recomputation is a new row naming supersedes_id. Records NO settlement: settled_minor = 0 is CHECK-enforced, there is no balance column and no payout state (09 §1). attribution_basis = ''seam_no_producer'' marks a row for a type whose value event has no producer yet — such a row carries no weight, no gross and no share, so a seam can never be mistaken for coverage. No client grant.';
COMMENT ON COLUMN public.creator_attributions.subject_id IS
  'The attributed object. Resolves to public.discovery_places | public.trails | public.intel_claims | public.events | public.rent_buddy_bookings by subject_kind. subject_kind = ''itinerary'' resolves to NOTHING: there is no published-itinerary relation in this tree (public.trips are private plans), so such a row is always attribution_basis = ''seam_no_producer''.';
COMMENT ON COLUMN public.creator_attributions.settled_minor IS
  '09 §1 "Portava moves no money". CHECK-constrained to 0 — the code-side twin is the refusal in lib/creatorTypeAttribution.ts. Present so a reader can ASSERT the boundary rather than assume it.';

CREATE UNIQUE INDEX IF NOT EXISTS ca_idempotency_key_once
  ON public.creator_attributions (idempotency_key);
-- At most one supersession per row: superseding twice forks history into two
-- incompatible "current" answers.
CREATE UNIQUE INDEX IF NOT EXISTS ca_one_supersede_per_row
  ON public.creator_attributions (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ca_type_subject_idx      ON public.creator_attributions (creator_type, subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS ca_beneficiary_idx       ON public.creator_attributions (beneficiary_user_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS ca_value_event_idx       ON public.creator_attributions (value_event, value_event_id)
  WHERE value_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ca_rule_version_idx      ON public.creator_attributions (creator_type, rule_version);
CREATE INDEX IF NOT EXISTS ca_fraud_hold_idx        ON public.creator_attributions (creator_type, computed_at DESC)
  WHERE fraud_hold;

-- ── Corrections are new rows ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS ca_no_update ON public.creator_attributions;
CREATE TRIGGER ca_no_update
  BEFORE UPDATE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

DROP TRIGGER IF EXISTS crv_no_update ON public.creator_rule_versions;
CREATE TRIGGER crv_no_update
  BEFORE UPDATE ON public.creator_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

-- ── RLS + grants: deny-default, no client grant at all ──────────────────────
ALTER TABLE public.creator_attributions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_rule_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.creator_attributions  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.creator_rule_versions FROM PUBLIC, anon, authenticated, service_role;

-- INSERT + SELECT: append-only. DELETE on attributions only so the
-- profiles ON DELETE CASCADE can fire for account erasure; it is not a
-- correction path and must not become one.
GRANT INSERT, SELECT, DELETE ON public.creator_attributions  TO service_role;
GRANT INSERT, SELECT         ON public.creator_rule_versions TO service_role;

-- ── §8/§10 seed: one versioned rule lineage per type, no percentages ─────────
-- Distinct effective_from per row so crv_instant_unique holds and the derived
-- "current version" read is single-valued from the first instant.
INSERT INTO public.creator_rule_versions (creator_type, rule_version, effective_from, note) VALUES
  ('discovery_creator', 'creator-rules/discovery-creator/v1', now() - interval '6 second',
   '07 §2:17 Discovery Creator. No percentages: none has been decided and inventing one is the hard-coding §8 forbids.'),
  ('trail_builder',     'creator-rules/trail-builder/v1',     now() - interval '5 second',
   '07 §2:20 Trail Builder. Subject exists (public.trails, 2910); no value-event producer.'),
  ('local_expert',      'creator-rules/local-expert/v1',      now() - interval '4 second',
   '07 §2:23 Local Expert. Producer: services/intel/RewardOracle.ts.'),
  ('itinerary_creator', 'creator-rules/itinerary-creator/v1', now() - interval '3 second',
   '07 §2:26 Itinerary Creator. No subject object and no producer; seam only.'),
  ('experience_host',   'creator-rules/experience-host/v1',   now() - interval '2 second',
   '07 §2:29 Experience Host. Subject exists (public.events); ticketing is off-platform, so no verified booking is recorded.'),
  ('travel_partner',    'creator-rules/travel-partner/v1',    now() - interval '1 second',
   '07 §2:32 Travel Partner. Producer: lib/rentBuddyEarningsLedger.ts.');

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.creator_attributions') IS NULL
     OR to_regclass('public.creator_rule_versions') IS NULL THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: a creator table was not created';
  END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname IN ('creator_attributions','creator_rule_versions')
     AND NOT c.relrowsecurity;
  IF n > 0 THEN RAISE EXCEPTION '2920: POSTCONDITION FAILED: RLS is disabled on a creator table'; END IF;

  -- ALL SIX TYPES, or the unit has narrowed compliance to the types that
  -- already had code -- the exact failure this lane exists to prevent.
  SELECT count(DISTINCT creator_type) INTO n FROM public.creator_rule_versions;
  IF n <> 6 THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: % of 07 §2''s six creator types have a rule version', n;
  END IF;
  SELECT count(DISTINCT rule_version) INTO n FROM public.creator_rule_versions;
  IF n <> 6 THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: two types share a rule version; re-pricing one would re-price another';
  END IF;

  -- The pre-money boundary, asserted rather than assumed.
  -- By NAME, not by rendered text: pg_get_constraintdef normalises literals
  -- (intel_reward_ledger's boundary reads back as `cash_amount = (0)::numeric`,
  -- not `cash_amount = 0`), so a LIKE over the rendered form is a coin-flip on
  -- the column's type. A named constraint is checkable exactly.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_attributions'::regclass AND conname = 'ca_no_settlement';
  IF n <> 1 THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: the no-settlement boundary (settled_minor = 0) is absent';
  END IF;

  -- The honesty constraint. Without it a seam row is indistinguishable from
  -- attributed value.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_attributions'::regclass
     AND conname = 'ca_seam_earns_nothing';
  IF n <> 1 THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: ca_seam_earns_nothing is absent; a seam could carry a share';
  END IF;

  -- A seam row must be unwritable with a share. Prove it rather than claim it.
  BEGIN
    INSERT INTO public.creator_attributions
      (creator_type, subject_kind, subject_id, value_event, value_event_id,
       attribution_basis, beneficiary_user_id, weight, confidence,
       gross_revenue_minor, provisional_share_minor, rule_version, idempotency_key)
    VALUES
      ('trail_builder','trail', gen_random_uuid(), 'route_completion', NULL,
       'seam_no_producer', gen_random_uuid(), 0, 0, 100, 50,
       'creator-rules/trail-builder/v1', '2920-postcondition-probe');
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: a seam row carrying a share was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;                 -- expected: ca_seam_earns_nothing
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION '2920: POSTCONDITION FAILED: the FK fired before the CHECK could; probe inconclusive';
  END;

  -- A type may not be attributed against another type's object.
  BEGIN
    INSERT INTO public.creator_attributions
      (creator_type, subject_kind, subject_id, value_event, value_event_id,
       attribution_basis, beneficiary_user_id, rule_version, idempotency_key)
    VALUES
      ('trail_builder','booking', gen_random_uuid(), 'route_completion', NULL,
       'seam_no_producer', gen_random_uuid(), 'creator-rules/trail-builder/v1', '2920-postcondition-probe-2');
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: a trail_builder was attributed against a booking';
  EXCEPTION
    WHEN check_violation THEN NULL;                 -- expected: ca_type_subject_agree
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION '2920: POSTCONDITION FAILED: the FK fired before the CHECK could; probe inconclusive';
  END;

  IF has_table_privilege('service_role', 'public.creator_attributions', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_rule_versions', 'UPDATE') THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: service_role has UPDATE. Corrections are new rows.';
  END IF;
  IF has_table_privilege('service_role', 'public.creator_rule_versions', 'DELETE') THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: a rule version can be deleted; history would be unreconstructable';
  END IF;
  IF has_table_privilege('authenticated', 'public.creator_attributions', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_attributions', 'SELECT') THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: a client role can read attribution rows (07 §3: no raw public score)';
  END IF;

  -- The two live ledgers must be EXACTLY as this migration found them.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname = 'intel_reward_ledger_cash_amount_check';
  IF n <> 1 THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: intel_reward_ledger''s cash boundary is missing; this migration must touch nothing there';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_ledger'::regclass
     AND conname = 'rent_buddy_earnings_ledger_booking_id_key';
  IF n <> 1 THEN
    RAISE EXCEPTION '2920: POSTCONDITION FAILED: rent_buddy_earnings_ledger was modified. This migration is additive and must touch nothing there.';
  END IF;
END
$post$;

COMMIT;

-- REVERSAL (exact, and lossless for every pre-existing row):
--
--   DROP TRIGGER IF EXISTS ca_no_update  ON public.creator_attributions;
--   DROP TRIGGER IF EXISTS crv_no_update ON public.creator_rule_versions;
--   DROP TABLE IF EXISTS public.creator_attributions;
--   DROP TABLE IF EXISTS public.creator_rule_versions;
--
-- NO EXISTING ROW OF ANY OTHER TABLE IS TOUCHED IN EITHER DIRECTION. This file
-- creates two new tables and inserts six rows into one of them, so reversing it
-- restores the schema byte-for-byte and leaves intel_reward_ledger and
-- rent_buddy_earnings_ledger — both of which carry live rows — untouched. Drop
-- creator_attributions FIRST: it holds no FK to creator_rule_versions (the
-- rule_version is a text stamp by design, so a row stays readable under a
-- version even after the lineage is pruned), but the order is stated so a
-- reverser does not have to work it out under pressure.
--
-- What reversing DOES destroy is every attribution recorded since — and with it
-- the only per-creator-type record of who contributed what. Reverse only while
-- abandoning the unit.
