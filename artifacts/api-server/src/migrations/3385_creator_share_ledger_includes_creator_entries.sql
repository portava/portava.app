-- 3385_creator_share_ledger_includes_creator_entries.sql
-- census-discovery DV-64 (`08` §7 "creator share can be computed from the
-- same ledger"). Depends on 2921 and 2930.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- 2930 made public.creator_share_ledger THE relation the creator share is
-- computed from, and projected TWO physical ledgers into it:
-- intel_reward_ledger (2170/2900) and rent_buddy_earnings_entries (2901).
--
-- It never projected the THIRD. public.creator_earning_entries (2921) is the
-- ledger that "earnings can be recorded without paying" (`07` §10) was built
-- on for all six of `07` §2's creator types, and not one of its rows reaches
-- the canonical relation. So an earning booked through
-- services/creators/CreatorAttributionService.ts#recordCreatorEarning is a
-- creator's money that the one ledger the share is "computable from" cannot
-- see: the share read over creator_share_ledger silently under-states every
-- creator who has one. 2930's header argues that after it "there is exactly
-- ONE relation the creator share is computed from" — true of the two ledgers
-- it knew about, false the moment 2921 existed beside it.
--
-- ── THE FIX, AND WHY IT IS THE SAME SHAPE AS 2930 ───────────────────────────
-- `CREATE OR REPLACE VIEW` with the SAME fourteen columns, in the same order,
-- and a third UNION ALL partition. Nothing else. No table is altered, no row
-- is read at migration time except by the postconditions, none is written.
--
-- 2921's rows are signed MINOR units of a currency, exactly like 2901's, so
-- they project to unit_kind 'currency' and nothing is converted. Its account
-- vocabulary differs from 2901's in ONE word — `creator_payable` where 2901
-- has `buddy_payable` — and both map to party_role 'creator'. The CASE is
-- total over 2921's cee_account_known domain and has no ELSE, for 2930's
-- reason: an unmapped future account must fail the postcondition rather than
-- silently become somebody's money or vanish.
--
--   attribution_kind  := the entry's creator_type (one of `07` §2's six). 2901
--                        says 'booking' and 2170 says 'contribution'; here the
--                        kind of attribution IS the creator type, and carrying it
--                        lets a per-type share be read without a join.
--   attribution_id    := creator_earning_entries.attribution_id, the FK to
--                        public.creator_attributions (2920) — so every canonical
--                        row from this partition names the attribution it came
--                        from, which is `09` §11's "attribution is linked".
--
-- ── ONE EARNING, ONE LEDGER ─────────────────────────────────────────────────
-- A view that unions three ledgers double-counts any earning booked in two of
-- them. 2930:40-50 already refuses a "third physical earnings table that
-- copied or re-homed these rows". The code-side half of that rule is
-- lib/creatorTypes.ts#CREATOR_TYPE_FACTS[*].subsystemEarningLedger: a Travel
-- Partner's earning is booked in rent_buddy_earnings_entries by the booking
-- routes, a Local Expert's in intel_reward_ledger by the reward pass, and
-- CreatorAttributionService refuses to book either of them a second time in
-- creator_earning_entries (`booked_in_subsystem_ledger`). The totals stay
-- per (source_ledger, unit) in lib/creatorShareCanonical.ts, so even a
-- mistaken double booking would show as two rows rather than one sum.
--
-- ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────────────
-- security_invoker = true, the grants (SELECT to service_role, nothing to any
-- client role), the absence of any write path (UNION ALL is not
-- auto-updatable), and every column 2930 exposed. The postconditions below are
-- 2930's, re-derived over three partitions.
--
-- RUNTIME EFFECT: none on any existing surface. services/ledger/CanonicalShareReader.ts
-- reads the view (and reads the third base ledger for its independent
-- reconciliation in the same change); no route reads it outside
-- routes/creatorEconomy.ts, which is gated on creator_attribution_enabled (2922,
-- seeded FALSE).
--
-- Rollback: db/rollback/2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.creator_share_ledger') IS NULL THEN
    RAISE EXCEPTION '3385: PRECONDITION FAILED: public.creator_share_ledger does not exist (2930 not applied).';
  END IF;
  IF to_regclass('public.creator_earning_entries') IS NULL THEN
    RAISE EXCEPTION '3385: PRECONDITION FAILED: public.creator_earning_entries does not exist (2921 not applied).';
  END IF;
  -- The account domain the CASE below must be total over. If 2921's CHECK ever
  -- admits a fifth account, this file is wrong about it and must say so.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.creator_earning_entries'::regclass
       AND conname = 'cee_account_known'
  ) THEN
    RAISE EXCEPTION '3385: PRECONDITION FAILED: cee_account_known is absent; the account->role CASE cannot be proven total.';
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.creator_share_ledger
  WITH (security_invoker = true) AS

-- ── Partition 1a: the non-cash contributor ledger, qiu (2930, unchanged) ────
SELECT
  'intel_reward_ledger'::text          AS source_ledger,
  irl.id                               AS source_entry_id,
  'qiu'::text                          AS unit_kind,
  'QIU'::text                          AS unit_code,
  irl.qiu::numeric                     AS amount,
  'creator'::text                      AS party_role,
  irl.actor_id                         AS creator_id,
  irl.source                           AS entry_reason,
  irl.ledger_version                   AS rule_version,
  'contribution'::text                 AS attribution_kind,
  NULL::uuid                           AS attribution_id,
  irl.reverses_entry_id                AS reverses_source_entry_id,
  irl.cash_amount::numeric             AS cash_recorded,
  irl.created_at                       AS occurred_at
FROM public.intel_reward_ledger irl

UNION ALL

-- ── Partition 1b: the same ledger's OTHER unit (2930, unchanged) ────────────
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

-- ── Partition 2: the marketplace double-entry ledger (2930, unchanged) ──────
SELECT
  'rent_buddy_earnings_entries'::text,
  e.id,
  'currency'::text,
  btrim(e.currency::text),
  e.amount_minor::numeric,
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
FROM public.rent_buddy_earnings_entries e

UNION ALL

-- ── Partition 3: the creator-type double-entry ledger (2921) — NEW ──────────
SELECT
  'creator_earning_entries'::text,
  c.id,
  'currency'::text,
  btrim(c.currency::text),
  c.amount_minor::numeric,
  -- 2921's cee_account_known fixes this domain to exactly four values, so the
  -- CASE is total and there is no ELSE (see the header).
  CASE c.account
    WHEN 'creator_payable'     THEN 'creator'
    WHEN 'platform_revenue'    THEN 'platform'
    WHEN 'traveler_receivable' THEN 'traveler'
    WHEN 'cash_external'       THEN 'external'
  END,
  c.beneficiary_user_id,
  c.entry_reason,
  c.rule_version,
  c.creator_type,
  c.attribution_id,
  c.reverses_entry_id,
  c.cash_settled_minor::numeric,
  c.occurred_at
FROM public.creator_earning_entries c;

COMMENT ON VIEW public.creator_share_ledger IS
  'THE ledger the creator share is computed from (08 §7). A projection (09 §5, "rebuildable from ledger") over public.intel_reward_ledger, public.rent_buddy_earnings_entries and — since 3385 — public.creator_earning_entries; it stores nothing and writes nothing. ONE ROW PER (source_ledger, source_entry_id, unit_kind): an intel_reward_ledger row yields its qiu and its earned_units as SEPARATE rows. AMOUNTS ARE ONLY EVER SUMMED WITHIN ONE (unit_kind, unit_code) — qiu, credits and currency minor units are not commensurable and no rate between them exists. party_role distinguishes the creator leg from the platform leg; intel_reward_ledger is single-sided, so a share RATIO is undefined there rather than 100%. For creator_earning_entries rows attribution_kind is the 07 §2 creator type and attribution_id is the creator_attributions row the earning came from. Not auto-updatable (UNION ALL): the canonical surface has no write path. security_invoker=true. No client grant.';

-- ── Grants: re-asserted, unchanged from 2930 ────────────────────────────────
REVOKE ALL ON public.creator_share_ledger FROM PUBLIC;
REVOKE ALL ON public.creator_share_ledger FROM anon;
REVOKE ALL ON public.creator_share_ledger FROM authenticated;
REVOKE ALL ON public.creator_share_ledger FROM service_role;
GRANT SELECT ON public.creator_share_ledger TO service_role;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  n          int;
  opts       text[];
  n_irl      bigint;
  n_rbee     bigint;
  n_cee      bigint;
  n_canon    bigint;
  n_dup      bigint;
  n_orphan   bigint;
  src_qiu    numeric; can_qiu    numeric;
  src_cred   numeric; can_cred   numeric;
  src_rbee   numeric; can_rbee   numeric;
  src_cee    numeric; can_cee    numeric;
BEGIN
  -- 1. Still a view, still security_invoker, still unwritable.
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'creator_share_ledger' AND c.relkind = 'v';
  IF n <> 1 THEN RAISE EXCEPTION '3385: POSTCONDITION FAILED: creator_share_ledger is not a view'; END IF;

  SELECT c.reloptions INTO opts FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'creator_share_ledger';
  IF opts IS NULL OR NOT ('security_invoker=true' = ANY (opts)) THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: creator_share_ledger is not security_invoker=true (10 §6)';
  END IF;

  IF pg_relation_is_updatable('public.creator_share_ledger'::regclass, true) <> 0 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: creator_share_ledger is updatable; the canonical surface must have no write path.';
  END IF;

  -- 2. Grants: service_role SELECT only.
  IF has_table_privilege('authenticated', 'public.creator_share_ledger', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_share_ledger', 'SELECT') THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: a client role can read creator_share_ledger';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.creator_share_ledger', 'SELECT') THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: service_role cannot read creator_share_ledger';
  END IF;
  IF has_table_privilege('service_role', 'public.creator_share_ledger', 'INSERT')
     OR has_table_privilege('service_role', 'public.creator_share_ledger', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_share_ledger', 'DELETE') THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: a write privilege exists on creator_share_ledger';
  END IF;

  -- 3. The third base ledger kept its append-only posture and cash boundary.
  IF has_table_privilege('service_role', 'public.creator_earning_entries', 'UPDATE') THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: service_role has UPDATE on creator_earning_entries. Corrections are new rows.';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND conname = 'cee_no_settlement';
  IF n <> 1 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: the no-settlement boundary is gone from creator_earning_entries';
  END IF;

  -- 4. RECONCILIATION, ALL THREE PARTITIONS, BOTH DIRECTIONS, PER UNIT.
  SELECT count(*) INTO n_irl  FROM public.intel_reward_ledger;
  SELECT count(*) INTO n_rbee FROM public.rent_buddy_earnings_entries;
  SELECT count(*) INTO n_cee  FROM public.creator_earning_entries;
  SELECT count(*) INTO n_canon FROM public.creator_share_ledger;
  IF n_canon <> (2 * n_irl + n_rbee + n_cee) THEN
    RAISE EXCEPTION
      '3385: POSTCONDITION FAILED: canonical row count % <> 2*% + % + % — the projection lost or invented rows',
      n_canon, n_irl, n_rbee, n_cee;
  END IF;

  SELECT count(*) INTO n_dup FROM (
    SELECT source_ledger, source_entry_id, unit_kind
      FROM public.creator_share_ledger
     GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) d;
  IF n_dup <> 0 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: (source_ledger, source_entry_id, unit_kind) is not unique — % duplicate key(s)', n_dup;
  END IF;

  SELECT count(*) INTO n_orphan
    FROM public.creator_share_ledger v
   WHERE (v.source_ledger = 'intel_reward_ledger'
          AND NOT EXISTS (SELECT 1 FROM public.intel_reward_ledger t WHERE t.id = v.source_entry_id))
      OR (v.source_ledger = 'rent_buddy_earnings_entries'
          AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_earnings_entries t WHERE t.id = v.source_entry_id))
      OR (v.source_ledger = 'creator_earning_entries'
          AND NOT EXISTS (SELECT 1 FROM public.creator_earning_entries t WHERE t.id = v.source_entry_id))
      OR v.source_ledger NOT IN ('intel_reward_ledger', 'rent_buddy_earnings_entries', 'creator_earning_entries');
  IF n_orphan <> 0 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: % canonical row(s) name no source entry', n_orphan;
  END IF;

  -- Per unit AND per source ledger: the two currency partitions are reconciled
  -- separately, so a row moved from one to the other cannot hide inside a sum
  -- that is still correct overall.
  SELECT coalesce(sum(qiu), 0), coalesce(sum(earned_units), 0)
    INTO src_qiu, src_cred FROM public.intel_reward_ledger;
  SELECT coalesce(sum(amount_minor), 0) INTO src_rbee FROM public.rent_buddy_earnings_entries;
  SELECT coalesce(sum(amount_minor), 0) INTO src_cee  FROM public.creator_earning_entries;
  SELECT coalesce(sum(amount) FILTER (WHERE unit_kind = 'qiu'), 0),
         coalesce(sum(amount) FILTER (WHERE unit_kind = 'credit'), 0),
         coalesce(sum(amount) FILTER (WHERE source_ledger = 'rent_buddy_earnings_entries'), 0),
         coalesce(sum(amount) FILTER (WHERE source_ledger = 'creator_earning_entries'), 0)
    INTO can_qiu, can_cred, can_rbee, can_cee FROM public.creator_share_ledger;
  IF can_qiu <> src_qiu OR can_cred <> src_cred OR can_rbee <> src_rbee OR can_cee <> src_cee THEN
    RAISE EXCEPTION
      '3385: POSTCONDITION FAILED: per-ledger totals disagree — qiu %/% credits %/% rbee %/% cee %/%',
      can_qiu, src_qiu, can_cred, src_cred, can_rbee, src_rbee, can_cee, src_cee;
  END IF;

  -- 5. Every row carries a unit and a role. A NULL party_role on a
  --    creator_earning_entries row would mean the CASE is not total.
  SELECT count(*) INTO n FROM public.creator_share_ledger
   WHERE unit_kind IS NULL OR unit_code IS NULL OR party_role IS NULL OR amount IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: % canonical row(s) carry a NULL unit, role or amount', n;
  END IF;

  -- 6. Every creator_earning_entries row names its attribution on the canonical
  --    surface (09 §11 "attribution is linked").
  SELECT count(*) INTO n FROM public.creator_share_ledger
   WHERE source_ledger = 'creator_earning_entries' AND attribution_id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: % creator_earning_entries row(s) reach the canonical ledger with no attribution', n;
  END IF;

  -- 7. The boundary holds on the canonical surface too.
  SELECT count(*) INTO n FROM public.creator_share_ledger WHERE cash_recorded <> 0;
  IF n <> 0 THEN
    RAISE EXCEPTION '3385: POSTCONDITION FAILED: % canonical row(s) record settled cash. No payment path exists.', n;
  END IF;

  RAISE NOTICE
    '3385 reconciliation: intel_reward_ledger=%, rent_buddy_earnings_entries=%, creator_earning_entries=%, creator_share_ledger=% row(s)%',
    n_irl, n_rbee, n_cee, n_canon,
    CASE WHEN n_irl = 0 AND n_rbee = 0 AND n_cee = 0 THEN ' — VACUOUS (all three ledgers empty)' ELSE '' END;
END
$post$;

COMMIT;

-- REVERSAL: db/rollback/2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql
-- restores 2930's two-partition definition with CREATE OR REPLACE VIEW (same
-- fourteen columns, so no DROP is needed and the grants survive). It writes no
-- row; what it loses is creator_earning_entries' visibility in the canonical
-- relation, i.e. exactly the defect this file fixes.
