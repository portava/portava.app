-- Rollback for 3004_sensing_presence_context_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3004 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('sensing_presence_context_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE.
--
-- ── WHY IT REFUSES TO DELETE AN ENABLED FLAG ───────────────────────────────
-- If the row reads TRUE, the owner has taken decision #9 and a surface is
-- consuming a sensing aggregate. Deleting the row would turn that capability
-- off — `isFlagEnabled` answers false for an absent row — which is a PRODUCT
-- CHANGE dressed up as a rollback, made by a script, with no record of who
-- decided it. A rollback may undo what its migration did; it may not undo what
-- an owner did afterwards.
--
-- So it raises instead, and the operator decides explicitly.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'sensing_presence_context_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: sensing_presence_context_enabled is TRUE. The owner has taken decision #9 since 3004 was applied; deleting the row would silently disable a live capability. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'sensing_presence_context_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'sensing_presence_context_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_presence_context_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
