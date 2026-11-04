-- 3952_layover_presence_crew_expiry_flags.sql
--
-- census-layover L196 ("Create presence/crew tables with restrictive policies and expiration jobs"), lane LAYOVER,
-- census drive batch 3 (2026-10-24, lead instruction after #781's verification; CORRECTED the same day on the owner's
-- directive below). APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- TWO feature-flag rows, both seeded TRUE, and nothing else: no table, column, index, function or privilege.
--   layover_presence_expiry_enabled  read by lib/layoverPresenceExpiryScheduler.ts (the presence phase of its tick)
--   layover_crew_expiry_enabled      read by lib/layoverCrewExpiryScheduler.ts
-- Each sweep reads its flag BEFORE its probe, through the four-state reader (on / off / absent / unreadable):
--   TRUE (the seed), absent, unreadable: expired rows are deleted in batches at their own `expires_at`, the exact
--     complement of the readers' `.gt("expires_at", now)` filter. This is what production does TODAY, with no flag.
--   FALSE, explicitly: the sweep issues NO statement against its table and deletes nothing.
--     OFF = retention extended, only by explicit owner action. Expired rows then stay in storage, hidden from every
--     reader at their own `expires_at` (census-layover §84; test/layoverExpiryReadersHideExpired.test.ts).
--
-- ── WHY TRUE, AND WHY "UNKNOWN" MEANS DELETE ───────────────────────────────
-- Owner directive (2026-10-24): "Do NOT expand retention without authorization." Before this file both sweeps deleted
-- at `expires_at` on production with no flag (census-layover §82.4). A FALSE seed would STOP that deletion on deploy
-- and keep presence and crew-location data indefinitely: an expansion of retention nobody authorised. So the seed
-- preserves production's behaviour, and the owner can turn either sweep OFF. For the same reason an absent or
-- unreadable flag must not silently stop deletion: "fail closed" here means "keep the current, shorter retention",
-- because stopping the DELETE is the action that needs authority, not continuing it. The retention period itself is
-- still OD-1012-LAY-3; docs/ops/layover-retention-proposal-L261-20261012.md recommends "live data deleted at its own
-- expiry" as the default. (3950's check-in sweep is different and stays FALSE: it never ran on production, so its OFF
-- seed expands nothing.)
--
-- ── ORDER INDEPENDENCE ─────────────────────────────────────────────────────
-- Depends only on public.feature_flags (0118; columns flag, enabled, description). No file numbered above 3952
-- alters, drops or truncates feature_flags or names either flag. A plain INSERT writes no feature_flag_audit_log row.
-- ON CONFLICT DO NOTHING: an operator's existing row (TRUE or FALSE) is never overwritten.
--
-- Rollback: db/rollback/2026-10-24-3952-layover-presence-crew-expiry-flags-rollback.sql (refuses while either flag is
-- FALSE, the owner's retention choice, or while feature_flag_audit_log holds a row for either). Removing a TRUE row is
-- behaviour-neutral: absent deletes exactly as TRUE does.

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
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_presence_expiry_enabled',
    true,
    'Layover presence retention (census-layover L196; migration 3952). TRUE (the seed), absent or unreadable: the presence expiry scheduler (lib/layoverPresenceExpiryScheduler.ts) deletes public.layover_presence rows whose expires_at has passed, in batches, as production did before 3952; no answer changes because every reader already hides them. FALSE: nothing is deleted and no statement is issued against the table. OFF = retention extended, only by explicit owner action (owner directive 2026-10-24: do not expand retention without authorization; the period is OD-1012-LAY-3).'
  ),
  (
    'layover_crew_expiry_enabled',
    true,
    'Layover crew retention (census-layover L196; migration 3952). TRUE (the seed), absent or unreadable: the crew expiry scheduler (lib/layoverCrewExpiryScheduler.ts) deletes public.layover_crews rows whose expires_at has passed (their memberships, plans and location grants go by ON DELETE CASCADE), in batches, as production did before 3952; no answer changes because every reader already hides them. FALSE: nothing is deleted and no statement is issued against the table. OFF = retention extended, only by explicit owner action (owner directive 2026-10-24; OD-1012-LAY-3).'
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
   WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled') AND enabled IS FALSE;
  IF n <> 0 THEN
    RAISE NOTICE '3952: % layover expiry flag(s) were already FALSE and were left as set (an operator''s retention choice; OFF = retention extended)', n;
  END IF;
END
$post$;
