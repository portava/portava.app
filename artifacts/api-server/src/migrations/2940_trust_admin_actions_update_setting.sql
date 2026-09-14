-- 2940_trust_admin_actions_update_setting.sql
-- Trust admin audit — `update_setting` joins the action-type vocabulary, so a
-- settings edit stops being filed as a score override. IDF-53.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Additive + idempotent. Safe to re-run.
--
-- WHY THIS FILE EXISTS, stated rather than implied.
--
-- `routes/trust-admin.ts`'s trust-SETTINGS handler filed its audit row as
--
--     action_type: "score_override"
--
-- so a query for "who overrode a user's score" answered with settings edits.
-- `docs/trust/identity-foundation-checklist.md` records it as IDF-53. Two
-- different administrative acts under one name is not cosmetic: an audit log
-- whose vocabulary conflates two acts cannot answer the question it exists for,
-- and the answer it gives instead is WRONG rather than missing.
--
-- It was visible in the row's own data. The settings insert sets
-- `target_user: adminId` -- the admin auditing themselves -- because a settings
-- edit HAS no target user. A `score_override` row whose target is its own
-- author is a contradiction the schema stored without complaint.
--
-- WHY THE RENAME NEEDED A MIGRATION, which the checklist got wrong first.
-- IDF-53's "Blocked by" column said NOTHING. It is blocked on this file.
-- `trust_admin_actions_action_type_check` (baseline 20260819, line 10887)
-- constrains the column to NINE literals and `update_setting` is not among
-- them. The checklist's verification pass then found the part that matters:
--
--     "worse than stated: supabase-js RESOLVES on a DB error, so the 23514
--      would not even reach the swallowed catch. The rename would have
--      produced NO AUDIT ROW AT ALL."
--
-- Renaming the literal without widening the CHECK would have replaced a
-- MISLABELLED audit row with NO audit row, silently, on every settings edit --
-- trading a wrong answer for no answer and losing the ability to tell the
-- difference. So the constraint moves first and the code follows it.
--
-- WHY WIDEN RATHER THAN DROP. The CHECK is the only thing keeping this column a
-- vocabulary instead of free text; dropping it would end the whole class of
-- question this table answers. The nine existing literals are unchanged and no
-- stored row is touched.
--
-- RUNTIME EFFECT ON EXISTING ROWS: NONE. This widens what is admitted; it
-- admits no fewer values than before, so every row that validated still
-- validates. Historical settings edits already stored as `score_override` are
-- NOT rewritten -- they are the record of the defect, and rewriting them would
-- destroy the only evidence of how long it ran. Whether to reclassify them is
-- an owner decision and is NOT made here.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE have_constraint int;
BEGIN
  IF to_regclass('public.trust_admin_actions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trust_admin_actions does not exist.';
  END IF;
  SELECT count(*) INTO have_constraint
    FROM pg_constraint
   WHERE conrelid = 'public.trust_admin_actions'::regclass
     AND conname  = 'trust_admin_actions_action_type_check';
  IF have_constraint <> 1 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: trust_admin_actions_action_type_check not found (count %). This migration WIDENS that constraint; if it is absent the column is unconstrained and the vocabulary this file exists to protect does not exist.',
      have_constraint;
  END IF;
END $$;

-- ── Widen the vocabulary ─────────────────────────────────────────────────────
-- Dropped and recreated under the same name: Postgres has no ALTER CONSTRAINT
-- for a CHECK expression. Inside one transaction, so no window exists in which
-- the column is unconstrained.
ALTER TABLE public.trust_admin_actions
  DROP CONSTRAINT trust_admin_actions_action_type_check;

ALTER TABLE public.trust_admin_actions
  ADD CONSTRAINT trust_admin_actions_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'confirm_event'::text,
    'dismiss_event'::text,
    'apply_restriction'::text,
    'lift_restriction'::text,
    'apply_cap'::text,
    'lift_cap'::text,
    'score_override'::text,
    'resolve_review'::text,
    'flag_gaming'::text,
    'update_setting'::text
  ]));

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE def text; probe_ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'public.trust_admin_actions'::regclass
     AND conname  = 'trust_admin_actions_action_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the constraint was dropped and not recreated.';
  END IF;

  -- The new literal is admitted...
  IF position('update_setting' IN def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: update_setting is not in the recreated CHECK: %', def;
  END IF;

  -- ...and NONE of the nine were lost on the way. A widening that quietly
  -- narrowed would let an existing writer start failing 23514 -- which,
  -- because supabase-js resolves on a DB error, would show up as audit rows
  -- silently ceasing rather than as an error anyone sees.
  IF position('confirm_event'    IN def) = 0
  OR position('dismiss_event'    IN def) = 0
  OR position('apply_restriction' IN def) = 0
  OR position('lift_restriction' IN def) = 0
  OR position('apply_cap'        IN def) = 0
  OR position('lift_cap'         IN def) = 0
  OR position('score_override'   IN def) = 0
  OR position('resolve_review'   IN def) = 0
  OR position('flag_gaming'      IN def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the recreated CHECK lost one of the nine pre-existing action types: %', def;
  END IF;

  -- NEGATIVE PROBE: the constraint must still REFUSE something. A CHECK that
  -- admits everything is not a vocabulary, and a typo in the ARRAY above could
  -- produce exactly that without any assertion above noticing.
  BEGIN
    INSERT INTO public.trust_admin_actions (admin_id, target_user, action_type, reason)
    VALUES (NULL, NULL, 'not_a_real_action_type', '2940 negative probe');
    probe_ok := false;
  EXCEPTION WHEN check_violation THEN
    probe_ok := true;
  WHEN others THEN
    -- A NOT NULL or FK refusal also proves nothing was inserted, but it does
    -- NOT prove the CHECK is intact, so it is not accepted as a pass.
    RAISE EXCEPTION 'POSTCONDITION FAILED: the negative probe was refused by something other than the CHECK (%), so this migration did not establish that the vocabulary still binds.', SQLERRM;
  END;
  IF NOT probe_ok THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trust_admin_actions accepted an action_type outside the vocabulary — the CHECK admits everything.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   ALTER TABLE public.trust_admin_actions
--     DROP CONSTRAINT trust_admin_actions_action_type_check;
--   ALTER TABLE public.trust_admin_actions
--     ADD CONSTRAINT trust_admin_actions_action_type_check
--     CHECK (action_type = ANY (ARRAY['confirm_event'::text,'dismiss_event'::text,
--       'apply_restriction'::text,'lift_restriction'::text,'apply_cap'::text,
--       'lift_cap'::text,'score_override'::text,'resolve_review'::text,
--       'flag_gaming'::text]));
-- REVERSING IS NOT SAFE WHILE THE CODE WRITES `update_setting`: any
-- update_setting rows already stored would fail the narrowed CHECK and the
-- ALTER would abort, and if none exist yet the next settings edit stops being
-- audited at all. Revert the code first.
