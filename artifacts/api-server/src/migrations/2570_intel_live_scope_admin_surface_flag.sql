-- 2570_intel_live_scope_admin_surface_flag.sql
--
-- Seeds the ONE flag behind the intel live-scope operator surface —
-- routes/admin.ts `GET/POST /admin/intel/live-scopes*` — FALSE. Intel-ops-owned.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2570
-- (intel ops). Additive + idempotent. Safe to re-run.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE TWO REASONS LIVE CLAIMS RETURN NOTHING — KEPT APART, ON PURPOSE
-- ══════════════════════════════════════════════════════════════════════════════
-- Measured on production (ajrurzioarfkagpuxfnb) 2026-09-07:
--   geo_zones 0 rows, intel_observations 0, intel_claims 0,
--   intel_live_promoted_scopes 0; intel_limited_live, intel_live_label_crowd,
--   intel_claim_projection_crowd all TRUE; intel_live_scope_promotion_enabled
--   has NO ROW; 2430 unapplied (the table carries 2179's six columns only).
-- So readLiveClaims answers [] for two INDEPENDENT reasons:
--   MISSING DATA              the spine is empty at every stage. No zone, so no
--                             well-formed scope to name; no claims, so nothing
--                             a promoted scope could serve.
--   MISSING OPERATOR SURFACE  promoteLiveScope / withdrawLiveScope in
--                             lib/intelLiveScopePromotion.ts had no caller
--                             anywhere. Only the expiry sweep was wired.
-- This migration and the routes it gates address the SECOND only. They change
-- nothing a user sees, because the first still holds; do not read this file as
-- unblocking Live.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A SECOND FLAG, NOT 2430'S
-- ══════════════════════════════════════════════════════════════════════════════
-- 2430 seeds intel_live_scope_promotion_enabled: "the WRITER may write". It
-- also gates the expiry sweep lib/intelPromotionScheduler.ts runs on its own
-- tick. This file seeds intel_live_scope_admin_surface_enabled: "the HTTP
-- surface is exposed". They are separate because:
--   1. 2430 is not applied to production (or portava-ci). A seed that must be
--      applicable to production as it is cannot depend on 2430, and seeding
--      2430's flag from here would make two migrations the provenance of one
--      row and let the surface open on a database whose writer functions do
--      not exist.
--   2. Closing the surface must not stop the expiry sweep, and stopping the
--      writer (an incident lever) must not hide the list/inspect reads.
-- A write through the surface therefore needs BOTH flags ON (in series);
-- list/inspect need only this one. Both read fail-closed. The routes read
-- 2430's flag as a ROW so an operator is told "no row — apply 2430" rather
-- than the indistinguishable "disabled".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL THE FLAG IS FLIPPED — AND
-- NOTHING FOR A USER EVEN THEN
-- ══════════════════════════════════════════════════════════════════════════════
-- One flag row. FALSE / absent / unreadable: every route in the section
-- answers 404 feature_disabled after requireAdmin and issues no other read.
-- TRUE on a pre-2430 database (production and portava-ci today): list/inspect
-- answer 503 server_not_configured naming 2430 (their select names the 2430
-- columns and 42703s); promote/withdraw answer 503 naming 2430 at the writer
-- flag gate (no row). TRUE on a post-2430 database with the writer flag ON:
-- an admin can promote, withdraw, list, inspect. No serve-path reader is
-- changed by this file; the allowlist is written only by 2430's functions,
-- only on an admin's request. Nothing here promotes a scope.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * Does not require 2430. Precondition is feature_flags + the 2179 table.
--     2430 absent is a NOTICE, and the postcondition then insists the flag is
--     FALSE (a surface that can only answer 503 must not be advertised ON).
--   * Does not create a table, function, policy or grant.
--   * Does not promote, withdraw or touch any intel_live_promoted_scopes row;
--     the postcondition counts the table before and after and refuses a change.
--
-- Rollback: db/rollback/2026-09-07-2570-intel-live-scope-admin-surface-rollback.sql
-- RUNTIME EFFECT: NONE with the flag absent or false.

BEGIN;

-- ── 0. Preconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  n_cols integer;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regclass('public.intel_live_promoted_scopes') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_live_promoted_scopes (2179) does not exist; there is no allowlist for the surface to operate on.';
  END IF;
  -- NOTE, not a failure: the routes need 2430's functions and columns to do
  -- anything but say so. Absent here means "seed FALSE, and keep it FALSE
  -- until 2430 lands".
  SELECT count(*) INTO n_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'intel_live_promoted_scopes'
     AND column_name IN ('expires_at','withdrawn_at','withdrawn_by','withdrawn_reason','promoted_via','evidence','updated_at');
  IF n_cols <> 7
     OR to_regprocedure('public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz)') IS NULL
     OR to_regprocedure('public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz)') IS NULL THEN
    RAISE NOTICE '2570: migration 2430 is NOT applied on this database (% of 7 provenance columns; writer functions may be missing). intel_live_scope_admin_surface_enabled is seeded FALSE and MUST stay FALSE here until 2430 is applied; ON would expose four admin routes that can only answer 503.', n_cols;
  END IF;
END $$;

-- Row count of the allowlist, captured before the seed so the postcondition
-- can prove this file wrote nothing there.
CREATE TEMP TABLE _m2570_before ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM public.intel_live_promoted_scopes) AS scope_rows;

-- ── 1. Flag, seeded FALSE ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('intel_live_scope_admin_surface_enabled', false,
   'CAPABILITY. Exposes the intel live-scope operator surface in routes/admin.ts (GET /admin/intel/live-scopes, GET /admin/intel/live-scopes/:scopeKey, POST /admin/intel/live-scopes/promote, POST /admin/intel/live-scopes/withdraw): admin-only, list/inspect/promote/withdraw of the IG-09 per-scope Live allowlist through lib/intelLiveScopePromotion.ts and 2430''s service functions. Writes ALSO require intel_live_scope_promotion_enabled (2430) ON. FALSE / absent / unreadable (the seed): every route answers 404 feature_disabled after the admin check and reads nothing else. ON without 2430 applied: 503 naming 2430, never an empty success. Flipping it promotes NOTHING; a promotion is a human decision recorded with evidence and a review horizon. Read fail-closed. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

-- ── 2. Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  present     integer;
  on_count    integer;
  has_2430    boolean;
  rows_before bigint;
  rows_after  bigint;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'intel_live_scope_admin_surface_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly one intel_live_scope_admin_surface_enabled row, found %', present;
  END IF;

  SELECT (
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'intel_live_promoted_scopes'
          AND column_name IN ('expires_at','withdrawn_at','withdrawn_by','withdrawn_reason','promoted_via','evidence','updated_at')) = 7
      AND to_regprocedure('public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz)') IS NOT NULL
      AND to_regprocedure('public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz)') IS NOT NULL
    ) INTO has_2430;

  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'intel_live_scope_admin_surface_enabled' AND enabled = TRUE;

  -- The seed is FALSE. A re-run keeps an existing row (ON CONFLICT DO NOTHING),
  -- so the value may legitimately be TRUE where an owner flipped it — but ONLY
  -- where 2430 exists. TRUE without 2430 advertises a surface that can only
  -- answer 503 and is refused here, loudly.
  IF on_count <> 0 AND NOT has_2430 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_live_scope_admin_surface_enabled is TRUE but migration 2430 is not applied — every live-scope admin route answers 503 in this state. Set it FALSE or apply 2430.';
  END IF;
  IF on_count <> 0 THEN
    RAISE NOTICE '2570: intel_live_scope_admin_surface_enabled was already TRUE on this database (re-run); left as found because 2430 is applied.';
  END IF;

  -- Non-vacuous on a database WITH 2430: the surface's writes go through the
  -- two functions and must reach them as service_role and NEVER as a client
  -- role. That is 2430's posture; it is re-asserted here because this file is
  -- what makes the functions reachable from an HTTP request.
  IF has_2430 THEN
    IF NOT has_function_privilege('service_role', 'public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot EXECUTE the 2430 writer functions; the admin surface would 42501 on every write.';
    END IF;
    IF has_function_privilege('anon', 'public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can EXECUTE a 2430 writer function; the admin route would not be the only way in.';
    END IF;
  END IF;

  -- This file promotes nothing: the allowlist has exactly the rows it had.
  SELECT scope_rows INTO rows_before FROM _m2570_before;
  SELECT count(*) INTO rows_after FROM public.intel_live_promoted_scopes;
  IF rows_before <> rows_after THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_live_promoted_scopes changed from % to % rows during 2570; this file must not touch the allowlist.', rows_before, rows_after;
  END IF;
END $$;

COMMIT;
