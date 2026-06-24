-- Migration: 0048_age_audit_log.sql
-- Append-only audit log for age-limit changes and eligibility-block events.
-- Service role writes only; no direct user insert/update/delete.

CREATE TABLE IF NOT EXISTS age_limit_audit_log (
  id              uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   uuid      REFERENCES profiles(id) ON DELETE SET NULL,
  target_type     text      NOT NULL CHECK (target_type IN ('meetup','circle','user')),
  target_id       text      NOT NULL,
  action          text      NOT NULL,
  old_min_age     integer,
  old_max_age     integer,
  new_min_age     integer,
  new_max_age     integer,
  reason          text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE age_limit_audit_log ENABLE ROW LEVEL SECURITY;

-- No user-facing read/write policies — service role manages all writes.
-- Hosts may read audit rows where they are the actor (optional future extension).
CREATE POLICY "actors_read_own_audit_rows" ON age_limit_audit_log
  FOR SELECT USING (auth.uid() = actor_user_id);
