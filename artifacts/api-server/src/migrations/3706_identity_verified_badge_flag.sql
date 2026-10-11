-- 3706 — the public identity-verified badge (census-trust TV-0e / TV-2c), seeded OFF.
--
-- ── THE OWNER'S DECISION THIS IMPLEMENTS (docs/ops/owner-decisions-20261004.md) ──
-- OD-TRUST-3 "Verified badge: Yes, for a defined, current verification state
--            only. Make criteria visible; don't sell the badge or present it as
--            an endorsement."
--
-- ── identity_verified_badge_enabled ────────────────────────────────────────────
-- When ON, the passport header, Rent-a-Buddy search listings, trip / place /
-- profile reviews and the host's event attendee list carry `identityBadge`
-- ({ tier: 'id' | 'id_selfie' } or null) for each person shown, computed by
-- services/identityVerification/verifiedBadges.ts with the SAME definition the
-- booking gate uses: the most recent finished identity check approved, on a mode
-- that counts (never a sandbox/test key), not withdrawn. The app draws teal (ID)
-- or gold (ID + selfie) and a tap shows the criteria and the not-an-endorsement
-- statement. Any read error → no badge.
-- OFF / absent (the seed): no badge is computed and no identity row is read.
-- Until 2870 is applied no identity level exists, so every badge is correctly
-- absent even with the flag on (census-trust TV-1c).
--
-- Additive only: one row in feature_flags. Rollback:
-- db/rollback/2026-10-10-3706-identity-verified-badge-flag-rollback.sql.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3706): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'identity_verified_badge_enabled',
    false,
    'Public identity-verified badge (OD-TRUST-3; census-trust TV-0e/TV-2c): viewers see a teal (ID) or gold (ID + selfie) badge beside a person whose most recent finished identity check is approved, not a test check and not withdrawn; tapping it shows the criteria and that it is not an endorsement. OFF / absent (the seed): no badge is computed and no identity row is read.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'identity_verified_badge_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3706): identity_verified_badge_enabled absent.';
  END IF;
END $post$;
