-- 3654_telegraph_idempotent_send_and_sequence_resume.sql
-- Telegraph §17.2 / §30 "Reliability" — the two capability flags for idempotent
-- resend and sequence resume (census-telegraph T231, T233, T376).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T-REL band 3654-3659.
--
-- Spec §17.2, verbatim: "Offline resend must be idempotent. … Reconnect resumes
-- from last acknowledged conversation/event sequence."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE IS, AND WHY IT IS ONLY FLAGS
-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 2810 already holds the storage both behaviours need:
--   messages.idempotency_key + the PARTIAL unique index messages_idempotency_uniq
--     on (thread_id, sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
--   messages.sequence, allocated per conversation by trigger
--     telegraph_assign_message_sequence while telegraph_message_kernel_enabled is ON;
--   messages_thread_sequence_idx on (thread_id, sequence DESC).
-- What 2810 did not have is a WRITER of the key and a READER of the sequence.
-- Those are application code (services/telegraphReliability.ts, routes/
-- messaging.ts); this file seeds the two switches that put them in force, and
-- REFUSES to run on a database without 2810, so a flag can only exist — and
-- therefore only be ON — where the columns it gates exist. That is the same
-- argument 2810's own header makes for telegraph_message_kernel_enabled.
--
--   telegraph_idempotent_send_enabled   POST /threads/:id/messages records the
--       client's key and answers a repeated key (same caller, same thread) with
--       the ORIGINAL message, 200, no second row and no second side effect.
--   telegraph_sequence_resume_enabled   GET /threads/:id/messages accepts
--       afterSequence / withSequence. Also requires
--       telegraph_message_kernel_enabled (the application reads both): with the
--       kernel off nothing is numbered and a resume would answer "nothing new".
--
-- Both seeded FALSE. No table, no column, no grant changes: nothing here can
-- widen what any role may read.
--
-- ROLLBACK: db/rollback/2026-10-10-3654-telegraph-idempotent-send-and-sequence-resume-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3654): public.feature_flags must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'idempotency_key') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3654): public.messages.idempotency_key does not exist — apply 2810 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'sequence') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3654): public.messages.sequence does not exist — apply 2810 first.';
  END IF;
  IF to_regclass('public.messages_idempotency_uniq') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3654): index messages_idempotency_uniq does not exist — apply 2810 first.';
  END IF;
END $pre$;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_idempotent_send_enabled', false,
   'CAPABILITY gate for Telegraph §17.2 idempotent resend (census-telegraph T231, migration 3654). OFF (the seed): POST /threads/:id/messages inserts exactly the columns it did before and ignores idempotencyKey. ON: the client key is stored in messages.idempotency_key (+ client_message_id) and a resend with the same key by the same sender in the same thread answers 200 with the ORIGINAL message — no second row, no second realtime event, no second mention notification; a concurrent duplicate loses the unique index and answers the same way; a key reused for a different payload is refused 409. On an E2EE thread the ciphertext is re-encrypted per attempt and is not compared (msgType/subtype must agree); an original deleted or unsent since it landed is answered as its tombstone.'),
  ('telegraph_sequence_resume_enabled', false,
   'CAPABILITY gate for Telegraph §17.2 reconnect resume by sequence (census-telegraph T233/T376, migration 3654). OFF (the seed): GET /threads/:id/messages ignores afterSequence/withSequence. ON (and only together with telegraph_message_kernel_enabled): afterSequence=N returns the caller''s visible messages with sequence > N oldest first with resume.nextSequence/hasMore; never across a block; a foreign or unknown thread is a uniform 404; per-person budget and a process-wide in-flight ceiling answer 429 with Retry-After.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_idempotent_send_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3654): telegraph_idempotent_send_enabled was not seeded.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_sequence_resume_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3654): telegraph_sequence_resume_enabled was not seeded.';
  END IF;
  IF to_regclass('public.messages_idempotency_uniq') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3654): messages_idempotency_uniq is missing; idempotent resend would have no constraint to stand on.';
  END IF;
END $post$;

COMMIT;
