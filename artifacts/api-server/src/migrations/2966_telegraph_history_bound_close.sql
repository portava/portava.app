-- 2966_telegraph_history_bound_close.sql
-- Telegraph §14.3 "Group history bounds" — the two things 2400 left open, so
-- that turning telegraph_history_bound_enabled ON actually closes the leak.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- APPLIES AFTER 2400_telegraph_history_bound.sql. It refuses to run without it.
--
-- Spec (identical in v1 and v1_1; v1_1 is a byte-exact superset of v1):
--   §14.1  ConversationCapabilities.canViewPreMembershipHistory — a grant of
--          pre-membership history is a CAPABILITY, i.e. a deliberate decision.
--   §14.3  "New members do not automatically receive pre-membership history."
--   §26    "New member reads pre-membership history without policy → DENY";
--          "Removed member reads future sequence → DENY".
--   §30A.4 membership records carry joined_at, left_at, removed_at,
--          visible_from_sequence, visible_until_sequence and role.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS: 2400 ALONE CLOSES NOTHING ON THE LIVE DATABASE
-- ══════════════════════════════════════════════════════════════════════════════
-- Measured on production (ajrurzioarfkagpuxfnb) 2026-09-22, aggregate only:
--
--   message_thread_members rows                                 18
--   rows that would carry visible_from_at after 2400             0  (2400
--                                                                   backfills
--                                                                   nothing)
--   active (member, message) pairs where the message predates
--     the member's membership, by message_thread_members.joined_at        3
--     AND independently by trip_members evidence                         3
--   distinct members leaking                                             1
--
-- Every one of the 18 rows predates 2400, so every one of them keeps
-- visible_from_at = NULL, and NULL is UNBOUNDED by design (2400's header, and
-- services/groupChatHistoryBound.ts visibleFromOf). Applying 2400 and then
-- enabling telegraph_history_bound_enabled therefore closes ZERO of the 3
-- measured leaking pairs. The read-side gate is correct and inert; the missing
-- piece is the DATA it reads.
--
-- 2400's header names the backfill as an OWNER DECISION it declines to make,
-- and gives the right reason: a backfill from message_thread_members.joined_at
-- is REFUSED because that column is rewritten. That is verified, not inherited:
-- services/groupChatSync.ts builds `upsertRows` with `joined_at: now` for EVERY
-- accepted member and upserts with `ignoreDuplicates: false`, so any trip or
-- circle acceptance restamps joined_at for every existing member of that
-- thread. A bound keyed on it would hide a long-standing member's own history.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY NOT `SET visible_from_at = joined_at WHERE joined_at IS NOT NULL`
-- ══════════════════════════════════════════════════════════════════════════════
-- That is the obvious one-line backfill and it is tempting for a measured
-- reason: production has 18 membership rows and ZERO with joined_at IS NULL, so
-- it appears to invent no timestamp for any row. "Not NULL" is not the same
-- claim as "correct", and the difference is measurable on the live rows:
--
--   trip membership rows where message_thread_members.joined_at is LATER
--     than the same member's trip_members.created_at              3 of 6
--   largest such drift                          2 days 05:57:55
--   (production, 2026-09-22; the drift IS the sync restamp, visible in the data)
--
-- So for at least one live member, joined_at is two days later than the
-- membership this database itself recorded. A joined_at backfill would open
-- that member's window two days after their entitlement began. It happens to
-- hide nothing TODAY — measured: 0 (member, own message) pairs would be hidden
-- — only because none of those three members posted inside their drift window.
-- That is luck. The next sync restamps another row, and the next member posts
-- inside the gap, and then the backfill has silently deleted history from
-- somebody's screen with no way to tell that it did.
--
-- This file therefore takes joined_at as ONE CANDIDATE inside LEAST() rather
-- than as THE source. Where it is the earliest evidence it is used; where the
-- sync has pushed it forward, an earlier, never-rewritten stamp wins. That
-- keeps the property the one-liner only appears to have: no timestamp is
-- invented, AND no member's window opens later than the evidence supports.
-- Postcondition 3 checks the result rather than trusting the argument.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE WINDOW CANNOT BE RE-OPENED BY AN UPDATE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2400's trigger defends the INSERT and the rejoin. It does not defend the
-- ordinary UPDATE, and the gap was MEASURED on the CI project
-- (hwokxgbmezheskbzskfr) inside a rolled-back transaction on 2026-09-22:
--
--   UPDATE message_thread_members SET visible_from_at = NULL WHERE ...
--   → visible_from_at IS NULL   (the member is unbounded again)
--
-- No route writes the column today, so this is not a live leak — it is a
-- guarantee resting on "no writer currently sends that column", which is not a
-- guarantee. 2400's own reason for putting the rule in the database was that
-- there are two disagreeing sync writers and two DM creation paths and none of
-- them should be able to reset the window by accident. An UPDATE that clears it
-- to NULL is exactly that accident, and it is the one direction that can only
-- ever WIDEN access.
--
-- THE RULE: on UPDATE, a window that exists cannot become unbounded.
--   OLD.visible_from_at IS NOT NULL AND NEW.visible_from_at IS NULL
--     → NEW.visible_from_at := OLD.visible_from_at
--
-- §14.1's canViewPreMembershipHistory grant SURVIVES, in a better form: a grant
-- is expressed by writing an EARLIER TIMESTAMP, which the trigger still accepts
-- unchanged and which is auditable (you can see when the window was moved and
-- to when). A NULL records nothing. NULL keeps exactly one meaning from here
-- on: "this row predates 2400 and no evidence bounded it" — a state this file's
-- Part 2 reduces and never creates.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PART 2 — THE BACKFILL, FROM EVIDENCE ONLY, NEVER FROM A GUESS
-- ══════════════════════════════════════════════════════════════════════════════
-- A backfill of a privacy bound can only ever REMOVE messages from somebody's
-- screen, so the rule is: use evidence that a writer in this codebase cannot
-- rewrite, take the EARLIEST such evidence (the most permissive defensible
-- bound), and where there is no such evidence write NOTHING.
--
-- THE EVIDENCE, and why each source is trustworthy:
--
--   trip_members.created_at      SET ONCE at the invite INSERT
--                                (routes/trips.ts:1246 inserts role 'invited'
--                                and never sends created_at) and never updated
--                                by any writer in the tree: every other
--                                trip_members write is `.update({ role })`
--                                (routes/trips.ts:1374, :2275,
--                                routes/requests.ts:655,
--                                services/appeals/resolveAppeal.ts:395).
--   trip_members.joined_at       the acceptance stamp. RE-WRITABLE by the
--                                invite-link/request upsert
--                                (routes/trips-expansion.ts:1115 upserts with
--                                `joined_at: now`), so it is used only as ONE
--                                candidate inside LEAST(), where a later value
--                                can never win and therefore can never narrow
--                                anyone's window.
--   circle_memberships.created_at the circle membership stamp.
--   message_thread_members.joined_at  UNRELIABLE UPWARDS ONLY: the sync
--                                restamps it to now(), which makes it LATER.
--                                Inside LEAST() a later value loses, so
--                                including it can only ever make the bound
--                                EARLIER — i.e. more permissive. It is never
--                                the sole source: a row with no external
--                                evidence is left NULL.
--   MIN(messages.created_at) of the member's OWN messages in that thread
--                                SELF-EVIDENCE, and the strongest kind: a
--                                person who posted at T was demonstrably in the
--                                room at T, whatever any membership table says.
--                                It is a CLAMP, not a source — it can only pull
--                                the bound earlier.
--
--   visible_from_at := LEAST(trip_members.created_at,
--                            trip_members.joined_at,
--                            circle_memberships.created_at,
--                            message_thread_members.joined_at,
--                            MIN(own messages.created_at))
--   applied ONLY to rows where visible_from_at IS NULL
--     AND at least one EXTERNAL (trip_members / circle_memberships) row exists.
--
-- WHAT THIS DOES ON PRODUCTION, measured before writing it (2026-09-22):
--   rows backfilled                                           6  (all trip)
--   leaking (member, message) pairs closed                    3  (all of them)
--   a member's OWN messages pushed outside their window       0
--   rows left NULL because no external evidence exists       12
--
-- THE 12 ROWS LEFT NULL, and why that is the honest answer rather than a
-- fabricated timestamp:
--   11 are the two sides of 6 `direct` threads. Every direct thread in
--      production has at most 2 members (measured), so there is no third party
--      in any DM to leak to: §14.3's own sentence is "adding a third person to
--      a DM creates a new group; it does not expose the old DM history", and
--      there is no such third person. DM participants are founding members by
--      construction and there is nothing to bound them against.
--    1 is a `circle` thread's own OWNER, who has no circle_memberships row
--      because the owner is not a member of their own circle. The owner is the
--      founding member of their circle thread.
--   Neither group has a timestamp available that says anything narrower, and
--   inventing one would hide history from people entitled to it. If a
--   group-add into a direct thread is ever measured, the supported remedy is a
--   further evidence-based migration for those rows — NOT a now() sweep.
--
-- POSTCONDITION 3 BELOW IS THE DATA-INTEGRITY GATE: if any member ends up with
-- a window that starts AFTER a message they themselves sent, this migration
-- ABORTS. That is the shape a retroactive-hiding regression would take, and it
-- is checked rather than trusted.
--
-- The read stays GATED. This file writes data and hardens a trigger; it does
-- not touch telegraph_history_bound_enabled, which 2400 seeded FALSE. Nothing
-- any member sees changes until that flag is turned on through
-- toggle_feature_flag_with_audit. The apply is the safe half; the flip is the
-- reviewed half, and they are two steps.
--
-- ROW-LEVEL SECURITY IS NOT A SECOND LAYER FOR THIS RULE, and that is worth
-- saying because it means the application layer is the only one. Production
-- (2026-09-22) has RLS enabled with:
--   messages.msg_select                  authz.is_active_thread_member(thread_id)
--   messages.messages_hide_blocked_sender  RESTRICTIVE, NOT authz.is_blocked(...)
--   message_thread_members.mtm_select    auth.uid() = user_id
--                                        OR authz.is_active_thread_member(thread_id)
--   message_threads.mt_select            authz.is_active_thread_member(id)
-- `authz.is_active_thread_member` filters on left_at IS NULL and takes no user
-- parameter (it reads auth.uid() internally so it cannot serve as a membership
-- oracle). That is MEMBERSHIP, and nothing about WHEN: it already denies a
-- DEPARTED member, which is the §30A.4 visible_until half, and says nothing
-- about which messages an ACTIVE member may read — precisely the hole 2400
-- exists to close. A working membership predicate is not partial coverage of
-- the bound; the two are orthogonal. No policy could express the window anyway,
-- because visible_from_at does not exist in production yet, and the readers
-- that matter run on the service client, which is BYPASSRLS regardless.
--
-- These effects are the shape migrations 2401 and 2402 describe: every effect
-- of both files was OBSERVED PRESENT on production 2026-09-22, and NEITHER
-- file has ledger evidence of execution (public.schema_migration_ledger and
-- supabase_migrations.schema_migrations both return 0 for 2401 and 2402). Per
-- the standing rule, observed effects are not evidence that a migration ran, so
-- neither is called applied here. Nothing in this file or in the read-side gate
-- depends on which policy shape is installed.
--
-- ROLLBACK: db/rollback/2026-09-22-2966-telegraph-history-bound-close-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'message_thread_members'
       AND column_name = 'visible_from_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members.visible_from_at is absent — apply 2400_telegraph_history_bound.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'telegraph_member_visibility_window'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: function public.telegraph_member_visibility_window() is absent — apply 2400 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_history_bound_enabled'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature flag telegraph_history_bound_enabled is absent — apply 2400 first.';
  END IF;

  -- This file writes a bound derived from these three tables. If one of them is
  -- missing the derivation is not merely incomplete, it is wrong: the LEAST()
  -- would silently fall back to whatever is left.
  IF to_regclass('public.trip_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_members must exist (it is the evidence for trip threads).';
  END IF;
  IF to_regclass('public.circle_memberships') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.circle_memberships must exist (it is the evidence for circle threads).';
  END IF;
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist (it is the self-evidence clamp).';
  END IF;

  -- The clamp and the evidence are only comparable if these columns exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trip_members' AND column_name='created_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_members.created_at must exist — it is the only never-rewritten trip membership stamp.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='circle_memberships' AND column_name='created_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: circle_memberships.created_at must exist.';
  END IF;
END $$;

-- ── Part 1: the window cannot be re-opened to unbounded by an UPDATE ─────────

CREATE OR REPLACE FUNCTION public.telegraph_member_visibility_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Unchanged from 2400. A writer that supplies a value (a §14.1
    -- canViewPreMembershipHistory grant) keeps it; otherwise the window opens
    -- where the membership does. message_thread_members.joined_at is NOT NULL
    -- in this schema (verified on CI 2026-09-22), so the third arm is a
    -- belt-and-braces default that cannot normally be reached — and the result
    -- is therefore NEVER NULL on INSERT. That is what makes "NULL" mean exactly
    -- one thing for readers: a row that predates migration 2400.
    NEW.visible_from_at := COALESCE(NEW.visible_from_at, NEW.joined_at, now());
    RETURN NEW;
  END IF;

  -- UPDATE. A rejoin (left_at NOT NULL -> NULL) is a new membership interval,
  -- so the member does not regain the messages sent while they were out.
  -- §26: "Removed member reads future sequence → DENY" — from the removed
  -- interval's point of view the gap IS the future sequence it was denied, and
  -- §14.3 makes the new interval a new membership with its own window.
  -- Unchanged from 2400.
  IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
    IF NEW.visible_from_at IS NOT DISTINCT FROM OLD.visible_from_at THEN
      NEW.visible_from_at := now();
    END IF;
  END IF;

  -- NEW IN 2966. A window that EXISTS cannot become unbounded through an
  -- UPDATE. The only direction this blocks is the one that widens access, and
  -- it was reachable: on CI, `SET visible_from_at = NULL` cleared a live bound.
  -- No route sends the column today; this stops the day one starts.
  --
  -- A deliberate grant is still expressible, and better: write an EARLIER
  -- TIMESTAMP. That is accepted here untouched and it is auditable, where a
  -- NULL records nothing at all.
  IF OLD.visible_from_at IS NOT NULL AND NEW.visible_from_at IS NULL THEN
    NEW.visible_from_at := OLD.visible_from_at;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_member_visibility_window() IS
  'Telegraph §14.3/§26: opens a member''s visibility window at the membership start (INSERT), opens a NEW one on rejoin (left_at NOT NULL -> NULL), and (2966) refuses to let an UPDATE clear an existing window back to NULL — the one direction that only ever widens access. Writer-independent so no sync path can reset it by accident. A §14.1 canViewPreMembershipHistory grant is written as an earlier timestamp, not as NULL. Nothing reads the column unless telegraph_history_bound_enabled is TRUE.';

-- The trigger itself is recreated so this file is complete on a database where
-- 2400 ran but the trigger was later dropped by hand.
DROP TRIGGER IF EXISTS telegraph_member_visibility_window ON public.message_thread_members;
CREATE TRIGGER telegraph_member_visibility_window
  BEFORE INSERT OR UPDATE ON public.message_thread_members
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_member_visibility_window();

-- ── Part 2: the evidence-only backfill ───────────────────────────────────────

WITH own_first AS (
  -- SELF-EVIDENCE: the earliest message each member sent in each thread. A
  -- person who posted at T was in the room at T.
  SELECT thread_id, sender_id, min(created_at) AS first_own
    FROM public.messages
   GROUP BY thread_id, sender_id
), evidence AS (
  SELECT
    m.thread_id,
    m.user_id,
    -- The EXTERNAL, sync-independent membership stamps. At least one must exist
    -- or the row is not backfilled at all.
    tm.created_at   AS tm_created,
    tm.joined_at    AS tm_joined,
    cm.created_at   AS cm_created,
    -- Candidates that can only pull the bound EARLIER (see header).
    m.joined_at     AS mtm_joined,
    o.first_own     AS own_first
  FROM public.message_thread_members m
  JOIN public.message_threads mt ON mt.id = m.thread_id
  LEFT JOIN public.trip_members tm
         ON tm.trip_id = mt.trip_id AND tm.user_id = m.user_id
  LEFT JOIN public.circle_memberships cm
         ON cm.user_id = mt.circle_owner_id AND cm.other_id = m.user_id
  LEFT JOIN own_first o
         ON o.thread_id = m.thread_id AND o.sender_id = m.user_id
  WHERE m.visible_from_at IS NULL
), bounded AS (
  SELECT thread_id, user_id,
         LEAST(tm_created, tm_joined, cm_created, mtm_joined, own_first) AS vfa
    FROM evidence
   WHERE tm_created IS NOT NULL OR tm_joined IS NOT NULL OR cm_created IS NOT NULL
)
UPDATE public.message_thread_members m
   SET visible_from_at = b.vfa
  FROM bounded b
 WHERE m.thread_id = b.thread_id
   AND m.user_id  = b.user_id
   AND m.visible_from_at IS NULL
   AND b.vfa IS NOT NULL;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  hardened boolean;
  still_null bigint;
  retro bigint;
  bounded_rows bigint;
BEGIN
  -- 1. The hardened branch is actually in the installed function body. Checking
  --    the source rather than re-running the probe, because a trigger probe
  --    inside this transaction would write rows the rest of the file measures.
  SELECT position('OLD.visible_from_at IS NOT NULL AND NEW.visible_from_at IS NULL' IN p.prosrc) > 0
    INTO hardened
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telegraph_member_visibility_window';
  IF hardened IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the UPDATE-cannot-unbound branch is not present in telegraph_member_visibility_window().';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'message_thread_members'
       AND t.tgname = 'telegraph_member_visibility_window' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger telegraph_member_visibility_window is absent.';
  END IF;

  -- 2. Every row that HAD external evidence now carries a bound. A row that
  --    still has NULL with evidence available means the UPDATE above matched
  --    nothing it should have.
  SELECT count(*) INTO still_null
    FROM public.message_thread_members m
    JOIN public.message_threads mt ON mt.id = m.thread_id
    LEFT JOIN public.trip_members tm
           ON tm.trip_id = mt.trip_id AND tm.user_id = m.user_id
    LEFT JOIN public.circle_memberships cm
           ON cm.user_id = mt.circle_owner_id AND cm.other_id = m.user_id
   WHERE m.visible_from_at IS NULL
     AND (tm.created_at IS NOT NULL OR tm.joined_at IS NOT NULL OR cm.created_at IS NOT NULL);
  IF still_null > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % membership row(s) have external evidence but were left unbounded.', still_null;
  END IF;

  -- 3. THE DATA-INTEGRITY GATE. No member may end up with a window that opens
  --    after a message they themselves sent. That is the exact shape of a
  --    retroactive-hiding regression, and it aborts rather than ships.
  SELECT count(*) INTO retro
    FROM public.message_thread_members m
    JOIN public.messages msg
      ON msg.thread_id = m.thread_id AND msg.sender_id = m.user_id
   WHERE m.visible_from_at IS NOT NULL
     AND msg.created_at < m.visible_from_at;
  IF retro > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % (member, own message) pair(s) would fall outside the member''s own window — refusing to hide a member''s own history.', retro;
  END IF;

  SELECT count(*) INTO bounded_rows FROM public.message_thread_members WHERE visible_from_at IS NOT NULL;
  SELECT count(*) INTO still_null   FROM public.message_thread_members WHERE visible_from_at IS NULL;
  RAISE NOTICE '2966: % membership row(s) bounded, % left unbounded (no sync-independent evidence — see header).', bounded_rows, still_null;
END $$;

COMMIT;
