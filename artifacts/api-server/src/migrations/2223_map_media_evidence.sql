-- 2223_map_media_evidence.sql
--
-- Lets §22's eighth map prompt ("Current photo/video") land in the table §21
-- already names for it: intel_evidence, "artifacts supporting an observation".
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- THIS MIGRATION MINTS NO CLAIM TYPE
-- ==================================
-- The ruling is unchanged: a photo is EVIDENCE, not a claim. It asserts no
-- proposition to confirm, contradict or expire, so it gets no claim type, no
-- TTL and no freshness policy — and this file adds none. It changes exactly two
-- things about a table that has existed since 2130 and has never had a producer.
--
-- 1. 'video' JOINS THE EVIDENCE TAXONOMY
-- --------------------------------------
-- 2130's CHECK admitted ('photo','receipt','official_feed','partner_api',
-- 'sensor','text_note'). §22's prompt is "Current photo/VIDEO", the client's
-- MEDIA_KINDS is ['photo','video'], and lib/mediaPipeline has accepted
-- video/mp4, video/quicktime and video/webm uploads all along. Without this,
-- the only way to store a video would have been to file it as a 'photo' — a
-- mis-file, and mis-filing is the precise failure this unit refuses everywhere
-- else (crowd_direction was given its own claim type rather than being folded
-- into crowd.trajectory for the same reason).
--
-- Widening a CHECK is backward-compatible: every row that satisfied the old
-- constraint satisfies the new one, so this cannot fail on existing data.
--
-- 2. A UNIQUE (observation_id, reference) SO A DOUBLE-TAP IS DETECTABLE
-- --------------------------------------------------------------------
-- intel_evidence is APPEND-ONLY (2130's triggers refuse UPDATE and DELETE
-- outside a declared erasure). A duplicate row therefore cannot be tidied up
-- afterwards — it is permanent. One tap on a phone is regularly two events, and
-- the observation path already defends against that with a unique
-- (actor_id, idempotency_key); evidence had no equivalent, so its producer
-- could only have deduplicated by a read-then-write race.
--
-- The index is on (observation_id, reference) rather than on the actor: the
-- parent observation belongs to exactly one actor, so this is already
-- per-actor, and it says the useful thing — the SAME artifact may support a
-- given observation only once. Partial on `reference IS NOT NULL` because the
-- column is nullable by design (a 'text_note' or a 'sensor' reading need not
-- reference a stored object) and NULLs must not be forced to collide.
--
-- WHAT IS DELIBERATELY NOT ADDED
-- ==============================
--   * No moderation_state column. Adding one would imply a moderation pipeline
--     and a consumer, and there is neither. The safety argument is structural
--     instead: 2130 grants `authenticated` nothing on this table, RLS is on
--     with no policy for it, no read path selects from it, and
--     lib/intelProjectionAggregator hardcodes hasEvidence = false — so stored
--     evidence reaches no viewer and raises no confidence. A READ path may not
--     be added without ruling on moderation first.
--   * No new grant. service_role already holds INSERT, SELECT (2130), which is
--     exactly what a write-only evidence store needs. No UPDATE, matching the
--     append-only triggers.
--   * No retention machinery. 2173 already sweeps intel_evidence by created_at
--     at the ruled 180 days, and 2130's erase_intel_for_actor already deletes
--     an actor's evidence on account deletion — both were written when the
--     table was empty, and both now have something to sweep.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_evidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2130 first (intel_evidence missing).';
  END IF;
END $$;

-- ── 1. The evidence taxonomy admits video ────────────────────────────────────

ALTER TABLE public.intel_evidence
  DROP CONSTRAINT IF EXISTS intel_evidence_kind_check;
ALTER TABLE public.intel_evidence
  ADD CONSTRAINT intel_evidence_kind_check
  CHECK (evidence_kind IN (
    -- 2130's six
    'photo','receipt','official_feed','partner_api','sensor','text_note',
    -- §22's other half of "Current photo/video"
    'video'
  ));

COMMENT ON COLUMN public.intel_evidence.evidence_kind IS
  'Artifact TYPE, never a claim value. ''photo'' and ''video'' are the two §22 map-contribution asset types; the rest are non-map evidence sources. An evidence kind says what the artifact IS — it asserts nothing about the world, which is why evidence has no TTL of its own and no freshness policy.';

-- ── 2. One artifact supports a given observation at most once ────────────────

CREATE UNIQUE INDEX IF NOT EXISTS intel_evidence_observation_reference
  ON public.intel_evidence (observation_id, reference)
  WHERE reference IS NOT NULL;

COMMENT ON COLUMN public.intel_evidence.reference IS
  'A storage key (`<bucket>/<path>`) or external reference — never a client-supplied URL. The map path stores only a key it has proved belongs to the contributor, in one of the app''s own private media buckets. Never raw coordinates: EXIF is stripped at upload and this table must not become a second location store.';

-- ── Postconditions ───────────────────────────────────────────────────────────
--
-- Catalog reads only. A verification block that INSERTED a video row to prove
-- the constraint would be a test wearing a migration's clothes, and would have
-- to observe from a separate transaction to mean anything; the behavioural
-- assertions live in src/test/mapMediaEvidence.test.ts.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'intel_evidence'
      AND c.conname = 'intel_evidence_kind_check'
      AND position('''video''' IN pg_get_constraintdef(c.oid)) > 0
      AND position('''photo''' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_kind_check missing, or does not admit both photo and video';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'intel_evidence'
      AND indexname = 'intel_evidence_observation_reference'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_observation_reference index missing';
  END IF;

  -- The append-only guarantee this migration relies on must still be in force:
  -- the dedup index is the ONLY defence against a permanent duplicate precisely
  -- because a duplicate cannot be deleted afterwards.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class t ON t.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'intel_evidence'
      AND tg.tgname = 'intel_evidence_no_update_delete'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence is no longer append-only (2130/2137 trigger missing)';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
--   DROP INDEX IF EXISTS public.intel_evidence_observation_reference;
--   ALTER TABLE public.intel_evidence DROP CONSTRAINT IF EXISTS intel_evidence_kind_check;
--   ALTER TABLE public.intel_evidence ADD CONSTRAINT intel_evidence_kind_check
--     CHECK (evidence_kind IN ('photo','receipt','official_feed','partner_api','sensor','text_note'));
--
-- NARROWING THE CHECK BACK WILL FAIL if any video evidence has been stored, and
-- that failure is correct: the rows cannot be deleted (append-only) and cannot
-- be re-filed as photos (that is the mis-file this migration exists to avoid).
-- Reverse before the map contributions flag is enabled, not after.
