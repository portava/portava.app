-- 3802 — Memory narratives: the SEPARATE opt-in for the optional AI summary, and
-- the flag that keeps it dark until the owner turns it on.
-- census-highlights-memories H172 (NarrativeDerivative — optional AI summary),
-- H14 (MemoryNarrativeService), H265 (original voice and language preserved).
-- B58 cluster MEM-NARR-1, band 3802–3819.
--
-- ── WHAT THIS GOVERNS ──────────────────────────────────────────────────────────
-- POST /memories/:id/narrative/ai (routes/memoryNarrative.ts) sends a few of the
-- OWNER's own facts about ONE of their Memories to the AI model the repository
-- already uses (lib/openai.ts: the Replit AI-integrations proxy, gpt-5-mini) and
-- returns a draft summary that is checked against those facts before it is shown.
-- Nothing is generated or sent unless ALL of these hold, each checked by the
-- server on every request:
--   1. memory_narrative_ai_enabled (seeded FALSE here) is ON;
--   2. the person has a VALID row in memory_narrative_ai_consent (this table);
--   3. the Memory is theirs, and carries none of DO_NOT_RESURFACE,
--      KEEP_PRIVATE_FOREVER, RETAIN_BUT_DO_NOT_PERSONALIZE (3671; the
--      model-mediated reading of proposed ruling W-HM-PRIV-1).
-- The deterministic summary (GET /memories/:id/narrative) needs none of this:
-- it is built on the server from the same facts, sends nothing anywhere, and is
-- always available.
--
-- ── memory_narrative_ai_consent ────────────────────────────────────────────────
-- The shape of 3780's input_outcome_consent and 3782's
-- input_memory_context_consent, deliberately a DIFFERENT TABLE: one switch per
-- purpose, so a grant for Input Intelligence can never be read as a grant to send
-- a Memory to a model, and the reverse. Written ONLY by service_role; the SERVER
-- stamps the disclosure version and the timestamps
-- (services/memory/memoryNarrativeService.ts). An absent row is OFF. Revoking is
-- a withdrawal (enabled = false, withdrawn_at stamped). This table stores no
-- Memory content and no generated text: generated text is never stored by this
-- cluster (fail-closed default for open owner question Q-NARR-4).
--
-- ── memory_narrative_ai_enabled ────────────────────────────────────────────────
-- Seeded FALSE. While off, the opt-in cannot be granted and no Memory is sent to
-- any model for anyone; withdrawing is always allowed. Turning it on is the
-- owner's decision (open questions Q-NARR-1 processor, Q-NARR-2 what is sent,
-- Q-NARR-3 controls, Q-NARR-6 disclosure wording), and the disclosure text
-- (MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT) is an ENGINEERING DRAFT that needs legal
-- review before the flag is turned on.
--
-- DELETION: cascades from auth.users, so account deletion erases it
-- (lib/deletionDispositions.ts ERASED_BY_CASCADE, the 3780/3782 mechanism).
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3802): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3802): public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.memory_narrative_ai_consent (
  user_id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  consent_version text,
  consented_at    timestamptz,
  withdrawn_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_narrative_ai_consent_grant_is_stamped
    CHECK (NOT enabled OR (consent_version IS NOT NULL AND consented_at IS NOT NULL))
);

COMMENT ON TABLE public.memory_narrative_ai_consent IS
  'census-highlights-memories H172: the separate, off-by-default opt-in that lets the server send the owner''s own facts about one of their Memories to the AI model for a draft summary. Separate from every Input Intelligence consent (3780/3782) and D4. Service_role only; server-stamped. Absent row = off; withdrawal = revoke. Stores no Memory content and no generated text.';

ALTER TABLE public.memory_narrative_ai_consent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_narrative_ai_consent FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_narrative_ai_consent TO service_role;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'memory_narrative_ai_enabled',
    false,
    'Optional AI summary of a Memory (census-highlights-memories H172, B58 MEM-NARR-1): offers the separate opt-in (memory_narrative_ai_consent, 3802) and, for an owner who opted in, sends the owner''s own facts about one Memory to the existing AI model and returns a draft checked against those facts (the deterministic summary otherwise). OFF / absent (the seed): the opt-in cannot be granted and nothing is sent for anyone. Turning it ON is an owner decision after approving the processor, what is sent and the disclosure text (legal review).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_narrative_ai_consent') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802): memory_narrative_ai_consent was not created.';
  END IF;
  IF has_table_privilege('anon', 'public.memory_narrative_ai_consent', 'SELECT')
     OR has_table_privilege('anon', 'public.memory_narrative_ai_consent', 'INSERT')
     OR has_table_privilege('anon', 'public.memory_narrative_ai_consent', 'UPDATE')
     OR has_table_privilege('anon', 'public.memory_narrative_ai_consent', 'DELETE')
     OR has_table_privilege('authenticated', 'public.memory_narrative_ai_consent', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_narrative_ai_consent', 'INSERT')
     OR has_table_privilege('authenticated', 'public.memory_narrative_ai_consent', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.memory_narrative_ai_consent', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802): memory_narrative_ai_consent is reachable by anon/authenticated — service_role only.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_narrative_ai_consent'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802): row level security is off on memory_narrative_ai_consent.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.memory_narrative_ai_consent'::regclass
       AND contype = 'f'
       AND confrelid = 'auth.users'::regclass
       AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802): memory_narrative_ai_consent does not cascade from auth.users — account deletion would leave it behind.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802): memory_narrative_ai_enabled absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802): memory_narrative_ai_enabled is ON — it must ship OFF.';
  END IF;
END $post$;
