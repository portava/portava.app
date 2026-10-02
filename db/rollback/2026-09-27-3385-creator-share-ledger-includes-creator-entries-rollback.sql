-- Rollback for 3385_creator_share_ledger_includes_creator_entries.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3385 DID
-- =============
--   * CREATE OR REPLACE VIEW public.creator_share_ledger with a THIRD UNION ALL
--     partition over public.creator_earning_entries (same fourteen columns).
--   * Re-asserted 2930's grants (SELECT to service_role only) and comment.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores 2930's two-partition definition with CREATE OR REPLACE VIEW. The
-- column list is identical, so no DROP is needed, dependent grants survive and
-- nothing that reads the view breaks. It writes no row. What it loses is the
-- visibility of creator_earning_entries in the canonical relation — the defect
-- 3385 fixed — and services/ledger/CanonicalShareReader.ts's reconciliation will
-- then report every creator_earning_entries row as `missing_entry`, which is the
-- honest answer for a view that no longer projects them.
--
-- Deletes 3385's schema_migration_ledger row so a later apply re-runs it.

BEGIN;

CREATE OR REPLACE VIEW public.creator_share_ledger
  WITH (security_invoker = true) AS
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
SELECT
  'intel_reward_ledger'::text, irl.id, 'credit'::text, 'CREDIT'::text,
  irl.earned_units::numeric, 'creator'::text, irl.actor_id, irl.source,
  irl.ledger_version, 'contribution'::text, NULL::uuid, irl.reverses_entry_id,
  irl.cash_amount::numeric, irl.created_at
FROM public.intel_reward_ledger irl
UNION ALL
SELECT
  'rent_buddy_earnings_entries'::text, e.id, 'currency'::text, btrim(e.currency::text),
  e.amount_minor::numeric,
  CASE e.account
    WHEN 'buddy_payable'       THEN 'creator'
    WHEN 'platform_revenue'    THEN 'platform'
    WHEN 'traveler_receivable' THEN 'traveler'
    WHEN 'cash_external'       THEN 'external'
  END,
  e.beneficiary_user_id, e.entry_reason, e.rule_version, e.attribution_kind,
  e.attribution_id, e.reverses_entry_id, e.cash_settled_minor::numeric, e.occurred_at
FROM public.rent_buddy_earnings_entries e;

-- census-discovery §97 (W11-S): 2930's comment, verbatim. Until §97 this file left 3385's comment
-- on the restored view (apply plan §4.4, the ninth catalogue line).
COMMENT ON VIEW public.creator_share_ledger IS
  'THE ledger the creator share is computed from (08 §7). A projection (09 §5, "rebuildable from ledger") over public.intel_reward_ledger and public.rent_buddy_earnings_entries; it stores nothing and writes nothing. ONE ROW PER (source_entry_id, unit_kind): an intel_reward_ledger row yields its qiu and its earned_units as SEPARATE rows. AMOUNTS ARE ONLY EVER SUMMED WITHIN ONE (unit_kind, unit_code) — qiu, credits and currency minor units are not commensurable and no rate between them exists (09 arch §8, "never fabricate"). party_role distinguishes the creator leg from the platform leg; intel_reward_ledger is single-sided, so a share RATIO is undefined there rather than 100%. Not auto-updatable (UNION ALL): the canonical surface has no write path. security_invoker=true. No client grant.';

REVOKE ALL ON public.creator_share_ledger FROM PUBLIC;
REVOKE ALL ON public.creator_share_ledger FROM anon;
REVOKE ALL ON public.creator_share_ledger FROM authenticated;
REVOKE ALL ON public.creator_share_ledger FROM service_role;
GRANT SELECT ON public.creator_share_ledger TO service_role;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3385_creator_share_ledger_includes_creator_entries.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n bigint; m bigint;
BEGIN
  SELECT count(*) INTO n FROM public.creator_share_ledger WHERE source_ledger = 'creator_earning_entries';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3385 rollback): the view still projects creator_earning_entries';
  END IF;
  SELECT count(*) INTO n FROM public.creator_share_ledger;
  SELECT 2 * (SELECT count(*) FROM public.intel_reward_ledger) + (SELECT count(*) FROM public.rent_buddy_earnings_entries) INTO m;
  IF n <> m THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3385 rollback): % canonical rows, 2930''s shape expects %', n, m;
  END IF;
  IF pg_relation_is_updatable('public.creator_share_ledger'::regclass, true) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3385 rollback): the view became updatable';
  END IF;
END
$post$;
