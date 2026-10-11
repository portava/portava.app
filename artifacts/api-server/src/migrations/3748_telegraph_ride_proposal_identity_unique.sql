-- 3748_telegraph_ride_proposal_identity_unique.sql
-- Telegraph §9 Returning, shared transport (census-telegraph T107, §81) — the
-- DATABASE decides which of N simultaneous ride proposals carrying one request
-- identity is written. POST-CUTOVER CANONICAL FORWARD MIGRATION.
-- Lane tg-rides (wave W), band 3748-3752.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (owner ruling on PR #685, 2026-10-11)
-- ══════════════════════════════════════════════════════════════════════════════
-- POST /threads/:id/coordination answered a replayed SPLIT_RIDE proposal with the
-- ride that already existed by READING first — a check-then-insert. Two requests
-- that both read before either wrote created two rides. The owner ruled: the
-- request identity is stored in a real column (not inside messages.body) and a
-- partial unique index scoped to that identity refuses the second row; the loser
-- of the race (23505) is answered with the winner's ride.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE CREATES NO COLUMN — the column and the index already exist
-- ══════════════════════════════════════════════════════════════════════════════
-- 2810 (Telegraph message kernel) added exactly the storage the ruling asks for:
--   messages.idempotency_key text
--   messages_idempotency_uniq UNIQUE (thread_id, sender_id, idempotency_key)
--                             WHERE idempotency_key IS NOT NULL
-- §17.2's idempotent send (3654, flag OFF) is its other writer. A second column
-- for the same meaning would give one message two identities. The ride route now
-- writes its key there (services/telegraph/threadEnvelopeWrites.ts).
--
-- THE SCOPE IS THE REQUEST IDENTITY: one sender's retry handle inside one
-- conversation. thread_id, because a key means nothing outside the conversation
-- it was sent to. sender_id, because two people's clients may mint the same key
-- and neither may suppress — or be handed — the other's ride. A wider scope
-- (thread only, or global) would let one member's key collide with another's.
-- A narrower one (adding msg_type) would let one request write a ride AND a text
-- under one identity, which is two answers to one retry.
--
-- So this file ASSERTS what the route now depends on, and fails loudly where it
-- does not hold. It never deletes, merges or rewrites a row:
--   $pre$  refuses unless 2810's column exists; refuses if ANY (thread_id,
--          sender_id, idempotency_key) group holds more than one row (the
--          read-only duplicate inspection — it can only find rows where the
--          index is missing, because where it exists it already forbids them);
--          refuses if an index named messages_idempotency_uniq exists with a
--          different definition.
--   body   CREATE UNIQUE INDEX IF NOT EXISTS with 2810's exact definition (a
--          no-op wherever 2810 applied), and a COMMENT naming the ride writer.
--   $post$ recomputes everything from the catalog and the data.
--
-- BY CONSTRUCTION no existing row can violate the index on a database where 2810
-- applied: the index has enforced it since that row was written. Rows written
-- before 2810 have idempotency_key NULL (2810 added the column with no default)
-- and the partial index excludes NULL.
--
-- No table, no column, no grant, no policy, no flag. Rule 4 is unaffected:
-- nothing new is created that a client role could be granted.
--
-- ROLLBACK: db/rollback/2026-10-11-3748-telegraph-ride-proposal-identity-unique-rollback.sql
-- (restores 2810's index comment; the index itself is 2810's and stays).

BEGIN;

DO $pre$
DECLARE
  v_dupes bigint;
  v_example text;
  v_idx regclass := to_regclass('public.messages_idempotency_uniq');
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3748): public.messages does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.messages'::regclass AND attname = 'idempotency_key'
                    AND attnum > 0 AND NOT attisdropped
                    AND atttypid = 'text'::regtype) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3748): public.messages.idempotency_key (text) does not exist — apply 2810 first.';
  END IF;

  -- The duplicate inspection. Read-only; a finding is a refusal, never a fix.
  SELECT count(*), min(format('thread %s / sender %s / key %s (%s rows)', thread_id, sender_id, idempotency_key, n))
    INTO v_dupes, v_example
    FROM (SELECT thread_id, sender_id, idempotency_key, count(*) AS n
            FROM public.messages
           WHERE idempotency_key IS NOT NULL
           GROUP BY thread_id, sender_id, idempotency_key
          HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3748): % (thread_id, sender_id, idempotency_key) group(s) hold more than one message, e.g. %. Nothing was changed. Decide what each duplicate is before re-running; this migration will not delete or merge them.', v_dupes, v_example;
  END IF;

  IF v_idx IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.messages'::regclass
       AND i.indisunique
       AND i.indnkeyatts = 3
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'thread_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'sender_id'
       AND pg_get_indexdef(i.indexrelid, 3, true) = 'idempotency_key'
       AND pg_get_expr(i.indpred, i.indrelid, true) = 'idempotency_key IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3748): an index named messages_idempotency_uniq exists but is not 2810''s UNIQUE (thread_id, sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL: %. Refusing to build on it.', pg_get_indexdef(v_idx);
  END IF;
END $pre$;

CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_uniq
  ON public.messages (thread_id, sender_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON INDEX public.messages_idempotency_uniq IS
  'One message per request identity (thread_id, sender_id, idempotency_key). Telegraph §17.2 resend (2810, 3654) and the §9 shared-ride proposal (census-telegraph T107, 3748): N simultaneous requests with one identity write ONE row; the others get 23505 and are answered with it.';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from catalog and data ─────────
DO $post$
DECLARE
  v_idx regclass := to_regclass('public.messages_idempotency_uniq');
  v_dupes bigint;
BEGIN
  IF v_idx IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3748): messages_idempotency_uniq does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.messages'::regclass
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND i.indnkeyatts = 3
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'thread_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'sender_id'
       AND pg_get_indexdef(i.indexrelid, 3, true) = 'idempotency_key'
       AND pg_get_expr(i.indpred, i.indrelid, true) = 'idempotency_key IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3748): messages_idempotency_uniq is not a valid UNIQUE (thread_id, sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL: %', pg_get_indexdef(v_idx);
  END IF;
  SELECT count(*) INTO v_dupes
    FROM (SELECT 1 FROM public.messages
           WHERE idempotency_key IS NOT NULL
           GROUP BY thread_id, sender_id, idempotency_key
          HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3748): % duplicate request-identity group(s) exist.', v_dupes;
  END IF;
  IF obj_description(v_idx, 'pg_class') IS NULL OR position('T107' IN obj_description(v_idx, 'pg_class')) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3748): the index comment does not name the ride writer.';
  END IF;
END $post$;
