-- 2333_derived_memory_and_consent_grant_boundary.sql
--
-- The derived-memory tables and five consent//intel tables stop resting on
-- Supabase's default privileges and start resting on an explicit grant set.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2333.
--
-- Same class as 2332_money_grant_boundary.sql, extended to the tables that
-- 2332 did not cover. Privilege-only: it creates nothing, drops nothing, writes
-- no row, flips no flag, and does not add, alter or drop a single RLS policy.
-- Idempotent (REVOKE-then-GRANT), so re-running it is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE LIVE GRANT SET, MEASURED — NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read on 2026-09-07 from BOTH databases via aclexplode(pg_class.relacl), the
-- query that sees every privilege including PG17's MAINTAIN:
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
-- ── FINDING 1 — the serious one. PRODUCTION AND CI, IDENTICAL. ───────────────
-- All four derived-memory tables grant the FULL set
--
--   DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- to `anon` AND `authenticated` AND `service_role`:
--
--   memory_events   memory_feedback   memory_policy   memory_projections
--
-- `anon` is the UNAUTHENTICATED public role. No migration asked for this; it is
-- what ALTER DEFAULT PRIVILEGES on the `public` schema hands out at CREATE TABLE
-- time, and 2183/2192 never took it back.
--
-- WHY THIS IS NOT A LIVE BREACH, AND WHY IT IS STILL A DEFECT.
-- All four have RLS ENABLED with ZERO policies in both databases (verified via
-- pg_class.relrowsecurity + pg_policies). RLS with no policy denies every
-- non-BYPASSRLS role, so no row is readable or writable by anon today. The grant
-- is inert for SELECT/INSERT/UPDATE/DELETE.
--
-- TRUNCATE IS THE EXCEPTION. PostgreSQL does NOT apply row-level security to
-- TRUNCATE. A role holding TRUNCATE empties the table whatever the policies say.
-- So for these four production tables the only thing standing between the public
-- anon key and an instant wipe of every derived memory row is that PostgREST
-- exposes no TRUNCATE verb. That is an absent verb, not a permission — and it is
-- not a boundary this repository should be relying on.
--
-- Because there are zero policies, revoking cannot break a legitimate caller:
-- there is no anon/authenticated path through these tables to break. The revoke
-- is pure subtraction of unreachable-but-real capability.
--
-- ── FINDING 2 — the narrower one, service_role only. ─────────────────────────
-- Eight tables hold the full ALL set for `service_role` even though their own
-- migration enumerated a NARROW subset. The migration states an intent that the
-- database does not have. Measured, with the intent each file expressed:
--
--   TABLE                             MIGRATION GRANTED        ACTUALLY HELD
--   memory_events                     INSERT,SELECT,DELETE     ALL (8)
--   memory_feedback                   INSERT,SELECT,UPDATE,DEL ALL (8)
--   memory_projections                INSERT,SELECT,UPDATE,DEL ALL (8)
--   memory_policy                     SELECT                   ALL (8)
--   intel_contribution_consent        SELECT,INSERT,UPDATE(+DELETE via 2203)  ALL (8)
--   intel_live_promoted_scopes        SELECT,INSERT,UPDATE,DEL ALL (8)
--   route_flow_contribution_consent   SELECT,INSERT,UPDATE     ALL (8)
--   sensing_anon_contributions        SELECT,INSERT,DELETE     ALL (8)
--
-- The cause is the same in all eight: the file GRANTs without first REVOKEing,
-- so the default-privilege ALL survives underneath and the enumeration is
-- decorative. The canonical pattern that gets this right is
-- 2217_protected_locations.sql:156-161 — REVOKE from service_role FIRST, then
-- grant back. Three of the four Map migrations follow it and land exactly the
-- privileges they name; 2224 does not, and does not.
--
-- Severity is genuinely lower here than for FINDING 1: service_role is the
-- server's own identity, it is BYPASSRLS by design, and it is never held by a
-- client. This is least-privilege hygiene and the closing of a stated-vs-actual
-- gap, not an exposure. It is fixed in the same file because it has the same
-- cause and the same one-line remedy.
--
-- Two of the eight are CONSENT tables (intel_contribution_consent,
-- route_flow_contribution_consent) holding TRUNCATE. A consent record exists to
-- prove that consent was given or withdrawn; a privilege that erases the whole
-- ledger in one statement is the wrong shape for it. route_flow's own
-- CHECK (enabled = false OR evidence present) exists to preserve exactly that
-- evidence.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY EACH GRANTED SET BELOW IS SAFE — CALL SITES READ, NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- Every non-test call site under artifacts/api-server/src was read before
-- narrowing. Nothing below removes a privilege a live path uses.
--
--   memory_events/-_projections/-_feedback: the account-deletion purge does NOT
--     go through service_role grants — AccountDeletionService.ts:1198 calls the
--     SECURITY DEFINER erase_memory_for_user, which runs as its owner. Direct
--     call sites are SELECT (compass.ts:2241,2363) and INSERT (compass.ts:2253,
--     2413,2473; placeIdBridge.ts:313). DELETE stays granted regardless.
--   memory_policy: ZERO non-test call sites in the tree. SELECT only, per 2192.
--   intel_contribution_consent: SELECT (intelConsent.ts:46,69,119 and others)
--     plus DELETE (AccountDeletionService.ts:1139) — 2203 granted that DELETE
--     deliberately, so the set below keeps it.
--   intel_live_promoted_scopes: SELECT only (liveClaimRead.ts:229).
--   route_flow_contribution_consent: SELECT only
--     (mapProjectionTemporal.ts:261).
--   sensing_anon_contributions: INSERT (sensingAnonStore.ts:381) and SELECT
--     (:424). The store is inert by construction; the grant matches 2315.
--
-- The `authenticated` SELECT on the two consent tables is DELIBERATE and is
-- preserved: 2172 and 2224 both grant it so a traveller can read their own
-- consent row under an owner policy.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK: db/rollback/2026-09-07-2333-grant-boundary-rollback.sql
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── FINDING 1: revoke the public/authenticated ALL from derived memory ──────
-- These four have zero RLS policies, so nothing legitimate reaches them as anon
-- or authenticated. Nothing is granted back.

REVOKE ALL ON public.memory_events      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_feedback    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_policy      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_projections FROM PUBLIC, anon, authenticated;

-- ─── FINDING 2: make each service_role grant match its migration's intent ────
-- REVOKE-then-GRANT. The granted set is exactly what the originating migration
-- enumerated (plus 2203's DELETE on intel_contribution_consent).

REVOKE ALL ON public.memory_events FROM service_role;
GRANT INSERT, SELECT, DELETE ON public.memory_events TO service_role;

REVOKE ALL ON public.memory_feedback FROM service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_feedback TO service_role;

REVOKE ALL ON public.memory_projections FROM service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_projections TO service_role;

REVOKE ALL ON public.memory_policy FROM service_role;
GRANT SELECT ON public.memory_policy TO service_role;

REVOKE ALL ON public.intel_contribution_consent FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_contribution_consent TO service_role;

REVOKE ALL ON public.intel_live_promoted_scopes FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_live_promoted_scopes TO service_role;

REVOKE ALL ON public.route_flow_contribution_consent FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.route_flow_contribution_consent TO service_role;

REVOKE ALL ON public.sensing_anon_contributions FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.sensing_anon_contributions TO service_role;

-- ─── preserve the deliberate authenticated SELECT on the two consent tables ──
-- Re-granted AFTER the blanket revokes above so ordering cannot drop them.
GRANT SELECT ON public.intel_contribution_consent      TO authenticated;
GRANT SELECT ON public.route_flow_contribution_consent TO authenticated;

COMMIT;
