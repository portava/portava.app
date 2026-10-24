-- 3934_telegraph_member_removed_at.sql
-- Telegraph §30A.4 membership records (census-telegraph T389): `removed_at`, and
-- `visible_until_sequence` WRITTEN. POST-CUTOVER CANONICAL FORWARD MIGRATION
-- (3000-3999 band; lane TELEGRAPH's census-drive band 3934-3949, 2026-10-23).
--
-- WRITTEN, NOT APPLIED. Additive: one nullable column, one CHECK, one trigger
-- function, one trigger. No row is written, backfilled or deleted; no policy,
-- grant or flag changes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §30A.4: "Membership records include joined_at, left_at, removed_at,
-- visible_from_sequence, visible_until_sequence". message_thread_members has
-- joined_at, left_at and role (baseline), visible_from_at (2400, the established
-- analogue of visible_from_sequence: Appendix A's "use existing repository
-- naming conventions"), and 2810 added visible_until_sequence — which nothing
-- writes. Two gaps, both closed here:
--
--   removed_at   A REMOVAL was indistinguishable from a DEPARTURE: the host's
--                remove (POST /threads/:id/moderation/:userId/remove) and a
--                person leaving both wrote left_at and nothing else. removed_at
--                records the conversation's own removal. NULL on every existing
--                row (nothing is inferred), and on every departure that was not
--                a removal. CHECK: a removal IS a departure (removed_at requires
--                left_at), so an active member can never carry one.
--   visible_until_sequence
--                set when a membership interval ENDS, to the conversation's
--                last_sequence at that instant — the last message the member's
--                interval could see, in §17.1's own coordinate. Only where the
--                sequence is in use (last_sequence > 0): a conversation that has
--                never been sequenced gets NULL, never a misleading 0.
--
-- A REJOIN (left_at set -> NULL) is a new interval (2400's rule): removed_at and
-- visible_until_sequence are cleared with it, exactly as 2400 moves
-- visible_from_at to now(). This table keeps one row per member per thread
-- (§7.3, T74), so the closed interval's bounds are not kept after a rejoin.
--
-- WHO WRITES removed_at. Only the conversation's own removal: a `group` owns its
-- roster. A trip's or circle's thread follows its source roster (3763's trigger,
-- the circle sync), and the cause of THAT departure lives in the source domain,
-- which is where it is recorded; this file does not guess it.
--
-- NO CLIENT CAN WRITE IT, and this file changes nothing about that. Measured
-- read-only on production 2026-10-23: message_thread_members has RLS enabled,
-- mtm_insert's WITH CHECK is `false`, and there is NO UPDATE or DELETE policy,
-- so `authenticated` and `anon` write no row of this table whatever their
-- table-level grants say (the new column inherits those grants; RLS is what
-- refuses). Only the service role — the API's removal route — writes it.
-- Members READ it exactly as they read left_at (mtm_select: own row, or an
-- active member of the thread). Pinned on a real database by
-- src/test/db/telegraphMemberRemovedAt.db.test.ts.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3934 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on public.message_thread_members (baseline), its left_at (baseline)
-- and visible_until_sequence (2810), and public.message_threads.last_sequence
-- (2810). No migration numbered above 3934 names message_thread_members, so
-- nothing later alters, drops or redefines what this file touches, and no
-- trigger or function of these names exists anywhere in the chain. The trigger
-- fires BEFORE UPDATE OF left_at only; 2400/2966's
-- telegraph_member_visibility_window (BEFORE INSERT OR UPDATE) writes a
-- different column, so their order does not matter.
--
-- ROLLBACK (nothing depends on these objects; the route then writes left_at alone):
--   BEGIN;
--   DROP TRIGGER IF EXISTS telegraph_member_interval_bounds ON public.message_thread_members;
--   DROP FUNCTION IF EXISTS public.telegraph_member_interval_bounds();
--   ALTER TABLE public.message_thread_members DROP CONSTRAINT IF EXISTS message_thread_members_removed_is_a_departure;
--   ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS removed_at;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3934_telegraph_member_removed_at.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3934): public.message_thread_members does not exist.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'left_at' AND atttypid = 'timestamptz'::regtype)
           OR (attname = 'visible_until_sequence' AND atttypid = 'int8'::regtype)
           OR (attname = 'thread_id' AND atttypid = 'uuid'::regtype))) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3934): message_thread_members must carry thread_id uuid, left_at timestamptz and visible_until_sequence bigint (2810).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.message_threads'::regclass AND attname = 'last_sequence'
                    AND atttypid = 'int8'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3934): public.message_threads.last_sequence (2810) does not exist.';
  END IF;
  -- A column of this name must already be exactly this one (a re-run), or absent.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.message_thread_members'::regclass AND attname = 'removed_at'
                AND NOT attisdropped AND atttypid <> 'timestamptz'::regtype) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3934): message_thread_members.removed_at exists with another type. Refusing to build on it.';
  END IF;
END $pre$;

ALTER TABLE public.message_thread_members
  ADD COLUMN IF NOT EXISTS removed_at timestamptz NULL;

COMMENT ON COLUMN public.message_thread_members.removed_at IS
  'Telegraph §30A.4 (census-telegraph T389, 3934): when the CONVERSATION removed this member (a group host''s remove). NULL for a member who left, for a departure synced from a trip or circle roster, and on every row older than 3934. A removal is a departure: requires left_at. Cleared on rejoin (a new interval).';

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.message_thread_members'::regclass
                    AND conname = 'message_thread_members_removed_is_a_departure') THEN
    ALTER TABLE public.message_thread_members
      ADD CONSTRAINT message_thread_members_removed_is_a_departure
      CHECK (removed_at IS NULL OR left_at IS NOT NULL);
  END IF;
END $chk$;

CREATE OR REPLACE FUNCTION public.telegraph_member_interval_bounds()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_last bigint;
BEGIN
  -- An interval ENDS: record the last message it could see, in §17.1's
  -- coordinate, where the conversation is sequenced. An explicit value is kept.
  IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
    IF NEW.visible_until_sequence IS NULL THEN
      SELECT last_sequence INTO v_last FROM public.message_threads WHERE id = NEW.thread_id;
      IF v_last IS NOT NULL AND v_last > 0 THEN
        NEW.visible_until_sequence := v_last;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- A REJOIN is a new interval (2400's rule): the closed one's bounds go with it.
  IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
    NEW.removed_at := NULL;
    NEW.visible_until_sequence := NULL;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_member_interval_bounds() IS
  'Telegraph §30A.4 (census-telegraph T389, 3934): when a membership interval ends, visible_until_sequence := the conversation''s last_sequence (only when > 0, never over an explicit value); on rejoin, removed_at and visible_until_sequence are cleared with the closed interval.';

DROP TRIGGER IF EXISTS telegraph_member_interval_bounds ON public.message_thread_members;
CREATE TRIGGER telegraph_member_interval_bounds
  BEFORE UPDATE OF left_at ON public.message_thread_members
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_member_interval_bounds();

-- RETURNS trigger cannot be called over PostgREST, but EXECUTE defaults to PUBLIC
-- on creation; nothing but the trigger needs it.
REVOKE ALL ON FUNCTION public.telegraph_member_interval_bounds() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions (recomputed from the catalog; nothing carried from the body) ──
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.message_thread_members'::regclass AND attname = 'removed_at'
                    AND atttypid = 'timestamptz'::regtype AND NOT attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934): message_thread_members.removed_at is not a nullable timestamptz.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.message_thread_members'::regclass
                    AND conname = 'message_thread_members_removed_is_a_departure'
                    AND contype = 'c' AND convalidated
                    AND pg_get_constraintdef(oid) = 'CHECK (((removed_at IS NULL) OR (left_at IS NOT NULL)))') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934): the removed-is-a-departure CHECK is missing, unvalidated or not this one.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.message_thread_members'::regclass
                    AND tgname = 'telegraph_member_interval_bounds' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934): trigger telegraph_member_interval_bounds is missing or disabled.';
  END IF;
  IF has_function_privilege('anon', 'public.telegraph_member_interval_bounds()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.telegraph_member_interval_bounds()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934): a client role can execute telegraph_member_interval_bounds().';
  END IF;
END $post$;
