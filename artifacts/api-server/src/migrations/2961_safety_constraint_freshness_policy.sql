-- 2961_safety_constraint_freshness_policy.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Carries ONE row that
-- arrived on the Replit branch as an in-place edit to an ALREADY-APPLIED
-- migration, which is why it needs a file of its own.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT JUST "RE-RUN 2128"
-- ══════════════════════════════════════════════════════════════════════════════
-- 2128_intel_contracts_seed.sql is applied. The incoming branch added
-- 'safety.constraint' by editing 2128's INSERT list in place. Two things make
-- that unusable:
--
--   1. Editing an applied migration changes its checksum, which is exactly the
--      edit drift schema_migration_ledger exists to detect. The ledger would
--      start reporting a file that no longer matches what ran.
--   2. It would not work anyway. 2128's INSERT ends ON CONFLICT (claim_type) DO
--      NOTHING, and every OTHER claim_type in that list is already present, so a
--      replay is a no-op per row — but the statement as a whole would still run.
--      The real problem is that nothing replays an applied migration, so the new
--      row would simply never arrive. Verified: 'safety.constraint' is absent
--      from BOTH prod (ajrurzioarfkagpuxfnb) and CI (hwokxgbmezheskbzskfr).
--
-- So 2128 is left byte-for-byte alone and the row comes forward here.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NO CHECK CONSTRAINT STANDS IN THE WAY — CHECKED, NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- public.freshness_policies carries exactly one CHECK, and it is about the
-- numbers, not the vocabulary:
--
--   freshness_policies_hard_expiry_check
--     CHECK (hard_expiry_seconds IS NULL OR hard_expiry_seconds >= ttl_seconds)
--
-- claim_type is unconstrained text. 900 <= 3600 satisfies the CHECK.
--
-- Values are the incoming branch's own: ttl 900 s, hard expiry 3600 s. A safety
-- constraint or clearance is the shortest-lived claim in the table for the
-- obvious reason — a road closure that lifted twenty minutes ago is worse than
-- no claim at all.
BEGIN;

INSERT INTO public.freshness_policies (claim_type, ttl_seconds, hard_expiry_seconds, note) VALUES
  ('safety.constraint', 900, 3600, 'Authoritative place safety constraint or clearance.')
ON CONFLICT (claim_type) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.freshness_policies WHERE claim_type = 'safety.constraint') THEN
    RAISE EXCEPTION '2961 POSTCONDITION FAILED: safety.constraint row absent after insert';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freshness_policies
    WHERE claim_type = 'safety.constraint' AND ttl_seconds = 900 AND hard_expiry_seconds = 3600
  ) THEN
    RAISE EXCEPTION '2961 POSTCONDITION FAILED: safety.constraint present but not with ttl=900 hard=3600 (a pre-existing row with other values was left alone by ON CONFLICT)';
  END IF;
END $$;

COMMIT;
