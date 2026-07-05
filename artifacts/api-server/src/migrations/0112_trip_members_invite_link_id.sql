-- Migration 0112: Add invite_link_id to trip_members
--
-- Why
-- ---
-- The `trip_invite_link_attempts` ledger accurately detects stranded slots via
-- the reconciliation function, but there is no persistent record of which invite
-- link a member used to join a trip.  This column provides that audit trail and
-- enables per-link accounting queries such as:
--   "how many current members joined via link X vs link Y?"
--   "which link was most effective at growing this trip's membership?"
--
-- Design choices
-- --------------
-- • Nullable — existing members who joined before this migration (via direct
--   invite or any other path) keep NULL, which is the correct representation.
-- • ON DELETE SET NULL — if an invite link is deleted its members are NOT
--   removed; the column is simply cleared so the FK constraint is not violated.
-- • Partial index — only indexes non-NULL rows, so the index stays small and
--   cheap to maintain as most historical rows have NULL.
--
-- Secondary signal for reconciliation
-- ------------------------------------
-- After this column is populated, `reconcile_invite_link_slots` could
-- additionally cross-check `use_count` against
--   `COUNT(*) FILTER (WHERE invite_link_id = link.id)`
-- to surface discrepancies even after the attempt ledger is cleaned up.
-- That cross-check is intentionally NOT added here: pre-existing NULL rows
-- would cause the count to under-report and trigger false positives.  The
-- attempt-ledger approach (0110/0111) remains the authoritative mechanism.
-- A future migration can tighten this once legacy NULL rows age out.

ALTER TABLE trip_members
  ADD COLUMN IF NOT EXISTS invite_link_id UUID
    REFERENCES trip_invite_links(id) ON DELETE SET NULL;

-- Partial index for fast per-link membership queries
CREATE INDEX IF NOT EXISTS trip_members_invite_link_id_idx
  ON trip_members(invite_link_id)
  WHERE invite_link_id IS NOT NULL;
