-- 2813_telegraph_request_origin.sql
-- Telegraph §22 — contextual origin on a message request.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Telegraph lane
-- 2810-2819.
--
-- Required identically by both specification versions:
--   §22  "Requests carry contextual origin: Event, Trip, Nearby, Bump, Buddy,
--        profile."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- T278 (NOT BUILT): "message_requests has no origin column at all — only
--   preview_text. A recipient cannot be told why a stranger is reaching out."
--   Re-read against this tree before this file was written and still true: the
--   insert at routes/messaging.ts writes sender, recipient and preview_text and
--   nothing else.
--
-- The harm is specific and it is a safety harm, not a convenience one. "Someone
-- you have never met wants to message you" and "the person sitting in your
-- hostel's trip crew wants to message you" call for different answers, and the
-- recipient currently gets the first sentence for both.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THREE COLUMNS, AND THE THIRD IS THE IMPORTANT ONE
-- ══════════════════════════════════════════════════════════════════════════════
-- origin_type     — §22's six, as a CHECK. Not free text: an origin a recipient
--                   reads as a reason must come from a closed set, or the field
--                   becomes a second preview_text a stranger can write anything
--                   into.
-- origin_id       — the trip / event / booking it points at, where there is one.
-- origin_verified — whether the SERVER established the claim, or is merely
--                   repeating it.
--
-- Without the third column this feature would be a liability. The sender asserts
-- the origin; a sender who wants to look safe asserts "Trip". Storing that next
-- to a verified one, indistinguishably, would let the product tell a recipient
-- something it does not know — which is worse than telling them nothing, because
-- they would act on it. `origin_verified` defaults to FALSE, so an origin is a
-- CLAIM until something proves otherwise, and only `trip` can be proved today
-- (both parties are accepted members). The reader is expected to render the two
-- differently.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NOTHING IS BACKFILLED
-- ══════════════════════════════════════════════════════════════════════════════
-- Existing requests get NULL, which reads as "we do not know where this came
-- from" — the truthful answer. Inventing 'profile' for every historical row
-- would put a specific claim on records nobody measured.
--
-- ROLLBACK: db/rollback/2026-09-12-2813-telegraph-request-origin-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.message_requests') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_requests must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. The columns
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.message_requests
  ADD COLUMN IF NOT EXISTS origin_type     text    NULL,
  ADD COLUMN IF NOT EXISTS origin_id       uuid    NULL,
  ADD COLUMN IF NOT EXISTS origin_verified boolean NOT NULL DEFAULT false;

-- §22's six, exactly. A CHECK rather than an enum so the set can grow in a
-- later migration without an ALTER TYPE that locks the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.message_requests'::regclass
       AND conname = 'message_requests_origin_type_check'
  ) THEN
    ALTER TABLE public.message_requests
      ADD CONSTRAINT message_requests_origin_type_check
      CHECK (origin_type IS NULL OR origin_type IN ('event','trip','nearby','bump','buddy','profile'));
  END IF;
END $$;

-- An origin_id without an origin_type is a pointer to nothing; an unverified
-- origin with an id is still a claim, which is fine, but the pair must be
-- coherent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.message_requests'::regclass
       AND conname = 'message_requests_origin_pair_check'
  ) THEN
    ALTER TABLE public.message_requests
      ADD CONSTRAINT message_requests_origin_pair_check
      CHECK (origin_id IS NULL OR origin_type IS NOT NULL);
  END IF;
END $$;

-- A verified origin must say what it is. Verification with no type is a boolean
-- floating free of the claim it is supposed to be about.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.message_requests'::regclass
       AND conname = 'message_requests_origin_verified_check'
  ) THEN
    ALTER TABLE public.message_requests
      ADD CONSTRAINT message_requests_origin_verified_check
      CHECK (origin_verified = false OR origin_type IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.message_requests.origin_type IS
  'Telegraph §22 contextual origin: event | trip | nearby | bump | buddy | profile. NULL means unknown — existing rows are NOT backfilled, because inventing an origin for a record nobody measured puts a specific claim on it.';
COMMENT ON COLUMN public.message_requests.origin_verified IS
  'FALSE (the default) means the SENDER asserted this origin and the server did not establish it. TRUE means the server checked. Only trip can be checked today (both parties accepted members). A reader that renders the two the same way tells a recipient something the product does not know.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_request_origin_enabled', false,
   'CAPABILITY gate for Telegraph §22 request origin. OFF (the seed): the message-request insert names none of the three columns and the list endpoint selects none of them, so a database without 2813 behaves exactly as it did. ON: a request may carry an origin, the server verifies it where it can (trip membership today, nothing else), and the recipient is shown a verified origin as a fact and an unverified one as a claim.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing FROM (
    SELECT c FROM unnest(ARRAY['origin_type','origin_id','origin_verified']) c
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='message_requests' AND column_name=c
     )
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: column(s) not added to message_requests: %', v_missing;
  END IF;

  -- origin_verified must default FALSE. A default of true would make every
  -- historical and future row a server-established claim by accident.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='message_requests'
       AND column_name='origin_verified' AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: message_requests.origin_verified must default to false.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.message_requests WHERE origin_verified IS TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a row is already marked origin_verified — this migration backfills nothing.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_request_origin_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_request_origin_enabled was not seeded.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_request_origin_enabled' AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_request_origin_enabled must be seeded FALSE.';
  END IF;
END $$;

COMMIT;
