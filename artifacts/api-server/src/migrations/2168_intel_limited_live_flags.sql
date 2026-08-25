-- 2168_intel_limited_live_flags.sql
-- IG-09 Limited-Live gating — the pilot capability + the global emergency stop.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Spec §26 (cold-start / density gate + "global emergency switch"). Two flags,
-- both read by lib/liveClaimRead.ts (added in the same change):
--
--   intel_limited_live       CAPABILITY. Off ⇒ no public Live labels for anyone.
--                            An operator flips it on for a scope ONLY after that
--                            scope clears the §26 density gate (lib/intelLiveScope.ts,
--                            a human-review promotion). Seeded false.
--
--   disable_intel_live_labels  STOP / kill switch (disable_* convention ⇒ the
--                            polarity guard classifies it automatically and
--                            requires it be read via isKillSwitchEngaged, so a DB
--                            error ENGAGES the stop). `true` suppresses ALL Live
--                            labels WITHOUT deleting source records. Seeded false
--                            (not engaged); a missing row also reads as not
--                            engaged.
--
-- NO table or grant change. The density-gate metrics are evaluated by
-- human-review promotion, not stored here (spec §24). RUNTIME EFFECT: NONE — the
-- live read path is itself gated by intel_live_label_crowd (off), so with these
-- seeded false nothing changes for any surface.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_limited_live',
    false,
    'IG-09 pilot capability. Off ⇒ no public Live labels. Flipped on per scope only after the §26 density gate passes (human-review promotion, lib/intelLiveScope.ts). Read by lib/liveClaimRead.ts.'
  ),
  (
    'disable_intel_live_labels',
    false,
    'IG-09 global emergency stop (kill switch). true ⇒ suppress ALL Live labels without deleting source records. Read via isKillSwitchEngaged in lib/liveClaimRead.ts (a DB error engages the stop).'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('intel_limited_live', 'disable_intel_live_labels');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 2 IG-09 flags present, found %', present;
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false
--            WHERE flag IN ('intel_limited_live', 'disable_intel_live_labels');
-- (Engaging the stop is enabled = true on disable_intel_live_labels.)
