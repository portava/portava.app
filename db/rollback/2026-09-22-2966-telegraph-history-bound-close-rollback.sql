-- Rollback for 2966_telegraph_history_bound_close.sql
--
-- WHAT CAN AND CANNOT BE UNDONE
--
-- Part 1 (the trigger hardening) is fully reversible: this file restores the
-- 2400 function body, which does not defend the UPDATE path.
--
-- Part 2 (the backfill) is NOT reversible by this file and deliberately so.
-- Setting visible_from_at back to NULL for the rows 2966 bounded would WIDEN
-- access again — it would hand a newly added member the pre-membership history
-- §14.3 forbids. That is the defect, not the recovery from it. If the bound
-- must be lifted, the supported route is to turn the READ off:
--
--   SELECT public.toggle_feature_flag_with_audit(
--     'telegraph_history_bound_enabled', false, '<reason>');
--
-- which makes every reader byte-identical to its pre-2400 behaviour while
-- leaving the data intact, so the bound can be turned back on without a second
-- backfill. The rows 2966 wrote came from sync-independent evidence, not from
-- now(), so they remain correct however long the flag stays off.
--
-- The one genuinely un-writable state this file will not recreate is "no row
-- has a bound at all". Nothing needs it: NULL is unbounded, and the flag is the
-- switch.

BEGIN;

CREATE OR REPLACE FUNCTION public.telegraph_member_visibility_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.visible_from_at := COALESCE(NEW.visible_from_at, NEW.joined_at, now());
    RETURN NEW;
  END IF;

  -- UPDATE. A rejoin (left_at NOT NULL -> NULL) is a new membership interval.
  IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
    IF NEW.visible_from_at IS NOT DISTINCT FROM OLD.visible_from_at THEN
      NEW.visible_from_at := now();
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_member_visibility_window() IS
  'Telegraph §14.3: opens a member''s visibility window at the membership start (INSERT) and again on rejoin (left_at NOT NULL -> NULL). Writer-independent so no sync path can reset it by accident. Nothing reads the column unless telegraph_history_bound_enabled is TRUE.';

DROP TRIGGER IF EXISTS telegraph_member_visibility_window ON public.message_thread_members;
CREATE TRIGGER telegraph_member_visibility_window
  BEFORE INSERT OR UPDATE ON public.message_thread_members
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_member_visibility_window();

COMMIT;
