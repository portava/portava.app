-- 2113_buddy_bookings_kind_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census + RLS flag — specifically relkind for
--             buddy_bookings)
--
-- ROLLBACK: derivable for the rename-aside branch (rename back, drop the
-- view); the already-a-view branch changes nothing (comment only).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3 OBJECT_KIND_CONFLICT and §7 row 2113.
-- `buddy_bookings` is a base table at `0050_rent_a_buddy.sql:112` AND a view
-- over `rent_buddy_bookings` at `0147_buddy_bookings_compat_view.sql`. 0147's
-- own guard (verified, lines ~9-20) only creates the view when
-- `rent_buddy_bookings` exists as a real relation AND `buddy_bookings` does
-- NOT already exist as a real table — i.e. it deliberately no-ops if the
-- legacy base table is still live. On a canonical-only replay, 0050 runs
-- first (lower prefix) and wins, so the view never materialises and
-- `src/routes/pulse.ts`'s query against `buddy_bookings` sees stale legacy
-- data (or nothing, if 0050 also never ran) rather than the rent_buddy_*
-- data it expects.
--
-- BRANCHES, ON Q1's relkind FOR buddy_bookings AT APPLY TIME
-- ==============================================================
--   relkind = 'r' or 'p' (real table): rename it aside, then create 0147's
--   compat view in its place — this is what 0147's guard was always waiting
--   for and never got, because the legacy table it checks for never went
--   away.
--
--   relkind = 'v' (already a view): comment-only — record that 0147's
--   condition is already satisfied; no rename, no CREATE VIEW.
--
-- WHY RENAME RATHER THAN DROP
-- =============================
-- Rename-aside is reversible and destroys no data (§7 row 2113: "Rename-
-- aside is reversible; no data dropped"). A DROP would be a data-destructive
-- decision this migration does not make.
--
-- INTENDED FINAL STATE
-- =====================
-- `buddy_bookings` is a view over `rent_buddy_bookings`, matching 0147's
-- intended shape. If a rename occurred, the old table survives under
-- `buddy_bookings_legacy_2113`.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.buddy_bookings') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.buddy_bookings does not exist live in either form. Re-derive from Q1.';
  END IF;
  IF to_regclass('public.buddy_bookings_legacy_2113') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.buddy_bookings_legacy_2113 already exists — this migration may have partially run before. Investigate before re-running.';
  END IF;
END $$;

-- ── The change — branches on Q1's relkind at apply time ──────────────────
DO $$
DECLARE
  kind "char";
BEGIN
  SELECT relkind INTO kind FROM pg_class WHERE oid = 'public.buddy_bookings'::regclass;

  IF kind = 'v' THEN
    EXECUTE $c$COMMENT ON VIEW public.buddy_bookings IS
      '2113: confirmed already a view over rent_buddy_bookings at apply time — 0147''s condition was already satisfied, no action taken.'$c$;
    RAISE NOTICE '2113: buddy_bookings is already a view — comment-only branch taken.';
  ELSIF kind IN ('r', 'p') THEN
    IF to_regclass('public.rent_buddy_bookings') IS NULL THEN
      RAISE EXCEPTION '2113: buddy_bookings is a real table but rent_buddy_bookings does not exist live — cannot create the compat view. This contradicts 0147''s own precondition; re-derive from Q1 before proceeding.';
    END IF;

    ALTER TABLE public.buddy_bookings RENAME TO buddy_bookings_legacy_2113;
    COMMENT ON TABLE public.buddy_bookings_legacy_2113 IS
      '2113: renamed aside from buddy_bookings — was a real base table (0050_rent_a_buddy.sql:112) shadowing the compat view 0147 intended to create. Not dropped; superseded by the view of the same original name.';

    EXECUTE $v$
      CREATE VIEW public.buddy_bookings AS
        SELECT id, buddy_id, traveler_id, package_id, trip_id, booking_date,
               start_time, duration_h, group_size, city, category, notes,
               payment_mode, total_usd, deposit_usd, cash_balance_usd,
               status, safety_status, confirmed_at, started_at, completed_at,
               cancelled_at, created_at, updated_at
          FROM public.rent_buddy_bookings
    $v$;
    COMMENT ON VIEW public.buddy_bookings IS
      '2113: created — 0147_buddy_bookings_compat_view.sql''s intended shape, verbatim, now unblocked by renaming the shadowing base table aside.';
    RAISE NOTICE '2113: buddy_bookings was a real table — renamed aside to buddy_bookings_legacy_2113, compat view created.';
  ELSE
    RAISE EXCEPTION '2113: buddy_bookings has unexpected relkind %% — neither table, partition, nor view. Investigate before proceeding.', kind;
  END IF;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  kind "char";
BEGIN
  SELECT relkind INTO kind FROM pg_class WHERE oid = 'public.buddy_bookings'::regclass;
  IF kind <> 'v' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: buddy_bookings is not a view after this migration ran (relkind = %).', kind;
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
-- Already-a-view branch: nothing to roll back.
-- Rename branch:
--   DROP VIEW IF EXISTS public.buddy_bookings;
--   ALTER TABLE public.buddy_bookings_legacy_2113 RENAME TO buddy_bookings;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT relkind FROM pg_class WHERE oid = 'public.buddy_bookings'::regclass; -- expect 'v'
-- SELECT to_regclass('public.buddy_bookings_legacy_2113'); -- non-null only if the rename branch ran
