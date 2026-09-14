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

  -- BEHAVIOURAL PROBE, on a CONSTRAINT-ONLY COPY. The assertions above read the
  -- constraint's TEXT; they cannot tell whether it still binds. A typo in the
  -- ARRAY could leave a CHECK that admits everything, and `position(... IN def)`
  -- would happily find all ten literals inside it.
  --
  -- THE FIRST VERSION OF THIS PROBE INSERTED INTO THE REAL TABLE with NULL
  -- admin_id and target_user, and CI caught it: "the negative probe was refused
  -- by something other than the CHECK (null value in column target_user ...
  -- violates not-null constraint)". Postgres reached NOT NULL before the CHECK,
  -- so the probe proved nothing and the `WHEN others` arm correctly refused the
  -- migration rather than accept a refusal it had not asked for. Supplying real
  -- ids is not an option either: both columns are foreign keys to
  -- public.profiles, and a freshly built database has no profiles rows (the
  -- 2921 probe on the same run logs exactly that).
  --
  -- So the probe runs against a TEMP table built `LIKE ... INCLUDING CONSTRAINTS`
  -- — the CHECK as deployed, carried onto a copy that has no foreign keys to
  -- satisfy. Nothing is written to the real table, on any database, ever.
  CREATE TEMP TABLE probe_2940 (LIKE public.trust_admin_actions INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;

  -- NEGATIVE: a value outside the vocabulary must be REFUSED, and refused by
  -- the CHECK specifically.
  BEGIN
    INSERT INTO probe_2940 (admin_id, target_user, action_type, reason)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'not_a_real_action_type', '2940 negative probe');
    probe_ok := false;
  EXCEPTION WHEN check_violation THEN
    probe_ok := true;
  WHEN others THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the negative probe was refused by something other than the CHECK (%), so this migration did not establish that the vocabulary still binds.', SQLERRM;
  END;
  IF NOT probe_ok THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the vocabulary admits an action_type outside the ten — the CHECK admits everything.';
  END IF;

  -- POSITIVE: and it must still ACCEPT the new literal. Without this half a
  -- constraint that refused EVERYTHING would pass the negative probe, and the
  -- first settings edit after deploy would write no audit row at all — the
  -- precise failure this migration exists to prevent, arriving through the
  -- migration meant to prevent it.
  BEGIN
    INSERT INTO probe_2940 (admin_id, target_user, action_type, reason)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'update_setting', '2940 positive probe');
    probe_ok := true;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the recreated CHECK REFUSES update_setting (%) — the code that writes it would leave no audit row.', SQLERRM;
  END;

  -- ...and one of the nine, so the widening did not narrow in practice either.
  BEGIN
    INSERT INTO probe_2940 (admin_id, target_user, action_type, reason)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'score_override', '2940 incumbent probe');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the recreated CHECK REFUSES score_override (%) — an existing writer would silently stop being audited.', SQLERRM;
  END;

  DROP TABLE probe_2940;
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
