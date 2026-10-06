-- 3782 — Compass memory for input assistance: the SEPARATE opt-in, and the flag
-- that keeps it dark until the owner turns it on. Census G25 (`allowMemoryContext`).
--
-- ── THE OWNER'S DECISION THIS IMPLEMENTS (docs/ops/owner-decisions-20261004.md) ──
-- OD-INPUT-3 "Compass memory: Don't use it for input assistance by default. Add
--            it only through a separate, clear opt-in with a way to inspect and
--            revoke it."
--
-- ── input_memory_context_consent ───────────────────────────────────────────────
-- The same shape as 3780's input_outcome_consent and D4's intel_contribution_consent
-- (2172), deliberately a DIFFERENT TABLE: one switch per purpose, so a grant for
-- outcome learning can never be read as a grant to use memories, and neither can
-- be read as D4. Written ONLY by service_role; the SERVER stamps the disclosure
-- version and the timestamps (lib/inputAssistance/inputConsent.ts). An absent row
-- is OFF. Revoking is a withdrawal; nothing else is stored by this lane, so there
-- is nothing further to delete. The memories themselves are untouched — this
-- table governs only whether Input Intelligence may READ the person's own
-- CompassMemoryProjection to suggest Compass prompts.
--
-- ── input_memory_context_enabled ───────────────────────────────────────────────
-- Seeded FALSE. While off, the opt-in cannot be granted and no memory is read for
-- any person; withdrawing is always allowed. Turning it on is the owner's
-- decision, after approving the disclosure text
-- (lib/inputAssistance/memoryContext.ts INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION).
--
-- Cascades from auth.users, so account deletion erases it.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3782): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3782): public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.input_memory_context_consent (
  user_id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  consent_version text,
  consented_at    timestamptz,
  withdrawn_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT input_memory_context_consent_grant_is_stamped
    CHECK (NOT enabled OR (consent_version IS NOT NULL AND consented_at IS NOT NULL))
);

COMMENT ON TABLE public.input_memory_context_consent IS
  'OD-INPUT-3: the separate, off-by-default opt-in that lets Input Intelligence read the person''s own CompassMemoryProjection to suggest Compass prompts. Separate from outcome learning (3780) and D4. Service_role only; server-stamped. Absent row = off; withdrawal = revoke.';

ALTER TABLE public.input_memory_context_consent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.input_memory_context_consent FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.input_memory_context_consent TO service_role;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'input_memory_context_enabled',
    false,
    'Compass memory for input assistance (OD-INPUT-3, census G25): offers the separate opt-in and, for a person who opted in, adds up to two Compass starter prompts drawn from their own CompassMemoryProjection, with an inspect view in Settings. OFF / absent (the seed): the opt-in cannot be granted and no memory is read for anyone. Turning it ON is an owner decision after approving the disclosure text.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.input_memory_context_consent') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782): input_memory_context_consent was not created.';
  END IF;
  IF has_table_privilege('anon', 'public.input_memory_context_consent', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_memory_context_consent', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_memory_context_consent', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782): input_memory_context_consent is reachable by anon/authenticated — service_role only.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.input_memory_context_consent'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782): row level security is off on input_memory_context_consent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_memory_context_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782): input_memory_context_enabled absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_memory_context_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3782): input_memory_context_enabled is ON — it must ship OFF.';
  END IF;
END $post$;
