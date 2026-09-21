-- 2810_telegraph_message_kernel.sql
-- Telegraph §12.1 / §13.3 / §17.1 / §17.2 — the message envelope, the
-- per-conversation sequence, the transactional event outbox, and the member
-- sequence bounds. POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Telegraph lane 2810-2819.
--
-- Required identically by both specification versions (v1_1 is a byte-exact
-- superset of v1):
--   §12    conversations · conversation_members · messages · conversation_outbox
--   §12.1  "type Message = { … sequence: bigint … contentRef? … unsentAt? …
--          clientMessageId … idempotencyKey … lifecycleState … }"
--   §13.3  "Canonical mutation and event-outbox write occur in the same
--          database transaction."
--   §14.3  conversation_member.visibleFromSequence / visibleUntilSequence
--   §17.1  "Require per-conversation server sequence ordering, not global
--          ordering. Client timestamps are advisory only."
--   §17.2  "Offline resend must be idempotent. Tombstones preserve sequence
--          continuity for unsent/deleted messages. Reconnect resumes from last
--          acknowledged conversation/event sequence."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A SEQUENCE NOW, WHEN 2400 DELIBERATELY DECLINED ONE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2400's header says it plainly: "This schema has no sequence column on
-- public.messages; every reader orders and paginates by created_at, and
-- migration 2325 declined to introduce a competing sequence for the same
-- reason (Appendix A: reuse the established convention)." That was the right
-- call for 2400, whose job was a history BOUND it could express in the
-- coordinate the readers already used — and 2400 said what would make the other
-- choice right: "If a sequence is ever introduced, visible_from_at maps onto it
-- monotonically."
--
-- This is that introduction, and the reason is not tidiness. census-telegraph
-- T228 states the defect precisely: ordering by created_at "cannot distinguish
-- two messages written in the same millisecond and cannot express 'after event
-- N'". The second half is the one that matters — §17.2's "reconnect resumes
-- from last acknowledged sequence" and §13.3's outbox both need a total order
-- per conversation that a client can name. A timestamp cursor cannot be
-- acknowledged: two clients can disagree about whether a boundary row was
-- included, and a resumed stream either repeats a message or drops one.
--
-- IT DOES NOT COMPETE WITH created_at, AND NOTHING SWITCHES OVER HERE.
-- Every reader in this tree still orders by created_at after this migration.
-- The column is populated for NEW rows by a trigger and is NULL for every row
-- that predates it; `telegraph_message_kernel_enabled` is seeded FALSE and no
-- shipped reader consults any column added here. A database that has run this
-- file behaves exactly as one that has not, until an owner turns the flag on.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES *NOT* DO, STATED SO IT IS NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- IT DOES NOT BACKFILL. Historical `messages.sequence` stays NULL. A backfill
-- over the whole table inside a migration is an unbounded UPDATE holding a lock
-- on the hottest table in the product, and calling that "additive" because it
-- adds no column would be false. The backfill is a FUNCTION an operator calls
-- in bounded batches (`public.telegraph_backfill_message_sequences`), and it is
-- never called from here. Until it is run, `sequence IS NULL` means "predates
-- the kernel", which is the same NULL semantics 2400 gave `visible_from_at`.
--
-- IT DOES NOT MOVE ANY WRITER. `routes/messaging.ts` still INSERTs the same
-- columns. The trigger fills the new ones; no application code has to change to
-- keep working, and no application code gains a behaviour by this file alone.
--
-- IT DOES NOT DRAIN THE OUTBOX. `public.telegraph_outbox` accumulates rows with
-- `published_at IS NULL` and nothing reads them yet. An outbox with no drainer
-- is a growing table, which is why the flag is the gate on the WRITE side too:
-- with `telegraph_message_kernel_enabled` FALSE the trigger writes nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE TRANSACTIONAL CLAIM, AND ITS LIMIT
-- ══════════════════════════════════════════════════════════════════════════════
-- §13.3 asks that the canonical mutation and the outbox write happen in the
-- same transaction. A trigger on `public.messages` gives exactly that and gives
-- it to EVERY writer, including ones written later and ones that forget — which
-- is the only version of this guarantee that survives contact with a codebase
-- that has two chat-sync implementations. What it does NOT give is
-- exactly-once DELIVERY: that needs a drainer with a cursor, and §13.3's second
-- sentence ("consume asynchronously and idempotently") is a property of the
-- consumer. `dedupe_key` is here so that consumer can be written; nothing here
-- makes it exist.
--
-- ROLLBACK: db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist.';
  END IF;
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_threads must exist.';
  END IF;
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. §12.1 — the envelope's six missing fields
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sequence bigint;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS client_message_id text;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS content_ref text;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS unsent_at timestamptz;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS lifecycle_state text;

COMMENT ON COLUMN public.messages.sequence IS
  'Telegraph §12.1/§17.1 per-conversation sequence. Monotonic within thread_id, assigned by trigger telegraph_assign_message_sequence from message_threads.last_sequence under a row lock. NULL = predates migration 2810 (see telegraph_backfill_message_sequences). Not read by any shipped reader while telegraph_message_kernel_enabled is FALSE.';
COMMENT ON COLUMN public.messages.client_message_id IS
  'Telegraph §12.1/§17.2 clientMessageId. The client-generated correlation id. routes/messaging.ts already ACCEPTS and echoes one (census T230); this is where it can finally be retained.';
COMMENT ON COLUMN public.messages.idempotency_key IS
  'Telegraph §12.1/§17.2 idempotencyKey. Unique per (thread_id, sender_id) where present — see messages_idempotency_uniq. A retried offline send that reuses its key conflicts instead of creating a second message.';
COMMENT ON COLUMN public.messages.content_ref IS
  'Telegraph §12.1 contentRef. A reference to structured content held elsewhere, for the card kinds §12.1 says must NOT live as unversioned JSON inside body (census T157).';
COMMENT ON COLUMN public.messages.unsent_at IS
  'Telegraph §7.4/§12.1 unsentAt. Distinct from deleted_at: an unsend is retracted BEFORE any eligible recipient saw it; a delete is a tombstone after. Both keep the row so the sequence stays continuous (§17.2).';
COMMENT ON COLUMN public.messages.lifecycle_state IS
  'Telegraph §12.1 lifecycleState. NULL = predates 2810. Constrained to sent|edited|unsent|deleted.';

-- A CHECK that admits NULL, because every existing row has one and a NOT VALID
-- constraint that nobody validates is a constraint in name only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_lifecycle_state_check'
       AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_lifecycle_state_check
      CHECK (lifecycle_state IS NULL OR lifecycle_state IN ('sent', 'edited', 'unsent', 'deleted'));
  END IF;
END $$;

-- §17.2: "Offline resend must be idempotent." A PARTIAL unique index, so the
-- overwhelming majority of rows (which carry no key) are unaffected and cost
-- nothing. Scoped to (thread_id, sender_id) rather than globally: two different
-- people's clients may generate the same key and neither should be able to
-- suppress the other's message.
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_uniq
  ON public.messages (thread_id, sender_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The read pattern §17.2's resume needs: "this conversation, after sequence N".
CREATE INDEX IF NOT EXISTS messages_thread_sequence_idx
  ON public.messages (thread_id, sequence DESC)
  WHERE sequence IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. §12 conversations — the counter, and the policy the spec names
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.message_threads ADD COLUMN IF NOT EXISTS last_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE public.message_threads ADD COLUMN IF NOT EXISTS policy_id uuid;
ALTER TABLE public.message_threads ADD COLUMN IF NOT EXISTS policy_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.message_threads.last_sequence IS
  'Telegraph §17.1: the highest sequence assigned in this conversation. Owned by trigger telegraph_assign_message_sequence, which locks this row to allocate. 0 = nothing assigned yet.';
COMMENT ON COLUMN public.message_threads.policy_id IS
  'Telegraph §12 "conversations — identity, type, lifecycle, current policy/version" (census T138). The conversation policy in force. NULL = the default policy, which is the only one this tree has.';
COMMENT ON COLUMN public.message_threads.policy_version IS
  'Telegraph §12 policy VERSION, so a capability decision can be attributed to the policy that produced it rather than to whatever the policy is today.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. §14.3 / §12 conversation_members — the sequence bounds and cursors
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.message_thread_members ADD COLUMN IF NOT EXISTS visible_from_sequence bigint;
ALTER TABLE public.message_thread_members ADD COLUMN IF NOT EXISTS visible_until_sequence bigint;
ALTER TABLE public.message_thread_members ADD COLUMN IF NOT EXISTS delivered_sequence bigint;
ALTER TABLE public.message_thread_members ADD COLUMN IF NOT EXISTS seen_sequence bigint;

COMMENT ON COLUMN public.message_thread_members.visible_from_sequence IS
  'Telegraph §14.3 visibleFromSequence. The sequence coordinate of the bound migration 2400 expressed as visible_from_at; the two are monotonically related and 2400 said so. NULL = unbounded.';
COMMENT ON COLUMN public.message_thread_members.visible_until_sequence IS
  'Telegraph §14.3 visibleUntilSequence. Set when a membership interval CLOSES, so a departed member''s window has an upper edge as well as a lower one. NULL = open.';
COMMENT ON COLUMN public.message_thread_members.delivered_sequence IS
  'Telegraph §12/§13.2 message.delivered (census T69/T178): the highest sequence this member''s device has acknowledged RECEIVING. Distinct from seen_sequence, which is about attention, not transport.';
COMMENT ON COLUMN public.message_thread_members.seen_sequence IS
  'Telegraph §12: per-message seen state in the sequence coordinate. last_read_at answers "roughly when"; this answers "which message", which is what §13.2 message.seen needs (census T179).';

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. §13.3 — the transactional outbox
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.telegraph_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       text        NOT NULL,
  -- §12.1's "structured payload types use versioned schemas": the version is a
  -- column and not a field inside the JSON, so a consumer can filter on it
  -- without parsing, and an unparseable payload still declares its shape.
  event_version    integer     NOT NULL DEFAULT 1,
  conversation_id  uuid        NOT NULL,
  message_id       uuid,
  sequence         bigint,
  actor_id         uuid,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- §13.3's "consume … idempotently". The key is what makes a redelivery
  -- detectable by a consumer that has no memory of its own.
  dedupe_key       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  attempts         integer     NOT NULL DEFAULT 0,
  last_error       text,
  CONSTRAINT telegraph_outbox_event_type_check
    CHECK (event_type IN (
      'message.sent', 'message.edited', 'message.unsent', 'message.deleted'
    ))
);

COMMENT ON TABLE public.telegraph_outbox IS
  'Telegraph §13.3 conversation_outbox. Written by trigger telegraph_outbox_from_message in the SAME transaction as the message mutation, so a crash between the write and the publish cannot lose the event (census T154/T195). NOTHING DRAINS IT YET: rows accumulate with published_at NULL, which is why the trigger is gated on telegraph_message_kernel_enabled and writes nothing while that flag is FALSE.';
COMMENT ON COLUMN public.telegraph_outbox.dedupe_key IS
  'Stable per (event, message, lifecycle transition). A consumer that has seen this key has applied this event; §13.3 requires consumers be idempotent and this is the handle they do it with.';

CREATE UNIQUE INDEX IF NOT EXISTS telegraph_outbox_dedupe_uniq
  ON public.telegraph_outbox (dedupe_key);

-- The drain order: oldest unpublished first.
CREATE INDEX IF NOT EXISTS telegraph_outbox_unpublished_idx
  ON public.telegraph_outbox (created_at)
  WHERE published_at IS NULL;

ALTER TABLE public.telegraph_outbox ENABLE ROW LEVEL SECURITY;

-- No policy is created, and that is the decision, not an omission: RLS enabled
-- with zero policies denies every non-service role outright. The outbox is
-- infrastructure — a projection queue — and no end user has a reason to read
-- it. A permissive policy added later would need to explain what a traveller
-- does with an event log of their own conversation that the conversation does
-- not already show them.

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. The sequence assigner
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_assign_message_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_enabled boolean;
  v_next    bigint;
BEGIN
  -- The flag is read INSIDE the trigger rather than gating the trigger's
  -- existence, so turning the capability on does not require a migration and
  -- turning it off does not leave half-sequenced data behind: it simply stops
  -- allocating, and NULL keeps meaning "no sequence".
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled';
  IF COALESCE(v_enabled, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.sequence IS NOT NULL THEN
    RETURN NEW;  -- an explicit sequence (replay, import) is respected
  END IF;

  -- Allocation under a row lock on the conversation. This SERIALISES concurrent
  -- sends in one thread, which is exactly what "per-conversation ordering"
  -- means and is the cost of having it: two people typing at once take turns
  -- for the duration of one UPDATE. Threads do not contend with each other.
  UPDATE public.message_threads
     SET last_sequence = last_sequence + 1
   WHERE id = NEW.thread_id
  RETURNING last_sequence INTO v_next;

  IF v_next IS NULL THEN
    -- The thread row is missing. The message insert would fail its FK anyway;
    -- refusing here makes the reason legible instead of surfacing as a
    -- constraint violation on a different table.
    RAISE EXCEPTION 'telegraph_assign_message_sequence: no message_threads row for %', NEW.thread_id;
  END IF;

  NEW.sequence := v_next;
  NEW.lifecycle_state := COALESCE(NEW.lifecycle_state, 'sent');
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_assign_message_sequence() IS
  'Telegraph §17.1: allocates the per-conversation sequence from message_threads.last_sequence under a row lock. No-op while telegraph_message_kernel_enabled is FALSE, so a database that has run 2810 behaves exactly as one that has not.';

DROP TRIGGER IF EXISTS telegraph_assign_message_sequence ON public.messages;
CREATE TRIGGER telegraph_assign_message_sequence
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_assign_message_sequence();

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. The outbox writer — §13.3's "same database transaction"
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_outbox_from_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_enabled boolean;
  v_type    text;
  v_key     text;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled';
  IF COALESCE(v_enabled, false) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_type := 'message.sent';
    v_key  := 'message.sent:' || NEW.id::text;
  ELSE
    -- One UPDATE can only be one lifecycle transition, and the order below is
    -- the precedence: an unsend of an edited message is an unsend.
    IF NEW.unsent_at IS NOT NULL AND OLD.unsent_at IS NULL THEN
      v_type := 'message.unsent';
      v_key  := 'message.unsent:' || NEW.id::text;
    ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      v_type := 'message.deleted';
      v_key  := 'message.deleted:' || NEW.id::text;
    ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at AND NEW.edited_at IS NOT NULL THEN
      v_type := 'message.edited';
      -- An edit can happen more than once, so the key carries WHICH edit.
      v_key  := 'message.edited:' || NEW.id::text || ':' || extract(epoch from NEW.edited_at)::text;
    ELSE
      RETURN NULL;  -- not a lifecycle transition; nothing to publish
    END IF;
  END IF;

  INSERT INTO public.telegraph_outbox
    (event_type, event_version, conversation_id, message_id, sequence, actor_id, payload, dedupe_key)
  VALUES
    (v_type, 1, NEW.thread_id, NEW.id, NEW.sequence, NEW.sender_id,
     jsonb_build_object(
       'messageId', NEW.id,
       'conversationId', NEW.thread_id,
       'sequence', NEW.sequence,
       'senderId', NEW.sender_id,
       'msgType', NEW.msg_type,
       'subtype', NEW.subtype,
       'hasMedia', (NEW.media_url IS NOT NULL)
       -- NO BODY. §28/§30A.17's rule that a message body never leaves the
       -- message row applies to a queue as much as to a log: an outbox row is
       -- read by projections, indexers and analytics, and a body here would
       -- reach all three.
     ),
     v_key)
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_outbox_from_message() IS
  'Telegraph §13.3: writes the domain event into public.telegraph_outbox in the SAME transaction as the message mutation. Carries no message body. No-op while telegraph_message_kernel_enabled is FALSE.';

DROP TRIGGER IF EXISTS telegraph_outbox_from_message ON public.messages;
CREATE TRIGGER telegraph_outbox_from_message
  AFTER INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_outbox_from_message();

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. The backfill, as a function an operator calls — never from here
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_backfill_message_sequences(p_thread_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_assigned bigint := 0;
BEGIN
  -- ONE CONVERSATION PER CALL, deliberately. A whole-table backfill is an
  -- unbounded UPDATE on the hottest table in the product; a per-thread one is
  -- bounded by the length of a conversation and can be run in as many batches
  -- as an operator wants, stopped at any point, and resumed. It is also the
  -- granularity the invariant lives at: sequences are per conversation, so a
  -- half-finished run leaves every finished conversation correct.
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
      FROM public.messages
     WHERE thread_id = p_thread_id
  )
  UPDATE public.messages m
     SET sequence = o.rn,
         lifecycle_state = COALESCE(m.lifecycle_state,
                                    CASE WHEN m.deleted_at IS NOT NULL THEN 'deleted'
                                         WHEN m.edited_at IS NOT NULL THEN 'edited'
                                         ELSE 'sent' END)
    FROM ordered o
   WHERE m.id = o.id;

  GET DIAGNOSTICS v_assigned = ROW_COUNT;

  UPDATE public.message_threads
     SET last_sequence = GREATEST(last_sequence,
                                  COALESCE((SELECT max(sequence) FROM public.messages WHERE thread_id = p_thread_id), 0))
   WHERE id = p_thread_id;

  RETURN v_assigned;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_backfill_message_sequences(uuid) IS
  'Telegraph §17.1 backfill, ONE conversation per call. Not called by any migration and not called by any application code. Ordering is (created_at, id) — id breaks the millisecond ties that are the reason §17.1 asks for a sequence at all, and it is stable, so re-running produces the same numbering.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_message_kernel_enabled', false,
   'CAPABILITY gate for Telegraph §12.1/§13.3/§17.1 — the message envelope, the per-conversation sequence and the transactional outbox. OFF (the seed): both triggers return immediately, messages.sequence stays NULL on every new row, public.telegraph_outbox receives nothing, and every reader behaves exactly as it did before 2810. ON: new messages are sequenced under a per-conversation row lock and every lifecycle transition writes one outbox row in the same transaction. Turning it ON without a drainer means the outbox grows; that is a deliberate ordering (the queue must be correct before anything consumes it) and is stated on the table comment.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing FROM (
    SELECT c FROM unnest(ARRAY['sequence','client_message_id','idempotency_key','content_ref','unsent_at','lifecycle_state']) c
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='messages' AND column_name=c)
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages missing column(s): %', v_missing;
  END IF;

  SELECT string_agg(c, ', ') INTO v_missing FROM (
    SELECT c FROM unnest(ARRAY['visible_from_sequence','visible_until_sequence','delivered_sequence','seen_sequence']) c
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='message_thread_members' AND column_name=c)
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: message_thread_members missing column(s): %', v_missing;
  END IF;

  IF to_regclass('public.telegraph_outbox') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.telegraph_outbox was not created.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'telegraph_assign_message_sequence') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sequence trigger missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'telegraph_outbox_from_message') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: outbox trigger missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_message_kernel_enabled was not seeded.';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled') IS NOT FALSE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_message_kernel_enabled must be seeded FALSE.';
  END IF;
END $$;

COMMIT;
