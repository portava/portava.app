-- 2250_media_asset_canonical_model.sql
--
-- Media v2 — Phase 1 (Canonical Foundation). Extends the DARK canonical media
-- layer (media_assets + media_attachments, created by 0191_media_assets.sql)
-- to the full spec §6 MediaAsset / §6.1 MediaAttachment domain model.
--
-- ADDITIVE + IDEMPOTENT. Safe to re-run. The canonical READ flip stays OFF
-- (media_canonical_enabled is still FALSE, seeded by 0191 and untouched here):
-- this migration only widens the schema so the layer is READY to activate. It
-- changes nothing a user currently sees, because nothing reads media_assets on
-- the serving path yet.
--
-- WHAT THIS ADDS, AND WHY
-- -----------------------
--   1. §6 columns the shipped table lacks:
--        captured_at              (timestamptz, nullable)   — §6 capturedAt
--        location_visibility      (text, NOT NULL)          — §33 LocationVisibility
--        provenance               (jsonb, nullable)         — §6 MediaProvenance
--        intelligence_eligibility (jsonb, nullable)         — §6/§10 (LATER phase; column only)
--
--   2. source_type reconciled to the §6 8-value set
--        (camera|library|provider|official|community|generated|screenshot|derivative)
--      WITHOUT breaking the existing 'user' rows: the CHECK is a SUPERSET that
--      also admits the legacy 'user' default. No row is destructively rewritten.
--
--   3. moderation_status reconciled to a canonical superset that includes BOTH
--      the §36 MediaModerationStatus vocabulary
--        (processing|active|limited|rejected|removed|owner_deleted)
--      AND the legacy shipped values (pending|approved|flagged|rejected), so
--      existing rows stay valid and the distribution gate keeps working.
--
-- THE MODERATION MAPPING (documented, non-destructive) — legacy → §36 canonical:
--        pending   → processing     (uploaded, not yet safety-cleared)
--        approved  → active         (distributable)   ← THE PROMOTED STATE
--        flagged   → limited        (restricted distribution)
--        rejected  → rejected       (unchanged)
--        (new)     → removed        (taken down after the fact)
--        (new)     → owner_deleted  (owner soft-delete)
--   Existing rows keep their legacy value (this migration does NOT UPDATE any
--   row). The backfill (scripts/backfill-media-assets.ts) writes the canonical
--   'active' for already-served content, and the distribution gate
--   (lib/mediaEligibility.filterEligibleMediaCandidates) recognizes BOTH
--   'approved' (legacy) AND 'active' (canonical) as distributable — so a future
--   read flip cannot make either legacy or canonical rows silently invisible.
--   The column DEFAULT is deliberately left as the legacy 'pending' (= §36
--   'processing'): a newly dual-written row is non-distributable until a
--   promotion step sets it 'active', which is the safe direction.
--
--   4. §6.1 media_attachments columns (position / is_cover / visibility_override)
--      are asserted present — 0191 already created all three, so this is a
--      no-op guard that fails loudly if the shipped shape ever drifts.
--
-- LEAST PRIVILEGE: media_assets / media_attachments already run RLS with
-- service-role-mediated writes (0191). service_role bypasses RLS, so widening
-- columns needs no new grant; the postcondition re-checks the shape instead.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets missing — apply 0191_media_assets.sql first.';
  END IF;
  IF to_regclass('public.media_attachments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_attachments missing — apply 0191_media_assets.sql first.';
  END IF;
END $$;

-- ── 1. §6 columns (idempotent) ───────────────────────────────────────────────
-- capturedAt: when the media was captured (may precede uploadedAt).
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;

-- LocationVisibility (§33). Default to the MOST PRIVATE safe value ('hidden') —
-- NEVER 'precise'. Enforcement/coarsening is a dedicated later security slice;
-- this migration only LAYS the column with a non-leaking default. Backfilling
-- existing rows with 'hidden' cannot disclose a location.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS location_visibility TEXT NOT NULL DEFAULT 'hidden'
  CHECK (location_visibility IN ('hidden','country','city','neighborhood','place','precise_private'));

-- Provenance (§6 MediaProvenance): source/capture/edit lineage. Nullable jsonb.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS provenance JSONB;

-- IntelligenceEligibility (§6/§10): the media→intel seam is a LATER phase; this
-- is just the column, nullable, written by no one yet.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS intelligence_eligibility JSONB;

-- ── 2. source_type → §6 8-value set (+ legacy 'user'), non-destructive ────────
-- 0191 shipped source_type as a bare TEXT DEFAULT 'user' with NO CHECK. Add a
-- CHECK that admits the §6 enum AND the legacy 'user' value so existing rows
-- (only 'user'/'community'/'official'/'provider' have ever been written) stay
-- valid. Idempotent: only added if absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_assets'::regclass
      AND contype = 'c'
      AND conname = 'media_assets_source_type_check'
  ) THEN
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_source_type_check
      CHECK (source_type IN (
        'camera','library','provider','official',
        'community','generated','screenshot','derivative',
        'user'  -- legacy default (0191); kept, not rewritten. Maps to library/community.
      ));
  END IF;
END $$;

-- ── 3. moderation_status → canonical superset (legacy + §36) ──────────────────
-- Drop the shipped inline CHECK (auto-named; found by its definition mentioning
-- moderation_status) and replace it with the superset. Only the moderation
-- check is touched — media_assets_ready_has_dimensions (2089) mentions
-- processing_status, not moderation_status, so it is never matched here.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.media_assets'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%moderation_status%'
    AND conname <> 'media_assets_moderation_status_canonical_check';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE media_assets DROP CONSTRAINT %I', cname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_assets'::regclass
      AND conname = 'media_assets_moderation_status_canonical_check'
  ) THEN
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_moderation_status_canonical_check
      CHECK (moderation_status IN (
        -- §36 MediaModerationStatus (canonical)
        'processing','active','limited','rejected','removed','owner_deleted',
        -- legacy shipped values (0191), kept for existing rows
        'pending','approved','flagged'
      ));
  END IF;
END $$;

-- ── 4. §6.1 media_attachments columns (assert present; 0191 created them) ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='position') THEN
    ALTER TABLE media_attachments ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='is_cover') THEN
    ALTER TABLE media_attachments ADD COLUMN is_cover BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='visibility_override') THEN
    ALTER TABLE media_attachments ADD COLUMN visibility_override TEXT;
  END IF;
END $$;

-- ── Postcondition — prove the shape landed and the defaults cannot leak ───────
DO $$
DECLARE loc_default text;
BEGIN
  -- All four §6 columns exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_assets' AND column_name='captured_at') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.captured_at not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_assets' AND column_name='location_visibility') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.location_visibility not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_assets' AND column_name='provenance') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.provenance not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_assets' AND column_name='intelligence_eligibility') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.intelligence_eligibility not created';
  END IF;

  -- location_visibility default must be a NON-PRECISE, most-private safe value.
  SELECT column_default INTO loc_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='media_assets' AND column_name='location_visibility';
  IF loc_default IS NULL OR loc_default NOT LIKE '''hidden''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: location_visibility default is % — must be the most-private ''hidden'', never precise', loc_default;
  END IF;

  -- Both reconciled CHECKs exist.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_source_type_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: source_type CHECK not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_moderation_status_canonical_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moderation_status canonical CHECK not created';
  END IF;

  -- The canonical PROMOTED state ('active') and the legacy served state
  -- ('approved') must BOTH satisfy the widened moderation CHECK — the whole
  -- point of the reconciliation. A CHECK is satisfiable-tested by a trial cast
  -- against its predicate expression is not portable, so assert by definition text.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='public.media_assets'::regclass
        AND conname='media_assets_moderation_status_canonical_check') NOT LIKE '%''active''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moderation CHECK does not admit the promoted state ''active''';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='public.media_assets'::regclass
        AND conname='media_assets_moderation_status_canonical_check') NOT LIKE '%''approved''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moderation CHECK dropped the legacy served state ''approved''';
  END IF;

  -- §6.1 attachment columns present.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='visibility_override') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_attachments.visibility_override missing';
  END IF;

  -- The read flip must still be OFF — this phase is additive only.
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='media_canonical_enabled' AND enabled=TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_canonical_enabled is ON — Phase 1 must not flip the read path';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual; additive columns are safe to leave):
--   ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_source_type_check;
--   ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_moderation_status_canonical_check;
--   ALTER TABLE media_assets ADD CONSTRAINT media_assets_moderation_status_check
--     CHECK (moderation_status IN ('pending','approved','flagged','rejected'));
--   ALTER TABLE media_assets DROP COLUMN IF EXISTS intelligence_eligibility;
--   ALTER TABLE media_assets DROP COLUMN IF EXISTS provenance;
--   ALTER TABLE media_assets DROP COLUMN IF EXISTS location_visibility;
--   ALTER TABLE media_assets DROP COLUMN IF EXISTS captured_at;
