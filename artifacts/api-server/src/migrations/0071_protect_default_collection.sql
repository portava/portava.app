-- ============================================================
-- Migration 0071: Protect default collection from deletion
-- ============================================================
-- Adds a BEFORE DELETE trigger on `collections` that blocks
-- deletion of any row where is_default = TRUE, regardless of
-- the caller (API, admin dashboard, migration script).
--
-- Why a trigger and not a FK constraint:
--   ON DELETE RESTRICT only applies to referencing foreign keys,
--   not to the referenced table's own rows. Blocking deletion of
--   specific rows based on a column value requires a trigger.
--
-- Impact on existing code:
--   The API DELETE /users/me/collections/:id handler already
--   returns 403 before reaching the DB when is_default = TRUE.
--   This trigger is the belt-and-suspenders layer for direct DB
--   access (Supabase dashboard, psql, scripts).
--
-- The trigger fires BEFORE DELETE so it prevents CASCADE from
-- propagating to collection_items and orphaning saved items.
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_default_collection_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_default THEN
    RAISE EXCEPTION
      'Cannot delete the default Saved collection (id: %). '
      'Set is_default = FALSE first or reassign another row as default.',
      OLD.id
      USING ERRCODE = '23000'; -- integrity_constraint_violation
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS enforce_default_collection_no_delete ON collections;

CREATE TRIGGER enforce_default_collection_no_delete
  BEFORE DELETE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION prevent_default_collection_delete();
