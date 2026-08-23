-- 2138_profiles_fk_convergence_prep.sql
-- Resolve the 61 foreign keys that would block account deletion the moment
-- production converges to profiles -> auth.users CASCADE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Prerequisite for 2136, whose own precondition refuses to run until this is done.
--
-- ── WHY THESE ARE NOT A PROBLEM TODAY, AND WILL BE ──────────────────────────
-- 61 foreign keys point at public.profiles with ON DELETE NO ACTION or RESTRICT.
-- None of them blocks anything right now, for exactly one reason: production
-- never deletes the profiles row — executeAccountDeletion anonymises it — so the
-- parent delete these rules would reject never happens.
--
-- Add the canonical profiles -> auth.users CASCADE and all 61 activate at once.
-- Deleting an auth user would cascade into profiles, and every one of them would
-- reject it. That is not deletion working properly; it is this quarter's failure
-- relocated from five edges to sixty-one. This file removes them first.
--
-- ── THE RULE APPLIED, SO EVERY LINE BELOW IS AUDITABLE ──────────────────────
-- Owner rulings, 2026-08-23. Each edge is one of two shapes:
--
--   ACTOR column — the row is about something else and this column records who
--   acted on it (reviewed_by, admin_id, approved_by, set_by, and so on).
--   -> ON DELETE SET NULL. Ruling 2 for community records, ruling 4 for safety
--      and audit ones: the record survives, the person does not. 58 edges.
--
--   SUBJECT column — the row IS that person's data, or is about them.
--   -> decided individually against the rulings, and each one is argued in place
--      below rather than pattern-matched. 3 CASCADE, 5 SET NULL.
--
-- 21 of the SET NULL columns are NOT NULL today and are widened first. A SET
-- NULL rule on a NOT NULL column does not sever anything — it raises 23502 and
-- aborts the delete. That exact defect is what made moderation_reports.reporter_id
-- the fifth blocker in 2135, and this file must not recreate it 21 times.
--
-- ── CLIENT IMPACT ───────────────────────────────────────────────────────────
-- 21 columns become nullable and will begin returning null once deletions run.
-- Anything rendering "reviewed by", "approved by", "assigned to" or a payee name
-- must tolerate an absent person. No route filters or joins on these columns, so
-- nothing breaks server-side.
--
-- ── ONE EDGE THE SCHEMA DECIDED FOR US ──────────────────────────────────────
-- user_deletion_requests.user_id was classified SET NULL, on the reasoning that
-- ruling 4 keeps deletion audit evidence and severance is preferred. Postgres
-- refused: "column user_id is in a primary key". It is not merely part of the
-- key — it IS the key, the table's only identifying column.
--
-- So this table cannot outlive the person it is about. A record keyed by the
-- identity you are erasing can only be erased with it, and no FK rule changes
-- that. It becomes CASCADE.
--
-- WHICH MEANS PORTAVA HAS NO DELETION AUDIT RECORD. The row that proves a
-- deletion was requested, scheduled and executed dies in the act of executing.
-- journey_revocation_jobs holds an equivalent record for the Journey scope and
-- survives (it has a surrogate id), so the two disagree about whether Portava
-- can evidence its own deletions. If the answer must be yes, that needs a
-- separate append-only record keyed by something other than the user — a
-- pseudonymous reference — and that is a design decision, not a constraint edit.
-- Raised for the owner rather than invented here.
--
-- ── PROVISIONAL ENTRIES ─────────────────────────────────────────────────────
-- Four edges belong to tables still escalated to the owner
-- (rent_buddy_tag_consents, journey_shadow_cohort_assignments). They are set to
-- SET NULL here because it is the treatment that DESTROYS NOTHING: the row
-- survives and a stricter policy can still be applied later. CASCADE could not
-- be undone. Marked provisional so the ruling, when it comes, knows what it is
-- changing.
--
-- RUNTIME EFFECT BEFORE A DELETION RUNS: none.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
END $$;

-- Data-driven rather than 183 hand-written statements: the same three steps
-- repeat for every edge, and a table absent from this target (CI has no
-- journey_* family) is skipped rather than failing the migration.
DO $$
DECLARE
  r record;
  applied int := 0;
  skipped int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('buddy_booking_change_requests','requested_by','SETNULL'),
      ('buddy_booking_change_requests','responded_by','SETNULL'),
      ('buddy_booking_events','actor_user_id','SETNULL'),
      ('event_attendee_states','confirmed_by','SETNULL'),
      ('event_attendee_states','no_show_by','SETNULL'),
      ('event_join_requests','reviewed_by','SETNULL'),
      ('journey_shadow_cohort_assignments','assigned_by','SETNULL'),
      ('journey_shadow_cohort_assignments','revoked_by','SETNULL'),
      ('journey_shadow_ground_truth','submitted_by','SETNULL'),
      ('journey_shadow_qa_reports','submitted_by','SETNULL'),
      ('journey_shadow_session_issuances','issued_by','SETNULL'),
      ('journey_shadow_stages','approved_by','SETNULL'),
      ('moderation_actions','performed_by','SETNULL'),
      ('passport_postcards','stamp_revoked_by','SETNULL'),
      ('posts','created_by','SETNULL'),
      ('posts','updated_by','SETNULL'),
      ('rent_buddy_admin_access_logs','admin_id','SETNULL'),
      ('rent_buddy_admin_actions','admin_id','SETNULL'),
      ('rent_buddy_applications','reviewed_by','SETNULL'),
      ('rent_buddy_beta_access','invited_by','SETNULL'),
      ('rent_buddy_beta_access','revoked_by','SETNULL'),
      ('rent_buddy_bookings','group_lead_id','SETNULL'),
      ('rent_buddy_city_restrictions','created_by','SETNULL'),
      ('rent_buddy_city_rollouts','status_changed_by','SETNULL'),
      ('rent_buddy_disputes','raised_by','SETNULL'),
      ('rent_buddy_earnings_ledger','buddy_user_id','SETNULL'),
      ('rent_buddy_earnings_ledger','traveler_id','SETNULL'),
      ('rent_buddy_emergency_contacts_snapshot','user_id','CASCADE'),
      ('rent_buddy_global_controls','updated_by_admin_id','SETNULL'),
      ('rent_buddy_launch_audit_logs','admin_id','SETNULL'),
      ('rent_buddy_launch_checklists','tested_by_admin_id','SETNULL'),
      ('rent_buddy_launch_controls','created_by','SETNULL'),
      ('rent_buddy_packages','admin_reviewed_by','SETNULL'),
      ('rent_buddy_payouts','held_by','SETNULL'),
      ('rent_buddy_payouts','released_by','SETNULL'),
      ('rent_buddy_policy_flags','flagged_user_id','SETNULL'),
      ('rent_buddy_policy_flags','reporter_user_id','SETNULL'),
      ('rent_buddy_reviews','reviewee_id','CASCADE'),
      ('rent_buddy_route_change_requests','requested_by','SETNULL'),
      ('rent_buddy_safety_checkins','user_id','SETNULL'),
      ('rent_buddy_safety_events','actor_user_id','SETNULL'),
      ('rent_buddy_safety_events','target_user_id','SETNULL'),
      ('rent_buddy_support_reports','reporter_id','SETNULL'),
      ('rent_buddy_tag_consents','requester_id','SETNULL'),
      ('rent_buddy_tag_consents','target_id','SETNULL'),
      ('rent_buddy_tips','buddy_user_id','SETNULL'),
      ('rent_buddy_training_checklist','user_id','CASCADE'),
      ('rent_buddy_user_limits','created_by_admin_id','SETNULL'),
      ('reports','reviewed_by','SETNULL'),
      ('stamp_award_events','admin_id','SETNULL'),
      ('trip_checklist_items','assigned_to','SETNULL'),
      ('trip_join_requests','reviewed_by','SETNULL'),
      ('trust_admin_actions','admin_id','SETNULL'),
      ('trust_caps','lifted_by','SETNULL'),
      ('trust_events','reviewed_by','SETNULL'),
      ('trust_restrictions','lifted_by','SETNULL'),
      ('trust_reviews','assigned_to','SETNULL'),
      ('trust_reviews','resolved_by','SETNULL'),
      ('user_account_states','set_by','SETNULL'),
      ('user_deletion_requests','user_id','CASCADE'),
      ('user_stamps','awarded_by_admin_id','SETNULL')
    ) AS t(tbl, col, action)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    -- SET NULL needs a nullable column, or it raises 23502 instead of severing.
    IF r.action = 'SETNULL' THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', r.tbl, r.col);
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   r.tbl, r.tbl || '_' || r.col || '_fkey');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE %s',
      r.tbl, r.tbl || '_' || r.col || '_fkey', r.col,
      CASE r.action WHEN 'CASCADE' THEN 'CASCADE' ELSE 'SET NULL' END);

    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'profiles FK convergence prep: % edge(s) converted, % skipped (table absent here)',
    applied, skipped;
END $$;

-- ── Postcondition: the blocker set must be EMPTY ────────────────────────────
-- This is the assertion 2136 depends on. It re-runs the same query 2136 uses to
-- decide whether it may proceed, so the two cannot drift apart.
DO $$
DECLARE
  remaining int;
  sample text;
BEGIN
  SELECT count(*),
         string_agg(format('%s.%s', c.conrelid::regclass::text, a.attname), ', ')
    INTO remaining, sample
    FROM pg_constraint c
    JOIN unnest(c.conkey) k(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE c.contype = 'f'
     AND n.nspname = 'public'
     AND c.confrelid = 'public.profiles'::regclass
     AND ( c.confdeltype IN ('a','r') OR (c.confdeltype = 'n' AND a.attnotnull) );

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: % edge(s) would still block a cascading delete: %',
      remaining, left(sample, 400);
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Restoring NO ACTION on these 61 edges re-blocks account deletion under a
-- converged schema, and re-adding NOT NULL to the 21 widened columns is only
-- possible while no row has been severed. Reverse only to unwind a bad apply.
