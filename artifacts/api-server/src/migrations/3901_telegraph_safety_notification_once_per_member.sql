-- 3901_telegraph_safety_notification_once_per_member.sql
-- Telegraph §19 P0 SAFETY (census-telegraph T254, the safety lane's durable
-- re-drive): ONE notification per member per help request, decided by the
-- DATABASE. POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, gap
-- number 3901; docs/ops/wave5-owner-decisions-20261018.md "Migrations").
--
-- WRITTEN, NOT APPLIED. Additive: one partial unique index on
-- public.notifications. No table, column, row, grant, policy or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT: the cross-instance double-tell
-- ══════════════════════════════════════════════════════════════════════════════
-- services/telegraph/safetyNotifications.ts tells each member about a help
-- request (SOS / NEED_HELP, and the ALL CLEAR that ends one) by writing one
-- public.notifications row carrying metadata.causal_event_id = 'MESSAGE:<id>'.
-- "Never told twice" was a READ: the door and every re-drive attempt read who
-- already holds a row with that causal id, then created the rest. Two API
-- instances re-driving the same message inside the same ~100 ms (or a slow door
-- on one instance and the re-drive on another) both read "untold" and both
-- created: the member was woken twice. The file's own header said closing it
-- needs "a unique index on (user_id, metadata->>causal_event_id) ... a
-- migration".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX: the second insert fails
-- ══════════════════════════════════════════════════════════════════════════════
--   notifications_safety_once_per_member_uniq
--     UNIQUE (user_id, (metadata->>'causal_event_id'))
--     WHERE source_type = 'thread_safety_alert'
--       AND (metadata->>'causal_event_id') IS NOT NULL
--
-- SCOPE. Only the safety producer's rows (source_type 'thread_safety_alert',
-- SAFETY_NOTIFICATION_SOURCE in safetyNotifications.ts). Every other producer is
-- untouched: no other row can conflict, so no other insert can start failing.
-- One message carries ONE signal, so (member, message) is the identity; the
-- event type adds nothing.
--
-- THE LOSER. NotificationService.createDetailed answers the 23505 as
-- `insert_failed`. safetyNotifications.ts reads, for that member, a row carrying
-- the message's causal id; SEEN, the member is `already_told` (counted as told,
-- never re-driven, never a GAVE UP); not seen or unreadable, it stays
-- `not_created` exactly as before. That code half is safe with this index absent:
-- without it no conflict occurs, both rows land as they do today, and a real
-- insert failure reads no row and is re-driven as today.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3901 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends only on public.notifications, a baseline table
-- (baseline/20260819_baseline_structure.sql). No migration from 2093 onwards
-- names public.notifications at all, so nothing above 3901 alters, drops or
-- redefines it, and no index of this name exists anywhere in the chain.
--
-- EXISTING DATA is inspected, never changed. The $pre$ refuses while any
-- (member, causal id) group of safety rows holds more than one row, naming one.
-- The producer is unflagged but unmerged as this is written (wave-5 owner doc
-- §1), so a database with no such row builds the index trivially.
--
-- LOCK. A plain CREATE UNIQUE INDEX (the applier wraps each file and its ledger
-- row in one transaction, which the online variant cannot run in) holds a SHARE
-- lock on public.notifications while it scans the table: notification writes wait
-- for the build. The index itself covers only safety rows.
--
-- ROLLBACK (nothing depends on the index; the code half then behaves as today):
--   BEGIN;
--   DROP INDEX IF EXISTS public.notifications_safety_once_per_member_uniq;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3901_telegraph_safety_notification_once_per_member.sql';
--   COMMIT;

BEGIN;

DO $pre$
DECLARE
  v_dupes   bigint;
  v_example text;
  v_idx     regclass := to_regclass('public.notifications_safety_once_per_member_uniq');
BEGIN
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3901): public.notifications does not exist.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.notifications'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'user_id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'source_type' AND atttypid = 'text'::regtype)
           OR (attname = 'metadata' AND atttypid = 'jsonb'::regtype))) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3901): public.notifications must carry user_id uuid, source_type text and metadata jsonb.';
  END IF;

  -- The duplicate inspection. Read-only; a finding is a refusal, never a fix.
  SELECT count(*), min(format('member %s / %s (%s rows)', user_id, causal, n))
    INTO v_dupes, v_example
    FROM (SELECT user_id, metadata->>'causal_event_id' AS causal, count(*) AS n
            FROM public.notifications
           WHERE source_type = 'thread_safety_alert'
             AND (metadata->>'causal_event_id') IS NOT NULL
           GROUP BY user_id, metadata->>'causal_event_id'
          HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3901): % (member, help request) group(s) of safety notifications hold more than one row, e.g. %. Nothing was changed. Decide what each duplicate is before re-running; this migration will not delete or merge them.', v_dupes, v_example;
  END IF;

  -- An index of this name must already be exactly this one (a re-run), or absent.
  IF v_idx IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.notifications'::regclass
       AND i.indisunique
       AND i.indnkeyatts = 2
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'user_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = '(metadata ->> ''causal_event_id''::text)'
       AND pg_get_expr(i.indpred, i.indrelid, true) = 'source_type = ''thread_safety_alert''::text AND (metadata ->> ''causal_event_id''::text) IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3901): an index named notifications_safety_once_per_member_uniq exists but is not this one: %. Refusing to build on it.', pg_get_indexdef(v_idx);
  END IF;
END $pre$;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_safety_once_per_member_uniq
  ON public.notifications (user_id, (metadata->>'causal_event_id'))
  WHERE source_type = 'thread_safety_alert'
    AND (metadata->>'causal_event_id') IS NOT NULL;

COMMENT ON INDEX public.notifications_safety_once_per_member_uniq IS
  '3901 (census-telegraph T254): one safety notification per member per help request. The safety producer (source_type thread_safety_alert) writes metadata.causal_event_id = MESSAGE:<id>; two API instances telling the same member get one row, the second insert 23505, which services/telegraph/safetyNotifications.ts counts as already_told once it sees the winner''s row.';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from catalog and data ─────────
DO $post$
DECLARE
  v_idx   regclass := to_regclass('public.notifications_safety_once_per_member_uniq');
  v_dupes bigint;
BEGIN
  IF v_idx IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3901): notifications_safety_once_per_member_uniq does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.notifications'::regclass
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND i.indnkeyatts = 2
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'user_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = '(metadata ->> ''causal_event_id''::text)'
       AND pg_get_expr(i.indpred, i.indrelid, true) = 'source_type = ''thread_safety_alert''::text AND (metadata ->> ''causal_event_id''::text) IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3901): notifications_safety_once_per_member_uniq is not a valid UNIQUE (user_id, metadata->>causal_event_id) over safety rows: %', pg_get_indexdef(v_idx);
  END IF;
  SELECT count(*) INTO v_dupes
    FROM (SELECT 1 FROM public.notifications
           WHERE source_type = 'thread_safety_alert'
             AND (metadata->>'causal_event_id') IS NOT NULL
           GROUP BY user_id, metadata->>'causal_event_id'
          HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3901): % duplicate (member, help request) group(s) of safety notifications exist.', v_dupes;
  END IF;
  IF obj_description(v_idx, 'pg_class') IS NULL OR position('T254' IN obj_description(v_idx, 'pg_class')) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3901): the index comment does not name the safety producer.';
  END IF;
END $post$;
