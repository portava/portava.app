-- 2255_media_evidence_seam.sql
-- Media v2 Phase 5 (Intelligence) — the media→intel EVIDENCE seam (§9 EVIDENCE
-- EXTRACTION, §35 evidence-safe editing).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Media band 2255+.
--
-- Additive + idempotent. Safe to re-run. Adds three things, all dark until an
-- admin flips the flag:
--
--   1. feature flag `media_evidence_enabled` (CAPABILITY, seeded FALSE) — the
--      MASTER gate for the whole seam. Its reader is lib/intelProjectionAggregator
--      (hasEvidence) and lib/media/mediaEvidenceLink (the write adapter), both
--      added in the same change, so check-flag-polarity is satisfied (a flag row
--      arrives with the unit that reads it). Convention `*_enabled` (lowercase)
--      ⇒ CAPABILITY: `true` means the media→evidence linkage is live; a read
--      that fails is fail-closed to false (isFlagEnabled), so an unhealthy DB
--      leaves the seam OFF — never silently on.
--
--   2. intel_evidence.media_asset_id — a TYPED, nullable FK to media_assets(id)
--      (2130 shipped only a free-form `reference` string). ON DELETE SET NULL:
--      the append-only evidence row survives if the media artifact is erased,
--      but stops counting as media evidence (the reader filters
--      media_asset_id IS NOT NULL). Erasure of the CONTRIBUTOR still cascades via
--      the existing observation_id/actor_id FKs; this column only governs the
--      independent deletion of the artifact.
--
--   3. evidence_kind CHECK widened to a SUPERSET that also admits 'video'
--      (2130 had only 'photo' among the visual kinds). Non-destructive: every
--      pre-existing value still satisfies the widened CHECK. Mirrors the pattern
--      0191 used to widen moderation_reports.subject_type.
--
-- RUNTIME EFFECT: NONE. Flag seeded false ⇒ the aggregator's hasEvidence stays
-- EXACTLY false (byte-identical confidence output to pre-seam main) and the
-- write adapter is a no-op. No confidence band moves until the owner presses the
-- flag. This migration writes no data, only schema + one disabled flag row.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.intel_evidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_evidence does not exist (needs 2130).';
  END IF;
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.media_assets does not exist (needs 0191).';
  END IF;
END $$;

-- ── 1. Master gate flag (CAPABILITY, OFF) ────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_evidence_enabled',
    false,
    'MASTER gate for the media->intel evidence seam (Media v2 Phase 5). OFF (the seed): the write adapter (lib/media/mediaEvidenceLink) links no media to intel_evidence, and intelProjectionAggregator.hasEvidence stays EXACTLY false so photo/video-backed claims score identically to today. ON: an evidence-eligible (SS35) media asset attached to an observation records an intel_evidence link, and hasEvidence derives from >=1 linked, still-eligible media. Reads are fail-closed (isFlagEnabled) so an unreadable flag leaves the seam OFF. Only SS35-evidence-eligible media ever link; a generative/ineligible asset stays a valid social asset but is never evidence.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── 2. Typed FK from intel_evidence to the canonical media asset ─────────────
ALTER TABLE public.intel_evidence
  ADD COLUMN IF NOT EXISTS media_asset_id UUID
    REFERENCES public.media_assets(id) ON DELETE SET NULL;

-- One evidence link per (observation, media asset). Partial (media_asset_id IS
-- NOT NULL) so the free-form, media-less evidence rows 2130 already supports are
-- unaffected. Makes the write adapter's re-attach idempotent at the DB level
-- (a duplicate insert raises 23505, which the adapter treats as already-linked).
CREATE UNIQUE INDEX IF NOT EXISTS intel_evidence_observation_media_uk
  ON public.intel_evidence (observation_id, media_asset_id)
  WHERE media_asset_id IS NOT NULL;

-- Reverse lookup: which evidence rows point at a given media asset (erasure /
-- read paths). Partial for the same reason.
CREATE INDEX IF NOT EXISTS intel_evidence_media_asset
  ON public.intel_evidence (media_asset_id)
  WHERE media_asset_id IS NOT NULL;

-- ── 3. Widen evidence_kind to admit 'video' (SUPERSET, non-destructive) ──────
-- Drop the auto-shipped named CHECK and re-add the superset. IF EXISTS keeps the
-- drop idempotent; after the drop the ADD always succeeds (no name collision),
-- so the whole block is re-runnable.
ALTER TABLE public.intel_evidence
  DROP CONSTRAINT IF EXISTS intel_evidence_kind_check;
ALTER TABLE public.intel_evidence
  ADD CONSTRAINT intel_evidence_kind_check
    CHECK (evidence_kind IN ('photo','video','receipt','official_feed','partner_api','sensor','text_note'));

-- ── Postconditions (conditional RAISE only — no self-aborting proof) ─────────
DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'media_evidence_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_evidence_enabled not present after seed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'intel_evidence' AND column_name = 'media_asset_id'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence.media_asset_id not created';
  END IF;

  -- The seed MUST be OFF. A true row here would mean the live seam shipped on.
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_evidence_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_evidence_enabled seeded ON — the seam must ship OFF';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   ALTER TABLE public.intel_evidence DROP CONSTRAINT IF EXISTS intel_evidence_kind_check;
--   ALTER TABLE public.intel_evidence ADD CONSTRAINT intel_evidence_kind_check
--     CHECK (evidence_kind IN ('photo','receipt','official_feed','partner_api','sensor','text_note'));
--   DROP INDEX IF EXISTS public.intel_evidence_media_asset;
--   DROP INDEX IF EXISTS public.intel_evidence_observation_media_uk;
--   ALTER TABLE public.intel_evidence DROP COLUMN IF EXISTS media_asset_id;
--   DELETE FROM public.feature_flags WHERE flag = 'media_evidence_enabled';
-- The reversal only removes dark schema + a disabled flag; no served data changes.
