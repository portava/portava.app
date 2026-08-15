-- 2094_discovery_shadow_serves_cohort.sql
-- Record WHICH cohort each shadow observation came from. Ruling D6.
--
-- WHY THE ROW HAS TO CARRY THIS
-- =============================
-- D6 stages shadow: internal accounts first (A), then a fixed user-id-hashed
-- percentage (B), then everyone only with the owner (C). Those are DIFFERENT
-- POPULATIONS, and rows from them must not be pooled:
--
--   - D6=A rows come from a handful of internal accounts. They prove the
--     harness runs. They say nothing about real users, because they are not
--     real users.
--   - D6=B rows are a hashed sample of real traffic. They are the ones the
--     divergence measurement is actually made from.
--
-- Without this column the two are indistinguishable in the table, and the only
-- way to tell them apart would be to remember what `metadata.cohort` said on
-- the day each row was written. Reconstructing an experiment's population from
-- recollection is the failure mode this project keeps finding; a row that does
-- not say where it came from will eventually be read as though it came from
-- wherever the reader assumes.
--
-- WHY NOW, WITH THE TABLE EMPTY
-- =============================
-- discovery_shadow_serves holds 0 rows and shadow has never been enabled, so
-- adding this costs nothing and every row that will ever exist carries it.
-- Adding it after the first rows land would create a NULL population that can
-- never be attributed to anything — the exact gap the column exists to close,
-- introduced by the act of closing it late.
--
-- WHY IT IS NULLABLE
-- ==================
-- Not laxity. NULL has one meaning here: written by a code path that predates
-- this column. Zero such rows exist today, so NULL should never appear — and
-- if it ever does, that is a finding rather than a shrug, and a NOT NULL with a
-- default would have hidden it behind a plausible-looking value.
--
-- WHAT THE VALUES ARE
-- ===================
-- The decision reason from lib/discoveryCohort.ts, for INCLUDED users only,
-- since an excluded user produces no row at all:
--
--   'user_listed'  D6=A — an explicitly named account
--   'percent_in'   D6=B — inside the hashed percentage
--   'kind_all'     D6=C — cohort was "everyone" (owner's decision)
--
-- cohort_bucket is the 0-99 hash bucket, present only for percent_in. It is
-- recorded so a membership decision can be re-derived by hand from the user id
-- rather than taken on trust, and so that a percentage change can be seen in
-- the data as a widening band instead of inferred from a config history.
--
-- BEHAVIOUR
-- =========
-- None. The table is empty, DISCOVERY_ENGINE_MODE resolves to `legacy`, and the
-- cohort gate includes nobody by default. This adds two columns to a table
-- nothing writes to yet.

ALTER TABLE discovery_shadow_serves
  ADD COLUMN IF NOT EXISTS cohort_reason text,
  ADD COLUMN IF NOT EXISTS cohort_bucket smallint;

COMMENT ON COLUMN discovery_shadow_serves.cohort_reason IS
  'Which D6 cohort admitted this user: user_listed (A) | percent_in (B) | kind_all (C). NULL means a code path predating migration 2094, which should never occur.';

COMMENT ON COLUMN discovery_shadow_serves.cohort_bucket IS
  'The 0-99 hashed bucket for this user, present only when cohort_reason = percent_in. Lets a membership decision be re-derived from the user id rather than trusted.';
