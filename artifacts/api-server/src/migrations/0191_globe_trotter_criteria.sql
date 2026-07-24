-- Migration: 0191_globe_trotter_criteria.sql
-- Sets the criteria JSONB on the globe_trotter_5 and globe_trotter_10
-- stamp_definitions rows so the criteria engine can evaluate and award them.
--
-- globe_trotter_5  → countries_visited >= 5
-- globe_trotter_10 → countries_visited >= 10
--
-- Safe to re-run: UPDATE is idempotent (same value written each time).
-- The criteria column has existed since 0179_stamp_criteria_engine.sql.

UPDATE stamp_definitions
SET criteria = '{"version":1,"metric":"countries_visited","gte":5}'::jsonb
WHERE slug = 'globe_trotter_5';

UPDATE stamp_definitions
SET criteria = '{"version":1,"metric":"countries_visited","gte":10}'::jsonb
WHERE slug = 'globe_trotter_10';
