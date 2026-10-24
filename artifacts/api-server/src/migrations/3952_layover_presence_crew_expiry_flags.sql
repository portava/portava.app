-- 3952_layover_presence_crew_expiry_flags.sql
--
-- census-layover L196 ("Create presence/crew tables with restrictive policies and expiration jobs"), lane LAYOVER,
-- census drive batch 3 (2026-10-24, lead instruction after #781's verification). APPLIED TO NO DATABASE by the lane
-- that wrote it.
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- TWO feature-flag rows, both seeded FALSE, and nothing else: no table, column, index, function or privilege.
--   layover_presence_expiry_enabled  read by lib/layoverPresenceExpiryScheduler.ts (the presence phase of its tick)
--   layover_crew_expiry_enabled      read by lib/layoverCrewExpiryScheduler.ts
-- Each is read fail-closed (`isFlagEnabled`) BEFORE the sweep's probe:
--   OFF / absent / unreadable (the seed): the sweep issues NO statement against its table and deletes nothing.
--     Expired rows stay hidden from every reader at their own `expires_at` (each reader's `.gt("expires_at", now)`;
--     the list is in census-layover §84 and pinned by test/layoverExpiryReadersHideExpired.test.ts).
--   ON: expired rows are deleted in batches, the exact complement of the readers' filter.
--
-- ── WHY FLAGS, AND WHY THEY SHIP OFF ───────────────────────────────────────
-- Until this file both sweeps deleted at their own `expires_at` with no flag (census-layover §82.4 said so). That
-- horizon is a READ filter in 2984 ("a FILTER, not a promise") and 3900 ("Not a retention promise"); no spec line,
-- owner ruling or lead ruling sets it as a retention period (OD-1012-LAY-3 asked for a proposal and
-- docs/ops/layover-retention-proposal-L261-20261012.md is unapproved). 3950 made the same call for check-ins: deleting
-- production rows is the owner's decision, taken by turning a flag on, never a side effect of a deploy. The lead ruled
-- the same for these two (2026-10-23).
--
-- ── ORDER INDEPENDENCE ─────────────────────────────────────────────────────
-- Depends only on public.feature_flags (0118; columns flag, enabled, description). No file numbered above 3952
-- alters, drops or truncates feature_flags or names either flag. A plain INSERT writes no feature_flag_audit_log row.
--
-- Rollback: db/rollback/2026-10-24-3952-layover-presence-crew-expiry-flags-rollback.sql (refuses while either flag is
-- TRUE or while feature_flag_audit_log holds a row for either).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3952: public.feature_flags does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name IN ('flag', 'enabled', 'description')) <> 3 THEN
    RAISE EXCEPTION '3952: public.feature_flags lacks one of flag / enabled / description';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled') AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION '3952: a layover expiry flag already exists and is not FALSE; this file seeds both OFF and will not overwrite an operator''s setting';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_presence_expiry_enabled',
    false,
    'Layover presence retention (census-layover L196; migration 3952). ON: the presence expiry scheduler (lib/layoverPresenceExpiryScheduler.ts) deletes public.layover_presence rows whose expires_at has passed, in batches; no answer changes because every reader already hides them. OFF / absent / unreadable (the seed): nothing is deleted and no statement is issued against the table. Turning it ON is the owner''s retention decision (OD-1012-LAY-3; the L261 proposal is unapproved).'
  ),
  (
    'layover_crew_expiry_enabled',
    false,
    'Layover crew retention (census-layover L196; migration 3952). ON: the crew expiry scheduler (lib/layoverCrewExpiryScheduler.ts) deletes public.layover_crews rows whose expires_at has passed (their memberships, plans and location grants go by ON DELETE CASCADE), in batches; no answer changes because every reader already hides them. OFF / absent / unreadable (the seed): nothing is deleted and no statement is issued against the table. Turning it ON is the owner''s retention decision (OD-1012-LAY-3).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled');
  IF n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3952): expected both layover expiry flags, found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags
   WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled') AND enabled IS NOT FALSE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3952): a layover expiry flag is ON; both must ship OFF';
  END IF;
END
$post$;
