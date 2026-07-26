-- Admin access log: audits every admin read of a private profile, event, or trip.
--
-- One row per admin API call that fetches private entity data.
-- Fields:
--   admin_id     — the admin's auth.users id
--   record_type  — 'profile' | 'event' | 'trip' | 'gps_event' | 'check_in'
--   record_id    — the specific record id accessed, or 'list' for list queries
--   reason       — value of the X-Admin-Access-Reason request header (may be null)
--   action_taken — 'view' (read) | 'export' | 'expand' (for full-detail endpoints)
--   timestamp    — when the access occurred (default now())

CREATE TABLE IF NOT EXISTS admin_access_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  record_type   text        NOT NULL,
  record_id     text        NOT NULL,
  reason        text,
  action_taken  text        NOT NULL DEFAULT 'view',
  "timestamp"   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT admin_access_log_record_type_check
    CHECK (record_type IN ('profile', 'event', 'trip', 'gps_event', 'check_in')),
  CONSTRAINT admin_access_log_action_taken_check
    CHECK (action_taken IN ('view', 'export', 'expand'))
);

-- Efficient lookup by admin and by time for audit dashboards.
CREATE INDEX IF NOT EXISTS admin_access_log_admin_id_idx
  ON admin_access_log (admin_id);

CREATE INDEX IF NOT EXISTS admin_access_log_timestamp_idx
  ON admin_access_log ("timestamp");

-- RLS: service role can INSERT; no SELECT policy = auditors must use the
-- service role directly (future: add an 'auditor' role policy here).
ALTER TABLE admin_access_log ENABLE ROW LEVEL SECURITY;
