-- Rollback for 2325_telegraph_unsend_before_seen.sql
-- Telegraph §7.4 — the server-authoritative, race-safe unsend-before-seen half.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS. READ IT BEFORE RUNNING IT.
-- ══════════════════════════════════════════════════════════════════════════════
-- ⚠ IT DESTROYS THE RECORD OF WHICH SUPPRESSED MESSAGES WERE UNSENT RATHER THAN
-- DELETED, AND THAT IS NOT A SIDE EFFECT. 2325's whole point, stated in its own
-- header, is that unsend and delete must stay distinguishable on the record
-- (§13.1). The only thing in this tree that carries the distinction, once 2810
-- is also reversed, is `public.messages.unsent_at` — and this file drops that
-- column.
--
-- Concretely, after this runs:
--
--   * Every row that was ever unsent keeps `deleted_at` and keeps `body = ''`,
--     so it stays suppressed in every reader. Nothing becomes visible.
--   * Every one of those rows becomes INDISTINGUISHABLE from an ordinary
--     delete. "Was this retracted before anyone saw it, or deleted after?" has
--     no answer in the database any more, for any row, ever. There is no second
--     copy: `lifecycle_state` is 2810's column and 2810's rollback drops it one
--     step earlier in the chain (see ORDER below), and the outbox rows that
--     carried `message.unsent` went with `public.telegraph_outbox` in that same
--     step. This is UNRECOVERABLE by any rollback, including this one.
--   * `public.telegraph_unsend_message_before_seen` ceases to exist, and with
--     it the only implementation in this tree that closes §7.4's read-vs-unsend
--     race under a lock. §28's "unsend-after-seen violations: 0" is no longer
--     enforceable anywhere: both route-level unsend paths do a read-then-write
--     across two implicit transactions, which is the defect 2325 was written to
--     fix. Roll the APPLICATION back too, or unsend goes back to being racy.
--   * The emptied `body` is not recoverable and never was. 2325 sets
--     `body = ''` and retains no original. That is unsend working as designed,
--     not damage this file should try to reverse.
--
-- The row count about to lose its marker is COUNTED and reported by the
-- precondition block below before anything is dropped, so the cost is a number
-- on the console rather than a paragraph nobody read.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER. THIS FILE RUNS LAST, AND IT REFUSES IF IT DOES NOT.
-- ══════════════════════════════════════════════════════════════════════════════
-- The apply order of the Telegraph three is:
--
--     2325_telegraph_unsend_before_seen.sql      (1_apply_2325.sql)
--     2810_telegraph_message_kernel.sql          (2_apply_2810.sql)
--     3000_telegraph_unsend_authoritative.sql    (3_apply_3000.sql)
--
-- so the reversal runs backwards through it:
--
--     db/rollback/2026-09-23-3000-telegraph-unsend-authoritative-rollback.sql
--     db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql
--     DELETE FROM public.schema_migration_ledger
--      WHERE filename = '2810_telegraph_message_kernel.sql';     ← see below
--     THIS FILE
--
-- THAT MIDDLE STATEMENT IS NOT OPTIONAL AND IS NOT A TYPO. 2810's rollback
-- predates the 2026-09-28 standard that every rollback deletes its own ledger
-- row, and it is the one file in this chain that still does not. Measured on
-- the local harness on 2026-10-03: it removes every 2810 object and the flag
-- row, and leaves its ledger row. This file REFUSES on that leftover rather
-- than reversing on top of a ledger that claims a kernel the database no
-- longer has, and its refusal prints the statement above. The durable fix is
-- to add the DELETE to 2810's rollback; until someone does, it is a manual
-- step in the chain.
--
-- WHY 3000 MUST GO FIRST. 3000 does not create the unsend function; it CREATE
-- OR REPLACEs 2325's body. So on a database carrying 3000, the function named
-- `telegraph_unsend_message_before_seen` is 3000's text, not 2325's. A plain
-- `DROP FUNCTION` here would therefore reverse 3000 as well — silently, and
-- while 3000's ledger row still said it was applied, leaving a ledger that
-- claims a function exists which does not. This file refuses instead, and it
-- establishes the answer two independent ways (the installed body's text and
-- the ledger row) rather than trusting either alone.
--
-- WHY 2810 MUST GO SECOND, BEFORE THIS FILE. 2810 re-declares
-- `messages.unsent_at` itself — `ADD COLUMN IF NOT EXISTS`, a silent no-op on a
-- database that already ran 2325 — and 2810's outbox trigger READS it:
-- `IF NEW.unsent_at IS NOT NULL AND OLD.unsent_at IS NULL` is how
-- `public.telegraph_outbox_from_message()` decides to publish `message.unsent`.
-- Dropping the column underneath that trigger leaves a trigger function that
-- cannot run. It would not fail loudly either, which is what makes it worth
-- refusing over: the trigger reads `telegraph_message_kernel_enabled` first and
-- RETURNs NULL while it is FALSE, so the breakage is invisible until the day an
-- owner turns the flag on — at which point every lifecycle UPDATE on
-- public.messages, the hottest table in the product, starts erroring.
--
-- A NOTE ON WHAT 2810's ROLLBACK LEAVES BEHIND, SO IT IS NOT A SURPRISE.
-- `db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql` drops
-- `messages.unsent_at` itself, unconditionally. That is correct for the full
-- reverse chain — by the time this file runs, the column is already gone and
-- the `ALTER TABLE … DROP COLUMN IF EXISTS` below is a verified no-op. But it
-- means a PARTIAL reversal that stops after 2810 is a broken state, not a
-- resting one: 2325's function still exists and still writes `unsent_at`, and
-- the column is gone, so the first unsend after that point raises. If you have
-- run 2810's rollback, run this file. Do not stop in between.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES NOT TOUCH
-- ══════════════════════════════════════════════════════════════════════════════
-- `messages.deleted_at` (pre-2325, every reader's suppression predicate) and
-- `message_thread_members.last_read_at` (migration 0016, the seen substrate
-- 2325 read but did not create) are NOT dropped. 2325 created neither.
--
-- Idempotent: a second run is a clean no-op. Every drop is guarded, the
-- preconditions pass on an already-reversed database, and the postconditions
-- assert the end state rather than trusting the statements above them.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REHEARSED, NOT REASONED — 2026-10-03, scripts/local-db (the canonical chain
-- replayed from 2093 onto production's baseline structure: 390 migrations in
-- byte order, so 2325, 2810 and 3000 are all genuinely installed), each
-- scenario on its own database cloned from that template:
-- ══════════════════════════════════════════════════════════════════════════════
--   A  this file run FIRST, 3000 and 2810 both applied
--      → REFUSED on 3000's installed body. Correct.
--   B  after 3000's rollback only
--      → REFUSED naming all six surviving 2810 objects in one message. Correct.
--   C  3000 → 2810 → this file
--      → REFUSED on 2810's leftover ledger row, printing the DELETE; after that
--        DELETE, PASSED. End state: 0 functions by that name, no unsent_at, no
--        index, deleted_at and last_read_at intact, 0 of the three ledger rows
--        left, telegraph_outbox gone.
--   C2 this file run a SECOND time → PASSED, `DELETE 0`, no-op. Correct.
--   D  a 2325-ONLY database (2810 and 3000 never applied) → PASSED, and this is
--      the path on which the column drop is the one that actually destroys data.
--   E  ledger says 3000 applied but the function is already gone
--      → REFUSED. A state this file must not build on.
--   F  public.schema_migration_ledger absent
--      → REFUSED, because two of its checks could not then establish their own
--        result. Fails closed, per the standing convention.
--   G  a 2325-only database carrying three real rows — one unsent, one ordinary
--      delete, one live. The notice counted the 1 unsent row BEFORE the drop.
--      Afterwards: 3 rows still present, 2 still suppressed, 1 still live, and
--      the unsent/delete distinction gone. Exactly what the header promises,
--      measured rather than argued.
--
-- WHAT THE REHEARSAL DOES NOT ESTABLISH: it is not production. The local
-- harness carries production's baseline STRUCTURE and no production rows, 12
-- files in the chain are known-unreplayable there, and the ledger rows were
-- seeded by hand because the harness applies with psql rather than through the
-- applier. The refusals and the end state are measured; production's row counts
-- are not.
--
-- Run it only to reverse 2325 deliberately, never as routine cleanup.

BEGIN;

SET LOCAL search_path = public, pg_catalog;

-- ── Preconditions: refuse loudly, never guess ─────────────────────────────────
DO $pre$
DECLARE
  v_have_col     boolean;
  v_n_overloads  integer;
  v_args         text;
  v_src          text;
  v_blockers     text[] := ARRAY[]::text[];
  n_unsent       bigint;
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION
      '2325 rollback PRECONDITION FAILED: public.messages does not exist. This file cannot establish what it is reversing.';
  END IF;

  -- The ledger is the second of the two independent order signals AND the table
  -- this file must delete from at the end. If it is absent, one of the two
  -- checks below cannot establish its own result, so this refuses rather than
  -- proceeding on the surviving half. (Standing convention: a check that cannot
  -- establish its result fails.)
  IF to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION
      '2325 rollback PRECONDITION FAILED: public.schema_migration_ledger does not exist, so neither the 3000 nor the 2810 order check can be established from it, and this file could not remove its own ledger row. Refusing rather than reversing on half the evidence.';
  END IF;

  -- ── Order check 1 of 2: 3000 must already be reversed ──────────────────────
  SELECT count(*) INTO v_n_overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen';

  IF v_n_overloads > 1 THEN
    RAISE EXCEPTION
      '2325 rollback PRECONDITION FAILED: % overloads of public.telegraph_unsend_message_before_seen exist. 2325 created exactly one, (uuid, uuid, uuid). Refusing to guess which to drop.',
      v_n_overloads;
  END IF;

  IF v_n_overloads = 1 THEN
    -- The argument TYPES, not pg_get_function_identity_arguments(), which
    -- renders declared parameter NAMES too ("p_message_id uuid, …") and would
    -- make this refuse on the very function it is meant to accept. Caught by
    -- rehearsing against a replayed chain rather than by reading the docs.
    SELECT (SELECT string_agg(format_type(t, NULL), ', ' ORDER BY ord)
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)),
           p.prosrc
      INTO v_args, v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen';

    IF v_args IS DISTINCT FROM 'uuid, uuid, uuid' THEN
      RAISE EXCEPTION
        '2325 rollback PRECONDITION FAILED: public.telegraph_unsend_message_before_seen has signature (%), not (uuid, uuid, uuid). That is not the function 2325 created. Refusing to guess.',
        v_args;
    END IF;

    -- A body this file cannot read is a body it cannot classify as 2325's or
    -- 3000's. Fail, do not assume.
    IF v_src IS NULL OR length(v_src) = 0 THEN
      RAISE EXCEPTION
        '2325 rollback PRECONDITION FAILED: the installed telegraph_unsend_message_before_seen has no readable prosrc, so this file cannot establish whether it is 2325''s body or 3000''s replacement. Refusing.';
    END IF;

    -- 3000's three distinguishing marks. Any one of them means 3000's body is
    -- what is installed, and dropping it here would reverse 3000 by accident.
    IF v_src LIKE '%already_unsent%' OR v_src LIKE '%already_deleted%'
       OR v_src LIKE '%recipientCount%' OR v_src LIKE '%lifecycle_state%' THEN
      RAISE EXCEPTION
        '2325 rollback REFUSING: the installed telegraph_unsend_message_before_seen carries 3000''s body (its already_unsent / already_deleted / recipientCount / lifecycle_state vocabulary is present). Dropping it here would reverse 3000 silently and leave 3000''s ledger row claiming an applied migration whose function is gone. Run db/rollback/2026-09-23-3000-telegraph-unsend-authoritative-rollback.sql first.';
    END IF;

    -- And the positive half: it must look like 2325's body, not some third
    -- thing nobody in this chain wrote.
    IF v_src NOT LIKE '%already_gone%' THEN
      RAISE EXCEPTION
        '2325 rollback PRECONDITION FAILED: the installed telegraph_unsend_message_before_seen is neither 3000''s body nor 2325''s — it does not carry 2325''s already_gone outcome. Refusing to drop a function this chain does not recognise.';
    END IF;
  END IF;

  -- The ledger's independent say on the same question. It is checked even when
  -- the function is already gone, because a ledger row for 3000 with no
  -- function is itself a state this file must not build on.
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3000_telegraph_unsend_authoritative.sql') THEN
    RAISE EXCEPTION
      '2325 rollback REFUSING: public.schema_migration_ledger still records 3000_telegraph_unsend_authoritative.sql as applied. 3000 replaces the body of the function this file drops, so it must be reversed first. Run db/rollback/2026-09-23-3000-telegraph-unsend-authoritative-rollback.sql.';
  END IF;

  -- ── Order check 2 of 2: 2810 must already be reversed ──────────────────────
  -- Every surviving 2810 object is collected and named, so the operator sees
  -- the whole list in one refusal instead of discovering it one run at a time.
  IF to_regclass('public.telegraph_outbox') IS NOT NULL THEN
    v_blockers := array_append(v_blockers, 'table public.telegraph_outbox');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.messages'::regclass
                AND tgname = 'telegraph_assign_message_sequence' AND NOT tgisinternal) THEN
    v_blockers := array_append(v_blockers, 'trigger telegraph_assign_message_sequence on public.messages');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.messages'::regclass
                AND tgname = 'telegraph_outbox_from_message' AND NOT tgisinternal) THEN
    v_blockers := array_append(v_blockers, 'trigger telegraph_outbox_from_message on public.messages (it reads NEW.unsent_at)');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('telegraph_outbox_from_message',
                                  'telegraph_assign_message_sequence',
                                  'telegraph_backfill_message_sequences')) THEN
    v_blockers := array_append(v_blockers, 'one or more of 2810''s trigger/backfill functions');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'messages'
                AND column_name IN ('sequence', 'lifecycle_state')) THEN
    v_blockers := array_append(v_blockers, 'messages.sequence and/or messages.lifecycle_state');
  END IF;
  -- public.feature_flags is 2810's own precondition, so its absence is a
  -- definite answer (2810 cannot be applied without it), not an unknown one.
  IF to_regclass('public.feature_flags') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.feature_flags
                  WHERE flag = 'telegraph_message_kernel_enabled') THEN
    v_blockers := array_append(v_blockers, 'feature flag row telegraph_message_kernel_enabled');
  END IF;
  IF array_length(v_blockers, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '2325 rollback REFUSING: migration 2810 is still applied — found %. 2810 re-declares messages.unsent_at and its outbox trigger reads it, so dropping the column here would leave telegraph_outbox_from_message() unable to run, invisibly, until telegraph_message_kernel_enabled is next turned on. Run db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql first.',
      array_to_string(v_blockers, '; ');
  END IF;

  -- The ledger's say on 2810, kept SEPARATE from the object evidence above
  -- because it fails for a different reason and has a different remedy.
  --
  -- MEASURED, NOT ASSUMED (local harness, 2026-10-03): running
  -- db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql to
  -- completion removes every 2810 object and the flag row, and leaves its own
  -- ledger row in place. That file predates the 2026-09-28 standard that every
  -- rollback deletes its own ledger row, and it is the one file in this chain
  -- that does not. So after a correct reversal of 2810 the objects are gone and
  -- the ledger still says 2810 is applied.
  --
  -- That is not an ordering violation, so it does not share the refusal above.
  -- It is worse in a quieter way: the applier reads that row and would SKIP
  -- 2810 on the next apply, leaving a database whose ledger claims a kernel it
  -- does not have, and 3000 would then fail its own preconditions. This file
  -- will not build on it, and it will not paper over it either — a rollback
  -- that silently succeeded here would hand the operator exactly the ledger
  -- that caused the 2026-09-21 confusion recorded in docs/migrations.md.
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '2810_telegraph_message_kernel.sql') THEN
    RAISE EXCEPTION
      '2325 rollback REFUSING: every 2810 OBJECT is gone, but public.schema_migration_ledger still carries a row for 2810_telegraph_message_kernel.sql. db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql predates the 2026-09-28 standard and does not delete its own ledger row, so a correct 2810 reversal leaves this behind. Remove it, then re-run this file:  DELETE FROM public.schema_migration_ledger WHERE filename = ''2810_telegraph_message_kernel.sql'';';
  END IF;

  -- ── Name the cost, as a number, before anything is dropped ─────────────────
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'unsent_at'
  ) INTO v_have_col;

  IF NOT v_have_col THEN
    -- Either 2810's rollback already dropped it one step earlier (the normal
    -- path through the full chain), or this file has already run.
    RAISE NOTICE '2325 rollback: messages.unsent_at is already absent — dropped by 2810''s rollback earlier in the chain, or by a previous run of this file. The column drop below is a no-op.';
  ELSE
    EXECUTE 'SELECT count(*) FROM public.messages WHERE unsent_at IS NOT NULL'
       INTO n_unsent;
    RAISE NOTICE '2325 rollback: % message(s) carry unsent_at and are about to lose it permanently. They keep deleted_at and stay suppressed; what is destroyed is the record that they were UNSENT rather than deleted. This is the cost of the reversal and it is unrecoverable.', n_unsent;
  END IF;
END
$pre$;

-- ── The reversal, in dependency order ─────────────────────────────────────────
-- Function first (it reads and writes the column), then the index on the
-- column, then the column.
DROP FUNCTION IF EXISTS public.telegraph_unsend_message_before_seen(uuid, uuid, uuid);
DROP INDEX    IF EXISTS public.messages_unsent_at_idx;
ALTER TABLE   public.messages DROP COLUMN IF EXISTS unsent_at;

-- ── Postconditions: read the catalog, do not infer from the statements above ──
DO $post$
DECLARE
  n_fn   integer;
  v_col  boolean;
  v_idx  boolean;
BEGIN
  -- By NAME, not by signature: a drop that missed an overload must go red here
  -- rather than be reported as a success by the statement that did not run.
  SELECT count(*) INTO n_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen';
  IF n_fn <> 0 THEN
    RAISE EXCEPTION
      '2325 rollback postcondition 1 FAILED: % function(s) named public.telegraph_unsend_message_before_seen still exist.', n_fn;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'unsent_at'
  ) INTO v_col;
  IF v_col THEN
    RAISE EXCEPTION '2325 rollback postcondition 2 FAILED: public.messages.unsent_at still exists.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'messages_unsent_at_idx'
  ) INTO v_idx;
  IF v_idx THEN
    RAISE EXCEPTION '2325 rollback postcondition 3 FAILED: messages_unsent_at_idx still exists.';
  END IF;

  -- 2325 did not create these and this file must not have removed them.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION
      '2325 rollback postcondition 4 FAILED: public.messages.deleted_at is gone. It predates 2325, it is every reader''s suppression predicate, and nothing in this file touches it.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'message_thread_members'
       AND column_name = 'last_read_at'
  ) THEN
    RAISE EXCEPTION
      '2325 rollback postcondition 5 FAILED: message_thread_members.last_read_at is gone. It is migration 0016''s column; 2325 read it and never owned it.';
  END IF;

  RAISE NOTICE '2325 rollback postconditions PASSED: the function, the index and messages.unsent_at are gone, and deleted_at / last_read_at are untouched.';
END
$post$;

-- The applier wrote 2325's ledger row in 2325's own transaction; without this
-- delete the ledger would take 2325 as still applied and never re-apply it.
-- The repository's standard since 2026-09-28: every rollback removes its own
-- ledger row (docs/migrations.md).
DELETE FROM public.schema_migration_ledger
 WHERE filename = '2325_telegraph_unsend_before_seen.sql';

DO $ledger$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2325_telegraph_unsend_before_seen.sql') THEN
    RAISE EXCEPTION '2325 rollback POSTCONDITION FAILED: the ledger still records 2325 as applied after the reversal.';
  END IF;
END
$ledger$;

COMMIT;
