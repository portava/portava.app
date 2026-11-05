-- 3935_telegraph_member_window_sequence.sql
-- Telegraph §14.3 / §12 membership window in §17.1's coordinate (census-telegraph T210, T139):
-- `visible_from_sequence` WRITTEN, and the operator sequence backfill made safe for every
-- sequence-coordinate column a member row carries. POST-CUTOVER CANONICAL FORWARD MIGRATION
-- (3000-3999 band; lane TELEGRAPH's census-drive band 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. One rule function, one trigger function and its trigger, one
-- function REPLACED (2810's operator backfill), and a bounded data step over
-- message_thread_members (one UPDATE, computed only from rows already in the database).
-- No policy or flag changes and no message row is written. EXECUTE on the three
-- functions is revoked from PUBLIC/anon/authenticated (2810 never revoked the backfill's).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §14.3 "visibleFromSequence / visibleUntilSequence on members". 2810 added both columns
-- and wrote neither; 3934 writes visible_until_sequence when an interval closes. This
-- file writes visible_from_sequence: THE SAME WINDOW 2400's visible_from_at already
-- bounds, expressed in §17.1's coordinate — the first per-conversation sequence the
-- member's window admits:
--
--     visible_from_sequence = min(sequence) of the conversation's messages created at or
--                             after visible_from_at, or last_sequence + 1 if there is none
--
-- (for a member who joins now: the next message). The TIME bound stays authoritative —
-- every reader applies visible_from_at (applyHistoryWindow), and nothing here changes
-- which messages any reader returns. The sequence column is its statement in the
-- envelope's own coordinate, for the readers §17.1 describes (sequence resume). Exact
-- except for a message whose insert raced the join inside the same instant (sequence is
-- allocated under the conversation's row lock, created_at at statement start): the time
-- bound decides that message, as it does today.
--
-- WHEN IT IS WRITTEN — a BEFORE trigger that fires AFTER 2400/2966's
-- telegraph_member_visibility_window on the same row (PostgreSQL fires same-timing
-- triggers in name order: "..._visibility_window" < "..._window_sequence"), so it sees
-- the window that trigger just opened:
--   INSERT                       the window opens; an explicit visible_from_sequence is kept.
--   UPDATE that moves the window a rejoin (2400 sets visible_from_at := now()) or an
--                                earlier-timestamp grant: recomputed from the new window.
--   a row with no window         (pre-2400, visible_from_at NULL): untouched, NULL, which is
--                                2810's "unbounded" — the same meaning visible_from_at's NULL has.
--
-- THE BACKFILL, MADE SAFE (2810's telegraph_backfill_message_sequences, replaced).
-- The operator backfill RENUMBERS a conversation from 1 in (created_at, id) order — the
-- pre-kernel messages first, so every message sequenced since the kernel went on moves UP.
-- Any column that stores a sequence would then point at a different message:
--   visible_from_sequence  a bound left behind would ADMIT pre-membership messages
--                          (the direction §26 RLS-03 forbids);
--   visible_until_sequence a closed interval's edge would move;
--   delivered_sequence /   batch 2's receipt cursors (census T72) would move, and a
--   seen_sequence          receipt would be read against the wrong message.
-- The replacement renumbers exactly as 2810 did, in the SAME statement-sequence and the
-- same transaction rebases every member row of that conversation:
--   visible_from_sequence   recomputed from visible_from_at by the rule above;
--   visible_until_sequence  recomputed from left_at: the greatest sequence created at or
--                           before it (NULL when there is none);
--   delivered_sequence,     carried BY MESSAGE IDENTITY: the cursor's message keeps its
--   seen_sequence           place, at its new number. A cursor no message carries
--                           (unexpected) becomes the greatest new number at or below it.
-- Still ONE conversation per call, not called by any migration or application code, and
-- re-running it is a no-op (the numbering is stable, so every rebase maps to itself).
--
-- THE DATA STEP. Rows written before this file carry visible_from_at but no
-- visible_from_sequence, and closed intervals no visible_until_sequence (3934 writes it
-- only from now on). One UPDATE fills both by the same rules, ONLY where they are NULL
-- and the time bound exists. It names neither visible_from_at nor left_at in its SET list,
-- so neither membership trigger rewrites anything on the way.
--
-- NO CLIENT CAN WRITE THESE COLUMNS (unchanged): message_thread_members has RLS with no
-- UPDATE policy and an INSERT check of `false` on production (read 2026-10-23).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number in the lane band; on portava-ci and production it is
-- applied after 3999)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 2400 (visible_from_at and its trigger) and 2810 (messages.sequence,
-- message_threads.last_sequence, the four member columns, the backfill function it
-- replaces). Nothing numbered above 3935 names message_thread_members, the trigger or
-- either function. Independent of 3934 (it reads no removed_at); with 3934 present the
-- two agree, because 3934's visible_until_sequence (last_sequence at departure) is the
-- greatest sequence created at or before left_at.
--
-- ROLLBACK (nothing depends on these objects):
--   BEGIN;
--   DROP TRIGGER IF EXISTS telegraph_member_window_sequence ON public.message_thread_members;
--   DROP FUNCTION IF EXISTS public.telegraph_member_window_sequence();
--   -- restore 2810's backfill: re-run section 7 of 2810_telegraph_message_kernel.sql
--   --   (CREATE OR REPLACE FUNCTION public.telegraph_backfill_message_sequences ...)
--   -- the data step is left in place: the values are derived, and NULL is "unbounded".
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3935_telegraph_member_window_sequence.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'visible_from_at' AND atttypid = 'timestamptz'::regtype)
           OR (attname = 'left_at' AND atttypid = 'timestamptz'::regtype)
           OR (attname IN ('visible_from_sequence', 'visible_until_sequence', 'delivered_sequence', 'seen_sequence')
               AND atttypid = 'int8'::regtype))) <> 6 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3935): message_thread_members must carry visible_from_at, left_at (timestamptz) and the four 2810 sequence columns (bigint).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.messages'::regclass AND attname = 'sequence'
                    AND atttypid = 'int8'::regtype AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.message_threads'::regclass AND attname = 'last_sequence'
                    AND atttypid = 'int8'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3935): messages.sequence and message_threads.last_sequence (2810) must exist.';
  END IF;
  IF to_regprocedure('public.telegraph_member_visibility_window()') IS NULL
     OR to_regprocedure('public.telegraph_backfill_message_sequences(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3935): 2400''s telegraph_member_visibility_window() and 2810''s telegraph_backfill_message_sequences(uuid) must exist.';
  END IF;
END $pre$;

-- ── The rule, once: the first sequence a window that opens at p_from admits ──────────
CREATE OR REPLACE FUNCTION public.telegraph_window_first_sequence(p_thread_id uuid, p_from timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  SELECT COALESCE(
    (SELECT min(m.sequence) FROM public.messages m
      WHERE m.thread_id = p_thread_id AND m.sequence IS NOT NULL AND m.created_at >= p_from),
    (SELECT COALESCE(t.last_sequence, 0) + 1 FROM public.message_threads t WHERE t.id = p_thread_id))
$fn$;

COMMENT ON FUNCTION public.telegraph_window_first_sequence(uuid, timestamptz) IS
  'Telegraph §14.3/§17.1 (census-telegraph T210, 3935): the first per-conversation sequence a window opening at p_from admits — the least sequence created at or after it, else last_sequence + 1. The one statement of the rule; the membership trigger, the backfill rebase and 3935''s data step all use it.';

-- ── The writer ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.telegraph_member_window_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.visible_from_at IS NULL THEN
    RETURN NEW;  -- no window (a pre-2400 row): NULL stays "unbounded", as visible_from_at's NULL is
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.visible_from_sequence IS NULL THEN
      NEW.visible_from_sequence := public.telegraph_window_first_sequence(NEW.thread_id, NEW.visible_from_at);
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the window moved (a rejoin opens a new one; a grant writes an earlier time),
  -- or the row has a window and no sequence statement of it yet.
  IF NEW.visible_from_at IS DISTINCT FROM OLD.visible_from_at OR NEW.visible_from_sequence IS NULL THEN
    NEW.visible_from_sequence := public.telegraph_window_first_sequence(NEW.thread_id, NEW.visible_from_at);
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_member_window_sequence() IS
  'Telegraph §14.3 (census-telegraph T210/T139, 3935): writes visible_from_sequence — the membership window 2400''s visible_from_at bounds, in §17.1''s coordinate. Fires after telegraph_member_visibility_window (name order). The time bound stays authoritative for every reader.';

DROP TRIGGER IF EXISTS telegraph_member_window_sequence ON public.message_thread_members;
CREATE TRIGGER telegraph_member_window_sequence
  BEFORE INSERT OR UPDATE OF visible_from_at, left_at, visible_from_sequence ON public.message_thread_members
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_member_window_sequence();

-- ── The operator backfill, replaced so it rebases what it renumbers ─────────────────
CREATE OR REPLACE FUNCTION public.telegraph_backfill_message_sequences(p_thread_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_assigned bigint := 0;
BEGIN
  -- ONE CONVERSATION PER CALL, as 2810 wrote it: bounded by the length of a conversation,
  -- stoppable, resumable, and the granularity the invariant lives at.
  --
  -- 3935: the conversation's row lock first. 2810's sequence trigger takes the same lock to
  -- allocate a number, so no message can be sequenced in this conversation while it is
  -- being renumbered and rebased (2810's version could interleave with a send).
  PERFORM 1 FROM public.message_threads WHERE id = p_thread_id FOR UPDATE;

  -- 3935, step 1 — BEFORE renumbering, carry the receipt cursors by MESSAGE IDENTITY: each
  -- cursor moves to the new number its message is about to get (the numbering below is
  -- deterministic, so it is computed here once and applied to both). A cursor no message
  -- carries (unexpected) becomes the greatest new number at or below it.
  WITH ordered AS (
    SELECT id, sequence AS old_seq, row_number() OVER (ORDER BY created_at, id) AS new_seq
      FROM public.messages
     WHERE thread_id = p_thread_id
  )
  UPDATE public.message_thread_members mtm
     SET delivered_sequence = CASE WHEN mtm.delivered_sequence IS NULL THEN NULL
                                   ELSE COALESCE((SELECT o.new_seq FROM ordered o WHERE o.old_seq = mtm.delivered_sequence LIMIT 1),
                                                 (SELECT max(o.new_seq) FROM ordered o WHERE o.old_seq IS NOT NULL AND o.old_seq <= mtm.delivered_sequence)) END,
         seen_sequence = CASE WHEN mtm.seen_sequence IS NULL THEN NULL
                              ELSE COALESCE((SELECT o.new_seq FROM ordered o WHERE o.old_seq = mtm.seen_sequence LIMIT 1),
                                            (SELECT max(o.new_seq) FROM ordered o WHERE o.old_seq IS NOT NULL AND o.old_seq <= mtm.seen_sequence)) END
   WHERE mtm.thread_id = p_thread_id
     AND (mtm.delivered_sequence IS NOT NULL OR mtm.seen_sequence IS NOT NULL);

  -- Step 2 — 2810's renumbering, unchanged.
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

  -- Step 3 — AFTER renumbering, the window bounds are recomputed from their TIME bounds,
  -- which are authoritative: visible_from_sequence by telegraph_window_first_sequence
  -- (the window trigger's own rule), visible_until_sequence as the greatest sequence
  -- created at or before left_at.
  UPDATE public.message_thread_members mtm
     SET visible_from_sequence = public.telegraph_window_first_sequence(mtm.thread_id, mtm.visible_from_at)
   WHERE mtm.thread_id = p_thread_id AND mtm.visible_from_at IS NOT NULL;
  UPDATE public.message_thread_members mtm
     SET visible_until_sequence = (SELECT max(m.sequence) FROM public.messages m
                                    WHERE m.thread_id = mtm.thread_id AND m.created_at <= mtm.left_at)
   WHERE mtm.thread_id = p_thread_id AND mtm.left_at IS NOT NULL;

  RETURN v_assigned;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_backfill_message_sequences(uuid) IS
  'Telegraph §17.1 backfill, ONE conversation per call (2810; rebase added by 3935, census-telegraph T210/T72). Renumbers by (created_at, id) as 2810 did, and in the same transaction rebases every member row of the conversation: the window bounds recomputed from visible_from_at / left_at, the receipt cursors carried by message identity. Not called by any migration and not by any application code; re-running it is a no-op.';

-- The backfill is an operator function: nobody else runs it.
REVOKE ALL ON FUNCTION public.telegraph_backfill_message_sequences(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.telegraph_member_window_sequence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.telegraph_window_first_sequence(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── The data step: rows written before this file ────────────────────────────────────
UPDATE public.message_thread_members mtm
   SET visible_from_sequence = CASE WHEN mtm.visible_from_sequence IS NULL AND mtm.visible_from_at IS NOT NULL
                                    THEN public.telegraph_window_first_sequence(mtm.thread_id, mtm.visible_from_at)
                                    ELSE mtm.visible_from_sequence END,
       visible_until_sequence = CASE WHEN mtm.visible_until_sequence IS NULL AND mtm.left_at IS NOT NULL
                                     THEN (SELECT max(m.sequence) FROM public.messages m
                                            WHERE m.thread_id = mtm.thread_id AND m.created_at <= mtm.left_at)
                                     ELSE mtm.visible_until_sequence END
 WHERE (mtm.visible_from_sequence IS NULL AND mtm.visible_from_at IS NOT NULL)
    OR (mtm.visible_until_sequence IS NULL AND mtm.left_at IS NOT NULL);

COMMIT;

-- ── Postconditions (recomputed from the catalog and the data) ──────────────────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.message_thread_members'::regclass AND tgname = 'telegraph_member_window_sequence'
                    AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3935): trigger telegraph_member_window_sequence is missing or disabled.';
  END IF;
  -- Fires AFTER 2400's window trigger: same timing, so name order decides.
  IF NOT ('telegraph_member_visibility_window' < 'telegraph_member_window_sequence') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3935): the window-sequence trigger would fire before the window it states.';
  END IF;
  IF position('telegraph_window_first_sequence' IN pg_get_functiondef('public.telegraph_backfill_message_sequences(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3935): telegraph_backfill_message_sequences is not the rebasing version.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message_thread_members WHERE visible_from_at IS NOT NULL AND visible_from_sequence IS NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3935): a member with a window has no visible_from_sequence.';
  END IF;
  IF has_function_privilege('authenticated', 'public.telegraph_backfill_message_sequences(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.telegraph_backfill_message_sequences(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3935): a client role can run the sequence backfill.';
  END IF;
END $post$;
