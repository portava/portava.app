-- Rollback for 2333_derived_memory_and_consent_grant_boundary.sql
-- Applied to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07. NOT applied to
-- production (ajrurzioarfkagpuxfnb) — that remains an owner decision.
--
-- WHAT 2333 DID
-- =============
-- Privilege-only. Two independent changes, and you can undo either alone:
--   FINDING 1  revoked the full ALL set from `anon` and `authenticated` on the
--              four derived-memory tables.
--   FINDING 2  made eight service_role grants match what their own migration
--              enumerated, by adding the REVOKE those files omitted.
--
-- READ THIS BEFORE RUNNING SECTION 1
-- ==================================
-- Section 1 RE-GRANTS THE FULL PRIVILEGE SET TO `anon` — the unauthenticated
-- public role — on four tables of derived memory about real users. That is the
-- defect 2333 fixed, restored on purpose.
--
-- It is offered because a rollback that cannot reach the prior state is not a
-- rollback, and because if some path I did not find DOES depend on those grants,
-- an operator needs a way back. But it is not symmetric with section 2 in risk,
-- and it should not be run to "undo 2333" as a whole. If something broke after
-- 2333, it is far likelier to be section 2 (a narrowed service_role) than
-- section 1 (a role that RLS already denies with zero policies).
--
-- Diagnose first: if the failing caller authenticates with the service key, you
-- want section 2. If it uses the anon or an end-user key against memory_*, note
-- that RLS has ZERO policies on all four tables, so it was already being denied
-- every row before 2333 — the grant was not what made it work, and restoring the
-- grant will not make it work.

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — restore anon/authenticated ALL on the derived-memory tables
-- ⚠ RE-OPENS THE FINDING. See the warning above. Run only with intent.
-- ═════════════════════════════════════════════════════════════════════════════
-- BEGIN;
--
-- GRANT ALL ON public.memory_events      TO anon, authenticated;
-- GRANT ALL ON public.memory_feedback    TO anon, authenticated;
-- GRANT ALL ON public.memory_policy      TO anon, authenticated;
-- GRANT ALL ON public.memory_projections TO anon, authenticated;
--
-- COMMIT;
--
-- (Left commented deliberately. Uncomment the block to run it. A rollback that
--  re-grants the public role write access to user data should cost one
--  deliberate edit, not one careless paste.)

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — restore the pre-2333 service_role privileges
-- Safe and symmetric: puts back the default-privilege ALL that each table
-- carried before 2333. This is the section you want if a server path broke.
-- Idempotent.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

GRANT ALL ON public.memory_events                   TO service_role;
GRANT ALL ON public.memory_feedback                 TO service_role;
GRANT ALL ON public.memory_projections              TO service_role;
GRANT ALL ON public.memory_policy                   TO service_role;
GRANT ALL ON public.intel_contribution_consent      TO service_role;
GRANT ALL ON public.intel_live_promoted_scopes      TO service_role;
GRANT ALL ON public.route_flow_contribution_consent TO service_role;
GRANT ALL ON public.sensing_anon_contributions      TO service_role;

-- Preserved by 2333 and preserved here; restated so this section is complete
-- on its own if section 1 is never run.
GRANT SELECT ON public.intel_contribution_consent      TO authenticated;
GRANT SELECT ON public.route_flow_contribution_consent TO authenticated;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY (either direction)
-- ═════════════════════════════════════════════════════════════════════════════
-- select c.relname, pg_get_userbyid(a.grantee) as role,
--        string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
-- from pg_class c
-- join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
-- cross join lateral aclexplode(c.relacl) a
-- where c.relname in ('memory_policy','intel_contribution_consent',
--   'intel_live_promoted_scopes','memory_events','memory_feedback',
--   'memory_projections','route_flow_contribution_consent',
--   'sensing_anon_contributions')
--   and pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role')
-- group by 1,2 order by 1,2;
--
-- Post-2333 (measured on portava-ci, 2026-09-07): no anon row on any of the
-- eight; authenticated SELECT on the two consent tables only; and service_role
-- holding exactly INSERT,SELECT,DELETE / +UPDATE / SELECT / etc. per table.
