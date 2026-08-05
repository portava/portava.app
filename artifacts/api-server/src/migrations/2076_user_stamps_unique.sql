-- Renamed from 2072_user_stamps_unique.sql (2026-08-05) to resolve duplicate
-- prefix with 2072_track_profiles_full_name.sql; ALREADY APPLIED to production
-- Supabase under the old name on 2026-08-05 — do not re-apply.
-- 2076_user_stamps_unique.sql (formerly 2072_user_stamps_unique.sql)
--
-- Close the user_stamps double-award race.
--
-- user_stamps (0081_stamp_system_v2.sql) has NO unique index, so two
-- concurrent awardStamp calls for the same (user, definition, source) can both
-- pass the app-level "already earned" select (steps 3–5) and both insert a
-- stamp row. The engine treats a 23505 on this insert as already_earned /
-- already_awarded, so adding the constraint makes the race lose cleanly.
--
-- Step 1 — dedup existing rows so the index can build:
--   a) Non-repeatable definitions (stamp_definitions.is_repeatable = false):
--      keep only the EARLIEST live (non-revoked) stamp per
--      (user_id, stamp_definition_id) — extra rows are the double-awards this
--      migration exists to prevent.
--   b) All definitions: keep only the earliest live stamp per
--      (user_id, stamp_definition_id, source_type, source_id) — safe for
--      repeatable stamps too, since one source event awards at most one stamp
--      (this mirrors the stamp_award_events idempotency key).
--   "Earliest" = min(earned_at, created_at, id).
--
-- Step 2 — unique index on (user_id, stamp_definition_id,
--   COALESCE(source_type,''), COALESCE(source_id::text,'')) WHERE is_revoked
--   = false.
--   * COALESCE: source_type/source_id are nullable and NULLs never collide in
--     a plain unique index — two concurrent source-less awards would both
--     succeed without it.
--   * Partial (live rows only): revoke + re-award legitimately re-inserts the
--     same (user, definition, source) tuple next to the revoked row (the
--     engine's heal path), so revoked rows must not block it.
--   * The per-definition rule for non-repeatable stamps cannot be expressed in
--     an index predicate (it lives in stamp_definitions), so the index
--     enforces the per-source key that is safe for every definition; the
--     app-level check still guards the cross-source non-repeatable case.
--
-- Idempotent: the deletes only ever remove duplicates (no-ops on clean data);
-- the index is IF NOT EXISTS.

-- 1a. Non-repeatable: drop newer live duplicates per (user_id, stamp_definition_id)
WITH ranked AS (
  SELECT us.id,
         row_number() OVER (
           PARTITION BY us.user_id, us.stamp_definition_id
           ORDER BY us.earned_at ASC, us.created_at ASC, us.id ASC
         ) AS rn
  FROM user_stamps us
  JOIN stamp_definitions sd ON sd.id = us.stamp_definition_id
  WHERE us.is_revoked = false
    AND sd.is_repeatable = false
)
DELETE FROM user_stamps
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 1b. All definitions: drop newer live duplicates per full source tuple
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, stamp_definition_id,
                        COALESCE(source_type, ''), COALESCE(source_id::text, '')
           ORDER BY earned_at ASC, created_at ASC, id ASC
         ) AS rn
  FROM user_stamps
  WHERE is_revoked = false
)
DELETE FROM user_stamps
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. Enforce at the DB layer (live rows only)
CREATE UNIQUE INDEX IF NOT EXISTS user_stamps_live_award_unique
  ON user_stamps (
    user_id,
    stamp_definition_id,
    COALESCE(source_type, ''),
    COALESCE(source_id::text, '')
  )
  WHERE is_revoked = false;
