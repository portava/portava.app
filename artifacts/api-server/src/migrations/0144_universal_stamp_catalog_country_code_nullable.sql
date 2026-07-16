-- Migration: Make universal_stamp_catalog.country_code nullable
--
-- The column was originally created as char(2) NOT NULL, using "XX" as a
-- sentinel for entries whose country code is unknown.  CatalogEntryForPrompt
-- (artDirection.ts) already models country_code as string | null, and the
-- prompt builder guards against null at runtime.  Making the column nullable
-- removes the discrepancy so the Supabase-generated types can honestly expose
-- string | null and the null path is exercisable by statically-typed callers.
--
-- Safe to run on an existing database: existing "XX" sentinel rows are
-- unaffected; null is now a valid alternative sentinel.

ALTER TABLE universal_stamp_catalog
  ALTER COLUMN country_code DROP NOT NULL;
