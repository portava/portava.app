-- Migration 0147: buddy_bookings compatibility view
-- The rent-a-buddy schema rebuild (0134 legacy chain) replaced the legacy
-- buddy_* tables with rent_buddy_* tables and created compatibility views
-- (buddy_profiles, buddy_availability, buddy_reviews, buddy_booking_requests,
-- etc.) — but never a buddy_bookings view. src/routes/pulse.ts still queries
-- buddy_bookings, which crashes with "relation does not exist" in production.
-- This adds the missing compatibility view over rent_buddy_bookings.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'rent_buddy_bookings'
      AND c.relkind IN ('r', 'p')
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'buddy_bookings'
      AND c.relkind IN ('r', 'p')  -- skip if a real legacy table still exists
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_bookings AS
        SELECT id, buddy_id, traveler_id, package_id, trip_id, booking_date,
               start_time, duration_h, group_size, city, category, notes,
               payment_mode, total_usd, deposit_usd, cash_balance_usd,
               status, safety_status, confirmed_at, started_at, completed_at,
               cancelled_at, created_at, updated_at
        FROM rent_buddy_bookings
    $q$;
  END IF;
END $$;
