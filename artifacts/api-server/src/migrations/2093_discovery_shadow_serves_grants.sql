-- 2093_discovery_shadow_serves_grants.sql
-- Make the grants on discovery_shadow_serves match what 2092 says they are.
--
-- WHAT WENT WRONG, EXACTLY
-- ========================
-- 2092's header states that `service_role` receives INSERT and SELECT "and
-- nothing else". After it was applied, the live catalog said:
--
--   service_role: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- 2092 revoked from PUBLIC, anon and authenticated — and those revokes DID
-- land; anon and authenticated hold nothing, verified against the live catalog.
-- What it never revoked from was `service_role`, because it assumed a
-- newly-created table grants nothing to anyone.
--
-- That assumption is wrong on Supabase. The public schema carries ALTER DEFAULT
-- PRIVILEGES granting ALL on new tables to service_role (and to postgres), so
-- the privileges were already there the instant CREATE TABLE ran. The explicit
-- `GRANT INSERT, SELECT TO service_role` then added nothing that was not
-- already held, and read as though it had established a limit it never
-- established.
--
-- WHY NOTHING CAUGHT IT
-- =====================
-- `audit:schema` DOES model table grants — it parses `GRANT <privs> ON <table>
-- TO <role>` and checks each against information_schema.role_table_grants. The
-- earlier claim in this repository that it "compares objects, not privileges"
-- was WRONG, and is corrected here.
--
-- What it does is a PRESENCE check, not an EQUALITY check:
--
--   - it asks "is each grant a migration CLAIMS actually present?"
--   - it cannot see EXCESS privileges beyond those claimed;
--   - and it does not model REVOKE at all — the word appears in that script
--     only inside comments.
--
-- 2092 claimed `service_role.insert` and `service_role.select`. Both WERE
-- present. So the audit had nothing to report, and was right not to: the five
-- extra privileges and the four revokes that never took effect are both
-- outside anything its claim model can express.
--
-- That is the real gap, and it is narrower and more interesting than "it does
-- not look at grants". An audit that can only confirm the presence of what you
-- claimed cannot tell you that you also hold six things you did not.
--
-- So the documented mechanism silently did not land and every gate went green.
--
-- The append-only property itself survived, on the UPDATE triggers alone. That
-- is precisely the problem worth naming rather than the reassurance it looks
-- like: 2092 described three independent mechanisms, one of them was absent
-- from the moment it was applied, and the system could not tell anyone. A claim
-- about privileges has to be checked against the catalog or it is a comment.
--
-- `pnpm run audit:shadow-append-only` (added with this migration) now makes
-- that check, and fails when the live grants do not match this file.
--
-- WHAT THIS MIGRATION DOES
-- ========================
--   1. Revokes everything from service_role, then re-grants exactly INSERT and
--      SELECT. The revoke has to come FIRST and has to be unconditional — that
--      is the whole defect being repaired.
--
--   2. Adds a BEFORE TRUNCATE trigger.
--
-- WHY THE TRUNCATE TRIGGER, WHEN THE REVOKE ALREADY REMOVES TRUNCATE
-- ==================================================================
-- TRUNCATE was the sharpest privilege in that list, and it is the one 2092's
-- design did not account for at all: it empties the table without firing either
-- UPDATE trigger and without producing a single DELETE. An append-only table
-- that can be emptied in one statement is append-only in a sense nobody cares
-- about.
--
-- The grants now remove it. The trigger is there because the grants ALREADY
-- drifted once, from the default privileges of the schema, silently, on this
-- exact table. Mechanism 3 is the one that demonstrably held; extending it to
-- cover the operation mechanism 1 was supposed to cover is the correction that
-- matches what actually happened rather than what was supposed to.
--
-- It also makes the property verifiable for free, like the statement-level
-- UPDATE trigger before it:
--
--   TRUNCATE discovery_shadow_serves;
--   -- expect: ERROR ... is append-only (operator ruling D7=A): TRUNCATE is not permitted
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- ================================
-- `postgres` still holds ALL. It owns the table; an owner can re-grant itself
-- at will, so revoking from it buys the appearance of a constraint and not the
-- constraint. The audit does not assert against it for the same reason, and
-- says so.
--
-- DELETE remains reachable through the auth.users cascade, and only through it.
-- No role is granted DELETE, and referential-integrity actions execute under
-- the referencing table's owner with permission checks skipped — so account
-- deletion still erases a user's shadow rows, which is the trade 2092 made
-- deliberately and this migration preserves.
--
-- BEHAVIOUR
-- =========
-- None. The table holds 0 rows, DISCOVERY_ENGINE_MODE resolves to `legacy`, and
-- nothing writes here. This narrows what a role is permitted to do to a table
-- nothing is currently using.

REVOKE ALL ON discovery_shadow_serves FROM service_role;
GRANT INSERT, SELECT ON discovery_shadow_serves TO service_role;

-- Re-assert the client-surface revokes. They landed correctly under 2092; they
-- are repeated here so that this file, read alone, states the complete intended
-- privilege set rather than half of it.
REVOKE ALL ON discovery_shadow_serves FROM PUBLIC;
REVOKE ALL ON discovery_shadow_serves FROM anon;
REVOKE ALL ON discovery_shadow_serves FROM authenticated;

DROP TRIGGER IF EXISTS discovery_shadow_serves_no_truncate ON discovery_shadow_serves;
CREATE TRIGGER discovery_shadow_serves_no_truncate
  BEFORE TRUNCATE ON discovery_shadow_serves
  FOR EACH STATEMENT
  EXECUTE FUNCTION discovery_shadow_serves_append_only();
