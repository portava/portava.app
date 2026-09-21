-- 2790_trip_absence_guard_flag.sql
--
-- Trips spec §6.3 — the public preview "must not leak future absence from
-- home". census-trips TR119: *"Trip dates are on the public preview by
-- design (`show_exact_dates` toggles precision) — a public trip announces
-- that the owner will be elsewhere on given dates, which is the exact
-- disclosure named. Nothing guards it."*
--
-- Seeds `trip_absence_guard_enabled` FALSE — the gate for
-- lib/privacy/absenceDisclosure.ts, which withholds a FUTURE trip's dates
-- from non-members on the §6.3 preview while it is on. `show_exact_dates`
-- defaults TRUE (0077) and the client sends it as true when unset, so the
-- toggle cannot tell "opted in" from "never asked"; the guard therefore
-- withholds future dates regardless of it and says so on the wire
-- (`datesWithheld: "future_absence"`). Past and current trips keep the
-- toggle's behaviour: a trip already underway is not a future absence.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING. Nothing else changes, and
-- with the flag FALSE the preview is byte-for-byte what it was. Turning it
-- on is the owner's call (docs/architecture/manual-production-migration-runbook.md).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'show_exact_dates') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips.show_exact_dates (0077) does not exist — the guard composes with it.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('trip_absence_guard_enabled', false,
   'Trips §6.3: the public preview withholds a FUTURE trip''s dates from non-members (datesWithheld: future_absence) so a public trip does not announce when the host is away from home. Composes with show_exact_dates for past and current trips. Seeded FALSE by 2790; the preview is unchanged until it is on.')
ON CONFLICT (flag) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_absence_guard_enabled') THEN
    RAISE EXCEPTION '2790: trip_absence_guard_enabled was not seeded';
  END IF;
END $$;

COMMIT;
