-- Rollback for 2640_collections_single_default_per_owner.sql
--
-- Drops the partial unique index. Note what this restores: the ability for one
-- owner to hold several default collections, which is the state the defect
-- produced. The application's 23505 branch becomes unreachable (it can no
-- longer be raised), but it is harmless -- the checked lookup error, which is
-- what actually closed the reported defect, does not depend on the index.
BEGIN;
DROP INDEX IF EXISTS public.collections_one_default_per_owner_idx;
COMMIT;
