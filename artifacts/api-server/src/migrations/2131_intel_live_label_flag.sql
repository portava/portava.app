-- 2131_intel_live_label_flag.sql
-- Seeds `intel_live_label_crowd`, DISABLED.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS FLAG IS SEEDED HERE AND THE OTHER SEVEN ARE NOT. 2128 deliberately
-- created no feature_flags rows: check-flag-polarity rejects a flag that is
-- seeded but read by nothing ("SEEDED BUT NEVER READ"), and IG-01 had no readers
-- by design. This one now has one — lib/liveClaimRead.ts, reached from
-- routes/placeLiving.ts — so its row belongs with its reader, which is the rule
-- that migration wrote down. The remaining seven follow the same way.
--
-- RUNTIME EFFECT: NONE. Seeded false. With the flag off, readLiveClaims returns
-- an empty array and the place card renders exactly the null it rendered before
-- the projection existed. Turning it on changes nothing either until
-- intel_state_snapshots holds a privacy-eligible, unexpired row.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_live_label_crowd',
    false,
    'Shows a LIVE crowd label on place surfaces from the intel projection. Off means the surface renders null (its pre-existing behaviour). Requires intel_claim_projection_crowd upstream; reads enforce privacy_eligible and expiry regardless.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_live_label_crowd';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_live_label_crowd not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_live_label_crowd';
--           (or DELETE the row). Nothing reads it while off.
