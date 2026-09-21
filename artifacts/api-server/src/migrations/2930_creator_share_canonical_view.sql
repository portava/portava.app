-- 2930_creator_share_canonical_view.sql
-- ONE ledger relation the creator share is computed from, spanning both
-- physical earnings ledgers, WITHOUT inventing a conversion between their units.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── THE PROPERTY THAT IS VIOLATED ───────────────────────────────────────────
-- `08` §7 (specs/discovery-v1/08_Portava_Revenue_Model.md, last bullet):
-- "Revenue architecture is healthy when … attribution is auditable, creator
-- share can be computed from THE SAME LEDGER."
--
-- Today it cannot, because there is no "the". Earnings are recorded in TWO
-- unrelated relations:
--
--   public.intel_reward_ledger          (2170 + 2900) — contributors, NON-CASH,
--                                        qiu numeric + earned_units integer,
--                                        CHECK (cash_amount = 0), single-sided:
--                                        every row credits actor_id and nothing
--                                        records a platform counterpart.
--   public.rent_buddy_earnings_entries  (2901)        — marketplace, DOUBLE
--                                        ENTRY, signed amount_minor bigint +
--                                        currency char(3),
--                                        CHECK (cash_settled_minor = 0).
--
-- A creator who is both a contributor and a buddy has a share in each and no
-- relation in which both appear. "The same ledger" has no referent.
--
-- ── WHY A VIEW, AND WHICH SENTENCE PERMITS IT ───────────────────────────────
-- `09` §5 (specs/discovery-v1/09_Payment_Architecture.md, "Wallet"):
--
--     "Wallet is a projection: pending balance, available balance, lifetime
--      earned, paid, held. REBUILDABLE FROM LEDGER."
--
-- The spec's own model of a party's standing is a PROJECTION over ledger
-- entries that stores nothing. A SQL view is exactly that object: it has no
-- rows, no writer, no state, and cannot drift from what it projects, because
-- it IS the projection evaluated on read. `08` §7 asks that the share be
-- COMPUTABLE FROM the ledger; it does not ask that the ledger be one heap.
--
-- `10` §1 settles the alternative: "Extend existing canonical tables where
-- appropriate. AVOID PARALLEL SYSTEMS." A third physical earnings table that
-- copied or re-homed these rows would be the parallel system that sentence
-- forbids — two places a balance could be read from, and therefore two places
-- it could be read from differently. After this file there is exactly ONE
-- relation the creator share is computed from, public.creator_share_ledger,
-- and the two tables above are its storage partitions rather than rival
-- sources. The revenue leg (platform_revenue) and the creator leg
-- (buddy_payable) are rows of THE SAME relation, which is what the previous
-- bullet's "attribution is auditable" needs in order to be answerable in one
-- query.
--
-- `10` §7 is the other half of the argument: "never edit an applied migration",
-- and 2170, 2900 and 2901 are applied. Reshaping a table that has live rows to
-- make it hold the other table's unit is the one option here that can lose
-- something. This file writes no row, alters no table, drops no constraint and
-- changes no grant.
--
-- ── THE HARD PART: TWO UNIT SYSTEMS, AND NO RATE BETWEEN THEM ───────────────
-- qiu, earned_units (non-cash credits) and USD minor units are NOT
-- commensurable, and nothing in this repository says what any of them is worth
-- in terms of another:
--
--   * lib/rewardEarnings.ts QIU_TO_CREDITS = 100 converts qiu -> credits, but
--     BOTH are already recorded on every intel_reward_ledger row. Applying it
--     in this view would restate the same earning twice, not convert it.
--   * There is no credit -> currency rate anywhere. 2170's header is explicit —
--     "Stamps/credits; no cash" — and public.fx_rates holds ECB reference rates
--     between CURRENCIES only (docs/architecture/09_Payment_Architecture.md §2).
--
-- So this view does not add them, and the shape is what refuses to:
--
--   ONE ROW PER (source_entry_id, unit_kind). unit_kind is a GROUPING KEY, not
--   a label. A total is only ever taken within one (unit_kind, unit_code), so
--   there is no expression in which a qiu and a cent meet.
--
-- That is the repository's own standing rule about absent rates, applied here.
-- docs/architecture/09_Payment_Architecture.md §8: "NEVER FABRICATE. convert()
-- returns null when a rate is missing and the caller shows the original
-- amount … a missing rate is a REFUSAL TO BOOK, not a guess"; and §5.3 I4,
-- "no currency mixing inside one entry pair". `09` §8 in the spec says the same
-- from the other side: "Record source currency and settlement currency
-- separately."
--
-- One intel_reward_ledger row therefore projects to TWO canonical rows (its qiu
-- and its earned_units) and one rent_buddy_earnings_entries row to ONE. That
-- fan-out is lossless and invertible: (source_ledger, source_entry_id,
-- unit_kind) is unique, and the postcondition below proves the projection
-- reconstructs each source table's totals exactly, per unit, in both
-- directions.
--
-- ── WHAT "SHARE" MEANS HERE, AND WHAT IT REFUSES TO MEAN ────────────────────
-- `08` §5 lists "creator/host share" beside "gross booking value, Portava fee,
-- … net payout" — an AMOUNT, not a percentage. So the share is the creator's
-- own signed total per unit, and it is computable from this view for both
-- ledgers. A RATIO additionally needs a denominator, and only
-- rent_buddy_earnings_entries records one: it books the platform's take as a
-- platform_revenue leg of the same transaction. intel_reward_ledger books no
-- counterpart at all, so its denominator is ABSENT, not 100%. party_role below
-- is what lets a reader see that difference instead of assuming it away; the
-- fold in lib/creatorShareCanonical.ts returns a null ratio there rather than
-- a fabricated 1.0.
--
-- ── LOSSLESS, IN THE ONLY SENSE THAT COUNTS ─────────────────────────────────
-- No row is read at migration time, none is written, copied, renamed or
-- re-interpreted. Every identifier survives verbatim: source_entry_id IS the
-- base table's id. A view carries no data of its own, so "preserve existing
-- entries" is not a promise this file makes and might break — it is a property
-- of the file containing no DML.
--
-- ── APPEND-ONLY IS STRENGTHENED, NOT PRESERVED-BY-LUCK ──────────────────────
-- A UNION ALL view is NOT auto-updatable in PostgreSQL, so the canonical
-- surface has no write path at all: there is nothing to grant and nothing to
-- revoke. pg_relation_is_updatable() is asserted to be 0 in the postconditions,
-- so if a later edit collapses the UNION into something writable this migration
-- refuses rather than quietly opening a door into two append-only ledgers.
-- The base tables' grants and CHECKs are re-asserted below, unchanged, so the
-- diff shows they were considered: service_role still has no UPDATE on either,
-- and both cash_* boundaries are still in force.
--
-- security_invoker = true is load-bearing (`10` §6: SECURITY DEFINER only when
-- necessary). Without it the view would evaluate as its OWNER, which is exactly
-- the definer-shaped RLS bypass that section warns about; with it, a reader
-- sees only what its own role may see on the base tables. No client grant at
-- all, which is 2901's posture rather than rent_buddy_earnings_ledger's
-- (`09` §10: money data is restricted, structurally).
--
-- ── INDEXING (`10` §4), STATED RATHER THAN GUESSED ──────────────────────────
-- EXPECTED CARDINALITY TODAY IS ZERO on both partitions: intel_rewards is
-- seeded OFF (2170) and rent_buddy_enabled is seeded FALSE (2210) with booking
-- creation hard-blocked by lib/rentBuddyKycGate.ts. The creator-side path —
-- "one creator's entries" — is already served: intel_reward_ledger_actor_created_idx
-- (actor_id, created_at DESC) from 2170 and rbee_beneficiary_idx
-- (beneficiary_user_id, occurred_at DESC) from 2901. The platform-side pairing
-- (attribution_id -> platform_revenue legs) has NO index and will scan. NO
-- INDEX IS ADDED FOR IT HERE: with zero rows an EXPLAIN proves nothing, and
-- `10` §4 asks for an index RATIONALE, which a guess is not. It is named here
-- so the first real workload adds it deliberately.
--
-- RUNTIME EFFECT: NONE. This file creates one read-only view and grants SELECT
-- on it to service_role. No existing reader or writer changes behaviour, no
-- flag is touched, and no payment path is created or moved.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_reward_ledger does not exist (2170 not applied).';
  END IF;
  IF to_regclass('public.rent_buddy_earnings_entries') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.rent_buddy_earnings_entries does not exist (2901 not applied).';
  END IF;
  -- 2900 is what makes a NEGATIVE reward row expressible. Without it the qiu
  -- partition can only ever be non-negative and a reversal could not net, so
  -- the canonical fold would silently overstate every corrected contributor.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'intel_reward_ledger'
       AND column_name = 'reverses_entry_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_reward_ledger.reverses_entry_id absent (2900 not applied).';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- The canonical relation.
--
-- COLUMN CONTRACT, because (unit_kind, unit_code) is the only thing standing
-- between a reader and a fabricated total:
--
--   ('currency', <ISO 4217>)  amount is signed MINOR units of that currency
--   ('credit',   'CREDIT')    amount is a signed whole count of non-cash credits
--   ('qiu',      'QIU')       amount is a signed exact numeric of quality-intel
--                             units; it has no fixed scale and is not money
--
-- SUMMING ACROSS unit_kind OR unit_code IS A BUG, ALWAYS. There is no rate.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.creator_share_ledger
  WITH (security_invoker = true) AS

-- ── Partition 1a: the non-cash contributor ledger, qiu ──────────────────────
SELECT
  'intel_reward_ledger'::text          AS source_ledger,
  irl.id                               AS source_entry_id,
  'qiu'::text                          AS unit_kind,
  'QIU'::text                          AS unit_code,
  irl.qiu::numeric                     AS amount,
  -- Single-sided by construction: 2170 books one row per earning, crediting
  -- actor_id, and records no platform counterpart anywhere.
  'creator'::text                      AS party_role,
  irl.actor_id                         AS creator_id,
  irl.source                           AS entry_reason,
  irl.ledger_version                   AS rule_version,
  'contribution'::text                 AS attribution_kind,
  -- NULL, not a stand-in. This ledger carries no attribution id; `09` §5.3 I7
  -- ("absence is not permitted to be silent") is served by saying so rather
  -- than by reusing the entry's own id as if it were a cause.
  NULL::uuid                           AS attribution_id,
  irl.reverses_entry_id                AS reverses_source_entry_id,
  -- CHECK (cash_amount = 0) at 2170:40, surfaced so a reader can ASSERT the
  -- financial-control boundary from the canonical relation rather than assume it.
  irl.cash_amount::numeric             AS cash_recorded,
  irl.created_at                       AS occurred_at
FROM public.intel_reward_ledger irl

UNION ALL

-- ── Partition 1b: the same ledger's OTHER unit ──────────────────────────────
-- A second row, never a conversion of the first. Both figures are recorded
-- independently on the source row; folding one into the other via
-- QIU_TO_CREDITS would restate a single earning twice.
SELECT
  'intel_reward_ledger'::text,
  irl.id,
  'credit'::text,
  'CREDIT'::text,
  irl.earned_units::numeric,
  'creator'::text,
  irl.actor_id,
  irl.source,
  irl.ledger_version,
  'contribution'::text,
  NULL::uuid,
  irl.reverses_entry_id,
  irl.cash_amount::numeric,
  irl.created_at
FROM public.intel_reward_ledger irl

UNION ALL

-- ── Partition 2: the marketplace double-entry ledger ────────────────────────
SELECT
  'rent_buddy_earnings_entries'::text,
  e.id,
  'currency'::text,
  btrim(e.currency::text),
  e.amount_minor::numeric,
  -- 2901's rbee_account_check fixes this domain to exactly four values, so the
  -- CASE is total and the ELSE is unreachable rather than a catch-all.
  CASE e.account
    WHEN 'buddy_payable'       THEN 'creator'
    WHEN 'platform_revenue'    THEN 'platform'
    WHEN 'traveler_receivable' THEN 'traveler'
    WHEN 'cash_external'       THEN 'external'
  END,
  e.beneficiary_user_id,
  e.entry_reason,
  e.rule_version,
  e.attribution_kind,
  e.attribution_id,
  e.reverses_entry_id,
  e.cash_settled_minor::numeric,
  e.occurred_at
FROM public.rent_buddy_earnings_entries e;

COMMENT ON VIEW public.creator_share_ledger IS
  'THE ledger the creator share is computed from (08 §7). A projection (09 §5, "rebuildable from ledger") over public.intel_reward_ledger and public.rent_buddy_earnings_entries; it stores nothing and writes nothing. ONE ROW PER (source_entry_id, unit_kind): an intel_reward_ledger row yields its qiu and its earned_units as SEPARATE rows. AMOUNTS ARE ONLY EVER SUMMED WITHIN ONE (unit_kind, unit_code) — qiu, credits and currency minor units are not commensurable and no rate between them exists (09 arch §8, "never fabricate"). party_role distinguishes the creator leg from the platform leg; intel_reward_ledger is single-sided, so a share RATIO is undefined there rather than 100%. Not auto-updatable (UNION ALL): the canonical surface has no write path. security_invoker=true. No client grant.';

-- ── Grants: read-only, service_role only (2901 posture, `09` §10) ───────────
REVOKE ALL ON public.creator_share_ledger FROM PUBLIC;
REVOKE ALL ON public.creator_share_ledger FROM anon;
REVOKE ALL ON public.creator_share_ledger FROM authenticated;
REVOKE ALL ON public.creator_share_ledger FROM service_role;
GRANT SELECT ON public.creator_share_ledger TO service_role;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  n              int;
  opts           text[];
  n_irl          bigint;
  n_rbee         bigint;
  n_canon        bigint;
  src_qiu        numeric;
  can_qiu        numeric;
  src_credits    numeric;
  can_credits    numeric;
  src_minor      numeric;
  can_minor      numeric;
  n_dup          bigint;
  n_orphan       bigint;
BEGIN
  -- 1. It is a VIEW, not a table. A table here would be the parallel system
  --    `10` §1 forbids, and would have rows of its own that could go stale.
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'creator_share_ledger' AND c.relkind = 'v';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.creator_share_ledger is not a view';
  END IF;

  -- 2. security_invoker is on. Without it the view is a definer-shaped bypass.
  SELECT c.reloptions INTO opts FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'creator_share_ledger';
  IF opts IS NULL OR NOT ('security_invoker=true' = ANY (opts)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: creator_share_ledger is not security_invoker=true (10 §6)';
  END IF;

  -- 3. NO WRITE PATH. A UNION ALL view is not auto-updatable; if a later edit
  --    makes it updatable, two append-only ledgers acquire a back door.
  IF pg_relation_is_updatable('public.creator_share_ledger'::regclass, true) <> 0 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: creator_share_ledger is updatable. The canonical surface must have no write path into the base ledgers.';
  END IF;

  -- 4. No client role can read money data through it (`09` §10).
  IF has_table_privilege('authenticated', 'public.creator_share_ledger', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_share_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can read creator_share_ledger';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.creator_share_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot read creator_share_ledger';
  END IF;
  IF has_table_privilege('service_role', 'public.creator_share_ledger', 'INSERT')
     OR has_table_privilege('service_role', 'public.creator_share_ledger', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_share_ledger', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a write privilege exists on creator_share_ledger';
  END IF;

  -- 5. THE BASE LEDGERS ARE EXACTLY AS THIS MIGRATION FOUND THEM.
  IF has_table_privilege('service_role', 'public.intel_reward_ledger', 'UPDATE')
     OR has_table_privilege('service_role', 'public.rent_buddy_earnings_entries', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role gained UPDATE on a base ledger. Corrections are new rows.';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname = 'intel_reward_ledger_cash_amount_check';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: CHECK (cash_amount = 0) is gone from intel_reward_ledger';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
     AND pg_get_constraintdef(oid) LIKE '%cash_settled_minor = 0%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the no-settlement boundary is gone from rent_buddy_earnings_entries';
  END IF;

  -- 6. RECONCILIATION, BOTH DIRECTIONS, PER UNIT.
  --    Forward: every source row is projected, exactly once per unit it carries.
  --    Backward: every canonical row names a source row that exists.
  SELECT count(*) INTO n_irl  FROM public.intel_reward_ledger;
  SELECT count(*) INTO n_rbee FROM public.rent_buddy_earnings_entries;
  SELECT count(*) INTO n_canon FROM public.creator_share_ledger;
  IF n_canon <> (2 * n_irl + n_rbee) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: canonical row count % <> 2*% + % — the projection lost or invented rows',
      n_canon, n_irl, n_rbee;
  END IF;

  SELECT count(*) INTO n_dup FROM (
    SELECT source_ledger, source_entry_id, unit_kind
      FROM public.creator_share_ledger
     GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) d;
  IF n_dup <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: (source_ledger, source_entry_id, unit_kind) is not unique — % duplicate key(s)', n_dup;
  END IF;

  SELECT count(*) INTO n_orphan
    FROM public.creator_share_ledger v
   WHERE (v.source_ledger = 'intel_reward_ledger'
          AND NOT EXISTS (SELECT 1 FROM public.intel_reward_ledger t WHERE t.id = v.source_entry_id))
      OR (v.source_ledger = 'rent_buddy_earnings_entries'
          AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_earnings_entries t WHERE t.id = v.source_entry_id))
      OR v.source_ledger NOT IN ('intel_reward_ledger', 'rent_buddy_earnings_entries');
  IF n_orphan <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % canonical row(s) name no source entry', n_orphan;
  END IF;

  SELECT coalesce(sum(qiu), 0), coalesce(sum(earned_units), 0)
    INTO src_qiu, src_credits FROM public.intel_reward_ledger;
  SELECT coalesce(sum(amount_minor), 0) INTO src_minor FROM public.rent_buddy_earnings_entries;
  SELECT coalesce(sum(amount) FILTER (WHERE unit_kind = 'qiu'), 0),
         coalesce(sum(amount) FILTER (WHERE unit_kind = 'credit'), 0),
         coalesce(sum(amount) FILTER (WHERE unit_kind = 'currency'), 0)
    INTO can_qiu, can_credits, can_minor FROM public.creator_share_ledger;
  IF can_qiu <> src_qiu OR can_credits <> src_credits OR can_minor <> src_minor THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: per-unit totals disagree — qiu %/% credits %/% minor %/%',
      can_qiu, src_qiu, can_credits, src_credits, can_minor, src_minor;
  END IF;

  -- 7. Every row carries a unit. A NULL unit_kind is an amount nobody can add up.
  SELECT count(*) INTO n FROM public.creator_share_ledger
   WHERE unit_kind IS NULL OR unit_code IS NULL OR party_role IS NULL OR amount IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % canonical row(s) carry a NULL unit, role or amount', n;
  END IF;

  -- 8. The boundary holds on the canonical surface too.
  SELECT count(*) INTO n FROM public.creator_share_ledger WHERE cash_recorded <> 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % canonical row(s) record settled cash. No payment path exists.', n;
  END IF;

  -- VACUITY IS VISIBLE, NOT HIDDEN. Both ledgers ship flag-gated OFF, so on a
  -- fresh database every equality above holds over zero rows. The seeded
  -- portava-ci rehearsal and src/test/creatorShareCanonicalProperties.test.ts
  -- are what make the claim non-vacuous; this NOTICE records which it was.
  RAISE NOTICE
    '2930 reconciliation: intel_reward_ledger=% row(s), rent_buddy_earnings_entries=% row(s), creator_share_ledger=% row(s)%',
    n_irl, n_rbee, n_canon,
    CASE WHEN n_irl = 0 AND n_rbee = 0 THEN ' — VACUOUS (both ledgers empty)' ELSE '' END;
END $$;

COMMIT;

-- REVERSAL (exact, complete, and lossless in BOTH directions):
--
--   DROP VIEW IF EXISTS public.creator_share_ledger;
--
-- That is the whole of it. This file creates one view and grants SELECT on it;
-- it writes no row, alters no table, adds no column, drops no constraint and
-- changes no grant on anything else. Dropping the view therefore returns the
-- schema to exactly the state it was in before — and destroys nothing, because
-- a view holds no data. What is lost is the ABILITY to compute the creator
-- share from one relation; the two ledgers keep every row and every identifier
-- they had, and the per-ledger reads that existed before this file keep working
-- unchanged.
