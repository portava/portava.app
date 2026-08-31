-- 2212_rent_buddy_country_snapshot.sql
--
-- Snapshot the governing SERVICE COUNTRY on Rent-a-Buddy bookings and requests.
--
-- The booking-creation safety gate resolves launch-controls and city/category
-- restrictions by (country -> city -> category). That country is derived
-- server-side from the buddy being booked (their registered `country`), and it
-- must be FROZEN at creation time: once a booking (or an open request) is
-- created, a later edit to the buddy's registered location must NOT retroactively
-- change which policy applied. Persisting the country onto the row is what makes
-- that snapshot durable, and lets offer-accept read the request's frozen country
-- as authoritative.
--
--   * rent_buddy_bookings.country_code  — already added by migration 0163
--     (written by the rebook insert). Re-asserted here with IF NOT EXISTS so this
--     migration is a single idempotent source of truth for the snapshot columns.
--   * rent_buddy_requests.country_code  — NEW. offer-accept reads it as the
--     authoritative governing country for the marketplace request -> offer ->
--     accept flow.
--
-- Both are plain nullable text (same free-text country convention the launch
-- controls and buddy profiles already match on by exact equality). No new grants
-- are required: ADD COLUMN inherits the table's existing grants, matching the
-- neighbouring 0163 column addition.
--
-- Idempotent and safe to re-run.

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS country_code text;

ALTER TABLE rent_buddy_requests
  ADD COLUMN IF NOT EXISTS country_code text;
