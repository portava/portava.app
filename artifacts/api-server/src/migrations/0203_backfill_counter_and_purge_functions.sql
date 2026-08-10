-- Migration 0203: BACKFILL of increment_counter and purge_old_ranking_debug_samples
--
-- ⚠️  THIS MIGRATION DOES NOT CHANGE PRODUCTION. ⚠️
--
-- Same contract as 0200: both functions ALREADY EXIST live and have for a long
-- time. This file exists so a CLEAN REBUILD from the migration chain reproduces
-- production. Applying it to current production is a no-op by construction
-- (CREATE OR REPLACE with the exact live definition). Nobody should "apply" this
-- expecting an effect, and nobody should treat it as PENDING work.
--
-- PROVENANCE
-- ----------
-- Both bodies were read from live with pg_get_functiondef() and pasted verbatim
-- — not retyped, not reformatted. `pnpm run check:backfill-0200` re-reads live
-- and asserts each definition appears byte-for-byte here, so drift is detectable
-- rather than merely promised.
--
-- WHY NOW
-- -------
-- These were the two functions 0200 deliberately left out and inventoried, on
-- the grounds that neither is a rebuild-correctness dependency: nothing (no
-- policy, view, constraint or other function) references either, so a rebuilt
-- schema is structurally complete without them. That remains true. They are
-- captured now to close the last of the known migration-vs-live function drift,
-- not because the earlier reasoning changed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️  KNOWN DEFECT REPRODUCED VERBATIM — purge_old_ranking_debug_samples
-- ─────────────────────────────────────────────────────────────────────────────
-- purge_old_ranking_debug_samples() is SECURITY DEFINER with **no pinned
-- search_path**, and it performs a DELETE. That is the exact hazard migration
-- 0201 closed for the authorization functions: a caller who can create a schema
-- can shadow `ranking_debug_samples` and misdirect the DELETE, while the
-- function executes with the definer's privileges.
--
-- It is reproduced here UNPINNED, on purpose. A backfill's only contract is
-- "identical to live"; silently hardening a function inside one would make this
-- file diverge from production and defeat the reason it exists. The fix belongs
-- in its own migration — an ALTER FUNCTION, exactly as 0201 did — so that the
-- change to authorization-adjacent behaviour is reviewable on its own terms.
--
-- 0201 already inventoried this function as a recommended follow-up. This
-- migration does not close it. Do not "tidy" the SET line in here.
--
-- (increment_counter, by contrast, is correct as it stands: it pins
-- SET search_path TO 'public', hard-codes an allow-list of one table and two
-- columns and RAISEs otherwise, quotes identifiers with %I, and binds the id
-- with USING. Nothing about it needs changing.)
--
-- ORDER
-- -----
-- Neither function calls the other, and nothing else calls either, so order is
-- not load-bearing here — unlike 0200, where is_accepted_trip_member had to
-- precede its three callers.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. increment_counter — guarded counter bump for hidden_gems.
--    Allow-list is enforced inside the body; %I quoting + USING bind make the
--    dynamic UPDATE injection-safe. Pins search_path itself.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_counter(table_name text, column_name text, row_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF table_name NOT IN ('hidden_gems') OR column_name NOT IN ('save_count', 'visit_count') THEN
    RAISE EXCEPTION 'increment_counter: %.% is not allowed', table_name, column_name;
  END IF;
  EXECUTE format('UPDATE %I SET %I = COALESCE(%I, 0) + 1 WHERE id = $1', table_name, column_name, column_name)
    USING row_id;
END $function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. purge_old_ranking_debug_samples — 7-day retention over a debug table.
--    REPRODUCED UNPINNED. See the KNOWN DEFECT block above before editing.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_old_ranking_debug_samples()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM ranking_debug_samples
  WHERE sampled_at < now() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;
