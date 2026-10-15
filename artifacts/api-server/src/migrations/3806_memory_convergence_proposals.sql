-- 3806 — Memories: photos from the owner's OTHER device converge on the Memory
-- they belong to, as a PROPOSAL the owner keeps or dismisses — never attached on
-- the system's own say-so.
-- census-highlights-memories H180 ("Cross-device uploads/notes converge on one
-- Memory/Episode", spec §19 "…where evidence supports it").
-- B58 cluster MEM-CONVERGE, band 3802–3819.
--
-- ── WHAT THIS TABLE HOLDS ──────────────────────────────────────────────────────
-- One row per (owner, Memory, captured photo) that the candidate detector
-- (services/memory/episodeCandidates.ts, owner-initiated per trip) found to
-- belong to a Memory the owner ALREADY has, instead of proposing a second,
-- duplicate candidate for the same moment:
--   basis 'confirmed_episode' — the capture grouped with a detected episode the
--       owner already KEPT, whose Memory is linked to it (2320's explicit link);
--   basis 'memory_window'     — the capture was taken inside the time window of
--       one of the owner's Memories on the SAME trip (the Memory's own
--       starts_at..ends_at and its photos' capture times, at most 24 hours).
-- The row is the proposal AND its decision:
--   proposed  → shown in the owner's inbox ("3 photos from your other device for
--               <Memory>");
--   kept      → the owner pressed Keep; the photo is attached through the §17
--               ADD_MEDIA command (services/memory/memoryConvergence.ts);
--   dismissed → the DURABLE NEGATIVE: the detector's insert is ON CONFLICT DO
--               NOTHING, so a dismissed photo is never proposed for that Memory
--               again, however often the owner re-runs detection.
-- A decision is final (guard trigger): kept and dismissed never change again,
-- and only `state` / `decided_at` may change at all.
--
-- WHY A TABLE, NOT 2320's memory_evidence. Two reasons, both measured:
--   (1) a 'memory_window' proposal has no episode to hang evidence on — the
--       Memory was made by hand — and creating an episode for it would be the
--       duplicate candidate this row exists to prevent;
--   (2) memory_evidence.truth_level is asserted | observed | corroborated |
--       inferred — every value is POSITIVE support. A dismissal written there
--       would read as evidence FOR the attachment it refuses (lossy), and the
--       table is append-only, so a proposal could not be decided in place.
--
-- OWNERSHIP IS STRUCTURAL. The guard trigger refuses a row whose Memory or
-- whose photo is not owner_id's: another person's Memory can never be proposed,
-- and another person's photo never offered, whatever the server code does.
--
-- DELETION: owner_id cascades from auth.users (AccountDeletionService's final
-- step), memory_id from public.memories (account deletion hard-deletes every
-- Memory), media_asset_id from public.media_assets — the 3670 / 3802 mechanism
-- (lib/deletionDispositions.ts ERASED_BY_CASCADE). A Memory deleted by its owner
-- (a soft delete) has its rows purged by §21's RAW_EVIDENCE_PURGED state
-- (services/memory/memoryDeletionLifecycle.ts).
--
-- No flag: the inbox that writes and reads this table is gated by 2320's
-- deployment (absent ⇒ feature_disabled), and this table's absence by its own
-- probe (absent ⇒ the detector behaves exactly as before this migration).
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3806): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3806): public.memories does not exist.';
  END IF;
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3806): public.media_assets does not exist.';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.memory_convergence_proposals (
  owner_id       uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  memory_id      uuid NOT NULL REFERENCES public.memories (id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES public.media_assets (id) ON DELETE CASCADE,
  basis          text NOT NULL,
  state          text NOT NULL DEFAULT 'proposed',
  proposed_at    timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz NULL,
  PRIMARY KEY (owner_id, memory_id, media_asset_id),
  CONSTRAINT memory_convergence_proposals_basis_check
    CHECK (basis IN ('confirmed_episode', 'memory_window')),
  CONSTRAINT memory_convergence_proposals_state_check
    CHECK (state IN ('proposed', 'kept', 'dismissed')),
  CONSTRAINT memory_convergence_proposals_decision_stamped
    CHECK ((state = 'proposed') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS memory_convergence_proposals_owner_state_idx
  ON public.memory_convergence_proposals (owner_id, state);
CREATE INDEX IF NOT EXISTS memory_convergence_proposals_memory_idx
  ON public.memory_convergence_proposals (memory_id);
CREATE INDEX IF NOT EXISTS memory_convergence_proposals_asset_idx
  ON public.memory_convergence_proposals (media_asset_id);

COMMENT ON TABLE public.memory_convergence_proposals IS
  'census-highlights-memories H180 (migration 3806): a captured photo the detector found to belong to a Memory the owner already has, as a proposal the owner keeps (attached through §17 ADD_MEDIA) or dismisses (never proposed for that Memory again). Never attached automatically. Owner-only by construction (guard trigger); service role only; erased with the account, the Memory or the photo.';

CREATE OR REPLACE FUNCTION public.memory_convergence_proposals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
       OR NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id
       OR NEW.basis IS DISTINCT FROM OLD.basis
       OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
      RAISE EXCEPTION 'memory_convergence_proposals: only the decision of a proposal may change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state <> 'proposed' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
      RAISE EXCEPTION 'memory_convergence_proposals: a % proposal is decided — a decision is final', OLD.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memories m WHERE m.id = NEW.memory_id AND m.owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'memory_convergence_proposals: the Memory is not this owner''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.media_assets a WHERE a.id = NEW.media_asset_id AND a.owner_user_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'memory_convergence_proposals: the photo is not this owner''s'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS memory_convergence_proposals_guard ON public.memory_convergence_proposals;
CREATE TRIGGER memory_convergence_proposals_guard
  BEFORE INSERT OR UPDATE ON public.memory_convergence_proposals
  FOR EACH ROW EXECUTE FUNCTION public.memory_convergence_proposals_guard();

ALTER TABLE public.memory_convergence_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_convergence_proposals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_convergence_proposals TO service_role;
REVOKE ALL ON FUNCTION public.memory_convergence_proposals_guard() FROM PUBLIC, anon, authenticated;

COMMIT;

DO $post$
DECLARE
  r text;
  p text;
BEGIN
  IF to_regclass('public.memory_convergence_proposals') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): memory_convergence_proposals was not created.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_convergence_proposals'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): row level security is off on memory_convergence_proposals.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_convergence_proposals'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): memory_convergence_proposals carries a policy — it must have none (service role only).';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.memory_convergence_proposals', p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3806): % holds % on memory_convergence_proposals — service role only.', r, p;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.memory_convergence_proposals', p) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3806): service_role lacks % on memory_convergence_proposals.', p;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_convergence_proposals'::regclass
                   AND contype = 'f' AND confrelid = 'auth.users'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): memory_convergence_proposals does not cascade from auth.users — account deletion would leave it behind.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_convergence_proposals'::regclass
                   AND contype = 'f' AND confrelid = 'public.memories'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): memory_convergence_proposals does not cascade from public.memories.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_convergence_proposals'::regclass
                   AND contype = 'f' AND confrelid = 'public.media_assets'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): memory_convergence_proposals does not cascade from public.media_assets.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_convergence_proposals'::regclass
                   AND conname = 'memory_convergence_proposals_state_check'
                   AND pg_get_constraintdef(oid) LIKE '%proposed%' AND pg_get_constraintdef(oid) LIKE '%kept%'
                   AND pg_get_constraintdef(oid) LIKE '%dismissed%'
                   AND (SELECT count(*) FROM regexp_matches(pg_get_constraintdef(oid), '''[a-z_]+''', 'g')) = 3) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): the state CHECK is not exactly (proposed | kept | dismissed).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_convergence_proposals'::regclass
                   AND conname = 'memory_convergence_proposals_basis_check'
                   AND pg_get_constraintdef(oid) LIKE '%confirmed_episode%' AND pg_get_constraintdef(oid) LIKE '%memory_window%'
                   AND (SELECT count(*) FROM regexp_matches(pg_get_constraintdef(oid), '''[a-z_]+''', 'g')) = 2) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): the basis CHECK is not exactly (confirmed_episode | memory_window).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_convergence_proposals'::regclass
                   AND conname = 'memory_convergence_proposals_decision_stamped') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): the decision-stamped CHECK is missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memory_convergence_proposals'::regclass
                   AND tgname = 'memory_convergence_proposals_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806): the ownership / finality guard trigger is missing.';
  END IF;
END $post$;
