-- 3800_passport_place_stamps.sql
-- Passport — the Place stamp (census-passport P61), under lead ruling D-84
-- (docs/ops/lead-rulings-20261007-media.md, adopted by the lead 2026-10-07 under
-- the owner's 2026-10-06 delegation): "a verified check-in (QR or geofence) at a
-- canonical place earns a Place stamp; one per person per place; none inside a
-- protected zone; place_id kept from everyone but the owner."
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane M band 3800-3819). APPLIED TO
-- NO DATABASE by the lane that wrote it. Sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- 2880_passport_stamps_place_vocabulary.sql made `'place'` storable and said
-- what was still missing before anything may write it ("DO NOT APPLY BEFORE"):
--   * a product rule for what earns a Place stamp — D-84 is that rule;
--   * how a Place stamp is DEDUPLICATED: the live unique index
--       passport_stamps_dedup_idx is (user_id, stamp_type, country, city) and
--       does NOT include place_id, so two different venues in one city would
--       collide on it (the second insert fails 23505 and createStamp returns
--       null — a silently lost stamp).
-- This file supplies the second half:
--   * passport_stamps_dedup_idx is rebuilt PARTIAL (stamp_type <> 'place'):
--     every other stamp type deduplicates exactly as before;
--   * passport_stamps_place_dedup_idx: one Place stamp per (user_id, place_id);
--   * passport_stamps_place_has_place_id: a Place stamp must name its place;
--   * `passport_place_stamps_enabled`, seeded FALSE: the one writer
--     (services/passport/PlaceStampService.awardPlaceStampForCheckin) refuses
--     to write while it is off, absent or unreadable.
--
-- No row moves. No ON CONFLICT clause anywhere in the tree or the migration
-- chain names passport_stamps_dedup_idx's columns (checked 2026-10-07), so the
-- predicate cannot strand an upsert arbiter.
--
-- ORDER. Requires 2880 (and through it 2309). The precondition refuses to run
-- without the 'place' label rather than delivering it, for 2880's own reason.
--
-- Rollback: db/rollback/2026-10-07-3800-passport-place-stamps-rollback.sql

BEGIN;

DO $pre$
DECLARE
  def text;
BEGIN
  IF to_regclass('public.passport_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): public.passport_stamps does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): public.feature_flags does not exist.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'passport_stamps' AND column_name = 'place_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): passport_stamps.place_id is missing.';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'passport_stamps'
     AND c.conname = 'passport_stamps_stamp_type_check';
  IF def IS NULL OR position('''place''' IN def) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): passport_stamps_stamp_type_check does not admit ''place''. Apply 2880 first; 3800 does not deliver the label.';
  END IF;

  IF to_regclass('public.passport_stamps_dedup_idx') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): passport_stamps_dedup_idx is missing; this file rebuilds it and will not invent it.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.passport_stamps WHERE stamp_type = 'place' AND place_id IS NULL) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): a Place stamp without a place_id exists; nothing should have written one before this file.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.passport_stamps WHERE stamp_type = 'place'
              GROUP BY user_id, place_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3800): duplicate Place stamps exist for one (user_id, place_id); reconcile them by hand first.';
  END IF;
END $pre$;

-- Every other stamp type keeps today's (user_id, stamp_type, country, city) rule.
DROP INDEX public.passport_stamps_dedup_idx;
CREATE UNIQUE INDEX passport_stamps_dedup_idx
  ON public.passport_stamps USING btree (user_id, stamp_type, country, city)
  WHERE (stamp_type <> 'place'::text);

-- One Place stamp per person per place.
CREATE UNIQUE INDEX IF NOT EXISTS passport_stamps_place_dedup_idx
  ON public.passport_stamps USING btree (user_id, place_id)
  WHERE (stamp_type = 'place'::text);

ALTER TABLE public.passport_stamps DROP CONSTRAINT IF EXISTS passport_stamps_place_has_place_id;
ALTER TABLE public.passport_stamps
  ADD CONSTRAINT passport_stamps_place_has_place_id
  CHECK (stamp_type <> 'place'::text OR place_id IS NOT NULL);

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'passport_place_stamps_enabled',
    false,
    'Passport (census-passport P61, lead ruling D-84): a GPS-verified, non-suspicious check-in at a canonical place (today: a hidden gem visit with a canonical_place_id) earns a Place stamp — one per person per place, none inside an active protected zone, place_id kept from everyone but the owner (PassportPrivacyGuard.guardStamp). Read by services/passport/PlaceStampService.awardPlaceStampForCheckin via isFlagEnabled (fail-closed). OFF / absent / unreadable (the seed): no Place stamp is written. Turn ON only after 2880 and 3800 are applied.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate statement: they assert what persisted) ──────────
DO $post$
DECLARE
  idx_def text;
  n int;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO idx_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'passport_stamps_dedup_idx';
  IF idx_def IS NULL OR position('stamp_type <> ''place''' IN idx_def) = 0 OR position('UNIQUE' IN idx_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3800): passport_stamps_dedup_idx is not the partial unique index (found %).', idx_def;
  END IF;

  SELECT pg_get_indexdef(i.indexrelid) INTO idx_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'passport_stamps_place_dedup_idx';
  IF idx_def IS NULL OR position('(user_id, place_id)' IN idx_def) = 0 OR position('stamp_type = ''place''' IN idx_def) = 0 OR position('UNIQUE' IN idx_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3800): passport_stamps_place_dedup_idx is not (user_id, place_id) WHERE stamp_type = place (found %).', idx_def;
  END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'passport_stamps_place_has_place_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3800): passport_stamps_place_has_place_id is missing.';
  END IF;

  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'passport_place_stamps_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3800): expected passport_place_stamps_enabled present, found %.', n;
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'passport_place_stamps_enabled' AND enabled = TRUE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3800): passport_place_stamps_enabled is ON; this migration must ship it OFF.';
  END IF;
END $post$;
