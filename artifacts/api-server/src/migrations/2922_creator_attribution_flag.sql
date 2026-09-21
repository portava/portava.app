-- 2922_creator_attribution_flag.sql
-- Creator economy — the ONE capability flag `CreatorAttributionService` reads,
-- seeded OFF. Lane 2922.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Additive + idempotent. Safe to re-run.
--
-- WHY THIS FILE EXISTS, stated rather than implied.
--
-- 2920 and 2921 shipped `creator_attributions` and `creator_earning_entries`
-- together with a service that gates every read and every write on
-- `isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG)` — and NO MIGRATION SEEDED THE
-- ROW. `check:flag-polarity` calls that a PHANTOM FLAG and it is exactly right:
--
--   "The gate LOOKS deliberate and is not. It cannot be turned on without
--    shipping a migration first."
--
-- `isFlagEnabled` returns false for an absent row, so the whole subsystem was
-- off in a way no owner could reverse and no operator could see. That is worse
-- than off: it is off while presenting as a decision somebody made.
--
-- The flag was also named `creator_attribution`, matching neither naming
-- convention, so the same check reported it UNCLASSIFIED. It is renamed to
-- `creator_attribution_enabled` in the same change — `*_enabled` is the
-- CAPABILITY convention, which is what this gate is: read fail-closed through
-- `isFlagEnabled`, so an unreadable flag leaves attribution OFF and can never
-- leave it silently on.
--
-- WHAT THE FLAG GATES (services/creators/CreatorAttributionService.ts):
--   * recording a creator attribution for any of `07` §2's six creator types;
--   * booking a creator earning entry against a recorded attribution;
--   * placing and explaining a fraud hold;
--   * recomputing a creator's historical total under an older rule version.
-- With it OFF every one of those refuses with `disabled` and writes nothing.
--
-- WHY OFF: nothing calls this service from a route or a scheduler yet, both
-- ledgers hold zero rows, and four of the six creator types have no value-event
-- producer at all (census-discovery §17.2). Enabling it is an owner decision
-- and is NOT made here.
--
-- RUNTIME EFFECT: NONE. The row's absence and the row set to false produce
-- byte-identical behaviour from every caller; what changes is that an owner can
-- now flip it without shipping SQL, and that an operator reading feature_flags
-- can see the capability exists.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, OFF) ───────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'creator_attribution_enabled',
    false,
    'Creator economy attribution and earnings (07 §2 six creator types), as ONE switch: recording a creator_attributions row, booking a balanced creator_earning_entries pair against it, placing an explained fraud hold, and recomputing a historical total under an older rule version. OFF (the seed): every one of those refuses with `disabled` and writes nothing. Fail-closed (isFlagEnabled) — an unreadable flag leaves attribution off, never silently on. Read by services/creators/CreatorAttributionService.ts (CREATOR_ATTRIBUTION_FLAG, literal name). Nothing calls that service from a route or scheduler yet and both ledgers hold zero rows, so enabling this is an owner decision and changes nothing until a producer exists.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF) ────────────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'creator_attribution_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected creator_attribution_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'creator_attribution_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: creator_attribution_enabled seeded ON — no producer exists and this must ship OFF';
  END IF;
  -- The old, never-seeded name must not have been created by anything else in
  -- the meantime: two rows would mean two gates and one of them unreachable.
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'creator_attribution';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the pre-rename name creator_attribution exists as a row; no code reads it, so it is a gate nothing can reach';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag = 'creator_attribution_enabled';
-- The reversal removes a disabled capability flag; no served data changes, and
-- every caller returns to refusing with `disabled` exactly as it does now.
