-- 2136_profiles_auth_users_convergence.sql
-- Declare the canonical profiles -> auth.users relationship, and refuse to
-- apply it anywhere that is not ready.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ⚠ NOT FOR PRODUCTION YET. Owner ruling 2026-08-23: production converges to the
-- migration-defined relationship, but deliberately and later. This file exists so
-- the REPOSITORY describes the intended relationship — the missing half of the
-- drift — not so anyone applies it today. Its own preconditions refuse to run on
-- a database that would break, which is the safety this needs rather than a note
-- asking people to be careful.
--
-- ── THE DRIFT, CAPTURED FROM PRODUCTION 2026-08-23 (read-only) ──────────────
--   CI          profiles_id_fkey -> auth.users ON DELETE CASCADE
--   PRODUCTION  no foreign key on public.profiles AT ALL. Its constraints are
--               profiles_pkey, profiles_handle_key, and four CHECKs. Nothing
--               ties a profile to an auth user.
--   PRODUCTION  58 profiles, 89 auth users, 0 orphan profiles,
--               31 auth users with NO profile row, and NO trigger on auth.users.
--
-- Two things follow. First, the FK can be added to production without cleanup:
-- zero profiles lack an auth user, so nothing violates it. Second, the 31 auth
-- users with no profile are a separate integrity question this file does not
-- answer — the FK points from profiles to users, so their absence does not block
-- it, but it does mean signup is not reliably creating a profile.
--
-- ── WHY CONVERGING IS NOT SAFE YET ─────────────────────────────────────────
-- This is the finding that decides the ordering, and it is not obvious.
--
-- 61 foreign keys point at public.profiles with ON DELETE NO ACTION or RESTRICT.
-- They block nothing today, for one reason only: production never deletes the
-- profiles row — executeAccountDeletion anonymises it. The parent delete that
-- those rules would reject simply never happens.
--
-- Add this FK and that changes. Deleting an auth user would cascade into
-- profiles, and every one of those 61 rules would then reject the delete. The
-- result is not "deletion works properly" — it is the SAME failure this quarter's
-- work has been removing, relocated from five edges to sixty-one.
--
-- So this migration refuses to apply while any of them remain. That is
-- deliberate: a migration that can leave the database unable to delete an
-- account should not rely on the operator remembering why.
--
-- ── AND A SECOND PREREQUISITE, IN CODE NOT SCHEMA ──────────────────────────
-- Once profiles cascades, the cascade reaches intel_observations, whose
-- statement-level append-only trigger fires EVEN FOR ZERO ROWS. The deletion
-- worker must therefore hold `portava.erasure_in_progress` across the auth
-- delete, not merely call erase_intel_for_actor() and let that transaction end.
-- Verified on CI: without it the delete aborts with "intel_observations is
-- append-only". No schema check can assert a code change, so it is stated here
-- and must be confirmed before this file is applied.

BEGIN;

-- ── Precondition 1: the relationship must be addable ────────────────────────
DO $$
DECLARE orphans bigint;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;

  SELECT count(*) INTO orphans
    FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);

  IF orphans > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % profile row(s) have no auth.users parent. Adding the foreign key would fail. Resolve them first — they are either orphaned rows to delete or auth users to restore.', orphans;
  END IF;
END $$;

-- ── Precondition 2: converging must not create new deletion blockers ────────
-- The whole reason this file is gated. Counted, named, and refused.
DO $$
DECLARE
  blockers int;
  sample text;
BEGIN
  SELECT count(*),
         string_agg(format('%s.%s', c.conrelid::regclass::text, a.attname), ', '
                    ORDER BY c.conrelid::regclass::text)
    INTO blockers, sample
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE c.contype = 'f'
     AND n.nspname = 'public'
     AND c.confrelid = 'public.profiles'::regclass
     AND ( c.confdeltype IN ('a', 'r')                    -- NO ACTION / RESTRICT
        OR (c.confdeltype = 'n' AND a.attnotnull) );      -- SET NULL onto NOT NULL

  IF blockers > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % foreign key(s) to public.profiles would reject a cascading delete once this migration lands, turning one broken deletion path into % of them. They are dormant today only because production never deletes the profiles row. Resolve each under the D6 rulings first. Offenders: %',
      blockers, blockers, sample;
  END IF;
END $$;

-- ── Precondition 3: converging must not DESTROY another user's records ─────
-- The second thing 2138 taught, and the more dangerous one. Clearing the
-- blockers makes deletion COMPLETE; it does not make it CORRECT.
--
-- 168 foreign keys point at public.profiles with ON DELETE CASCADE. Like the
-- blockers they are dormant, and like the blockers they all activate here. But
-- these do not reject the delete — they perform one. Among them are tables that
-- hold records belonging to OTHER people.
--
-- Demonstrated on CI before this gate was written: a thread with one message
-- from the departing user and one reply from a bystander. After the converged
-- deletion, `messages` went from 2 rows to 1. The bystander was left holding a
-- reply to a message that no longer exists.
--
-- Ruling 3 names this case exactly: user content is deletable "unless retaining
-- a minimal tombstone is required to preserve another user's conversation or
-- transaction integrity." A conversation is the canonical example, and today
-- convergence would delete one side of it.
--
-- So these tables must be ruled on — tombstone or erase — BEFORE the FK lands.
-- The list is not every CASCADE edge; it is the ones whose rows plainly belong
-- to, or are shared with, someone other than the departing user.
DO $$
DECLARE
  unreviewed int;
  sample text;
BEGIN
  SELECT count(*), string_agg(format('%s.%s', c.conrelid::regclass::text, a.attname), ', ')
    INTO unreviewed, sample
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE c.contype = 'f'
     AND n.nspname = 'public'
     AND c.confrelid = 'public.profiles'::regclass
     AND c.confdeltype = 'c'
     AND c.conrelid::regclass::text IN (
       -- Conversations and their parts
       'messages', 'message_threads', 'message_thread_members', 'message_translations',
       'saved_messages',
       -- Content other people read, reply to, or depend on
       'posts', 'event_updates', 'event_reviews', 'highlight_replies',
       'shared_moment_contributions', 'live_place_recaps', 'local_guide_contributions',
       'discovery_place_reports', 'hidden_gems',
       -- Shared containers other members belong to
       'trips', 'trip_notes', 'trip_documents', 'events', 'circles', 'meetups'
     );

  IF unreviewed > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % CASCADE edge(s) would DELETE records belonging to other users once this migration lands. Deletion would complete and destroy someone else''s conversation doing it. Rule each under D6 (tombstone via SET NULL, or erase deliberately) first. Offenders: %',
      unreviewed, left(sample, 400);
  END IF;
END $$;

-- ── The relationship itself ─────────────────────────────────────────────────
-- CASCADE, matching CI and the deletion model: removing the auth user removes
-- the person, and the tombstone behaviour that survives today becomes an
-- explicit worker decision rather than an accident of a missing constraint.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT profiles_id_fkey ON public.profiles IS
  'Canonical relationship: a profile exists only for an auth user. Present on CI since inception and added to production by this migration. Deleting the auth user removes the profile; any tombstone behaviour must therefore be an explicit choice in the deletion worker, not a side effect of a missing constraint.';

-- ── Postcondition ───────────────────────────────────────────────────────────
DO $$
DECLARE rule "char";
BEGIN
  SELECT confdeltype INTO rule
    FROM pg_constraint
   WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_id_fkey';

  IF rule IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: profiles_id_fkey was not created.';
  END IF;
  IF rule <> 'c' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: profiles_id_fkey exists but its delete rule is %, not CASCADE.', rule;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
--   ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
-- Reversing restores the production behaviour of a profile row that outlives its
-- auth user. Nothing is lost by reversing; nothing is gained by leaving it
-- reversed except the drift this file exists to close.
