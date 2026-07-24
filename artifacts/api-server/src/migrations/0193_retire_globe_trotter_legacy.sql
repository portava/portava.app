-- Migration: 0191_retire_globe_trotter_legacy.sql
-- Deactivates the unversioned 'globe_trotter' stamp_definitions row so it can
-- never be awarded by the stamp engine, even if old code paths survive.
--
-- The versioned replacements (globe_trotter_5, globe_trotter_10) were inserted
-- in 0189_globe_trotter_stamp_definitions.sql and are already active.
-- The hard-coded locationAwards push in posts.ts was removed alongside this
-- migration; this DB guard prevents any regression from re-enabling it.
--
-- Safe to re-run: UPDATE is idempotent (setting false on an already-false row
-- is a no-op in effect). If the row does not exist the UPDATE silently matches
-- zero rows.

UPDATE stamp_definitions
SET    is_active = false
WHERE  slug = 'globe_trotter';
