-- 2105_circles_dangling_reference_resolution.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census + RLS flag — pg_class.relkind,
--             relrowsecurity; schemas public, storage)
--
-- Q1 is the highest-priority existence check in the whole packet for this
-- item (RECONCILIATION-PACKET.md §4.3, DANGLING_REFERENCE row): does
-- `public.circles` exist live at all? This file is written as a single
-- runtime branch on that answer rather than two separate files, because the
-- branch condition (table exists or not) is exactly what the live catalog
-- tells us at apply time — Q1's answer and this file's precondition check
-- are the same query.
--
-- ROLLBACK: derivable for the DROP-branch (re-adding a FK constraint is a
-- normal, reversible DDL op); the ADOPT-branch changes nothing executable at
-- all (comment only).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §3.2(e), §4.3 DANGLING_REFERENCE, §7 row 2105.
--
-- `artifacts/api-server/src/migrations/0058_trip_flow.sql:13` declares, on
-- the `route_plans` table:
--   circle_id uuid NULL REFERENCES circles(id) ON DELETE SET NULL
-- No `.sql` file anywhere in this repository creates `circles` (verified:
-- zero matches for CREATE TABLE (IF NOT EXISTS )?circles, word-bounded, so
-- circle_invites/circle_memberships are correctly excluded). A clean rebuild
-- from canonical alone aborts at this line today.
--
-- REAL TRAFFIC BEHIND THIS, NOT JUST A DANGLING REFERENCE
-- ==========================================================
-- `travel-buddy-standalone/src/services/circles.ts:25` reads the table
-- directly:
--   const { data, error } = await supabase.from('circles')
--     .select('id, name, owner_id').order('name', { ascending: true });
-- (function `getMyCircles`, comment at line 20: "RLS on the circles table
-- filters to rows the user can see.") This is a live client read path, not
-- dead code exercising a reference nobody uses. That changes what each
-- branch of this migration means:
--
--   IF Q1 confirms `circles` IS live: the FK reference was always sound —
--   this migration is comment-only, adopting the table into the baseline
--   with provenance NONE (nothing in the repo created it; it must have been
--   created directly against the database, or by a file this audit cannot
--   see). getMyCircles() has a real table to read from. No DDL runs.
--
--   IF Q1 confirms `circles` is ABSENT: the FK is dangling as the packet
--   says, AND `getMyCircles()` is a live client code path querying a table
--   that does not exist — every call to it is failing in production right
--   now with a Postgres "relation does not exist" error (or, if PostgREST
--   fronts it, a 404/schema-cache error), not a hypothetical. Dropping the
--   FK constraint fixes the clean-build/audit problem; it does NOT fix the
--   client outage, which is a separate, real bug this migration does not
--   and cannot address (it needs either the client path removed or a
--   `circles` table actually created, both product decisions outside a
--   reconciliation migration's scope). Flagging this explicitly so the
--   absent-branch is not read as "safe, nothing to see" — it means the
--   opposite: an already-broken read path just became explained.
--
-- WHY THIS IS SAFE TO WRITE (BUT NOT YET SAFE TO RUN)
-- =====================================================
-- Dropping a constraint whose target does not exist cannot break a working
-- write path — if `circles` is absent, no INSERT into route_plans.circle_id
-- referencing a real circles row could ever have succeeded anyway. The
-- adopt-branch performs no DDL at all.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.route_plans') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.route_plans does not exist live. This migration assumes the table from 0058_trip_flow.sql is live; re-derive from Q1.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'route_plans' AND column_name = 'circle_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: route_plans.circle_id does not exist live.';
  END IF;
END $$;

-- ── The change — branches on Q1's answer at apply time ──────────────────
DO $$
DECLARE
  fk_name text;
BEGIN
  IF to_regclass('public.circles') IS NOT NULL THEN
    -- ADOPT branch: circles exists live. No DDL. Comment only.
    EXECUTE $c$COMMENT ON COLUMN public.route_plans.circle_id IS
      'circles is live (confirmed at apply time, 2105) though no .sql file in this repository creates it — adopted into the baseline with provenance NONE per RECONCILIATION-PACKET.md §4.3. FK to circles(id) is sound.'$c$;
    RAISE NOTICE '2105: circles exists live — adopt branch taken, no DDL applied.';
  ELSE
    -- DROP branch: circles is absent live. Drop the dangling FK by its
    -- actual live name (looked up rather than assumed, since 0058 used an
    -- inline REFERENCES with no explicit CONSTRAINT name).
    SELECT conname INTO fk_name
      FROM pg_constraint
     WHERE conrelid = 'public.route_plans'::regclass
       AND contype = 'f'
       AND conkey = ARRAY[(
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.route_plans'::regclass AND attname = 'circle_id'
       )];

    IF fk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.route_plans DROP CONSTRAINT %I', fk_name);
    END IF;

    COMMENT ON COLUMN public.route_plans.circle_id IS
      'Vestigial 2105 — circles confirmed absent live at apply time. FK constraint dropped (was dangling, referenced a table nothing creates). Column retained, now unconstrained, since existing values may still carry meaning to travel-buddy-standalone/src/services/circles.ts, which reads circles directly and is a SEPARATE, real outage this migration does not fix.';
    RAISE NOTICE '2105: circles absent live — drop branch taken, dangling FK removed.';
  END IF;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.circles') IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.route_plans'::regclass
         AND contype = 'f'
         AND confrelid = 'public.circles'::regclass
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: circles is absent but route_plans still carries a FK naming it.';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Adopt branch: nothing to roll back (comment only).
-- Drop branch: re-add the FK, but only if a `circles` table is later
-- created with a compatible `id` column:
--   ALTER TABLE public.route_plans
--     ADD CONSTRAINT route_plans_circle_id_fkey
--     FOREIGN KEY (circle_id) REFERENCES public.circles(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT to_regclass('public.circles') IS NOT NULL AS circles_live;
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'public.route_plans'::regclass AND contype = 'f'
--    AND confrelid = 'public.circles'::regclass;
-- -- Adopt branch: expect one row. Drop branch: expect zero rows.
-- -- If drop branch was taken, separately confirm whether
-- -- travel-buddy-standalone's getMyCircles() call path is still reachable
-- -- from the client, and treat that as its own incident if so — this
-- -- migration explains the outage, it does not resolve it.
