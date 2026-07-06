-- Migration 0118: Feature flag audit log
-- Records every toggle of a feature flag: who changed it, from what value, and when.
-- Enables the GET /admin/feature-flags/:flag/history endpoint and "last changed by"
-- display on the admin Feature Flags screen.

CREATE TABLE IF NOT EXISTS feature_flag_audit_log (
  id                  BIGSERIAL   PRIMARY KEY,
  flag                TEXT        NOT NULL REFERENCES feature_flags(flag) ON DELETE CASCADE,
  changed_by_user_id  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  old_enabled         BOOLEAN     NOT NULL,
  new_enabled         BOOLEAN     NOT NULL,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ffa_log_flag_at ON feature_flag_audit_log(flag, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ffa_log_user    ON feature_flag_audit_log(changed_by_user_id);

ALTER TABLE feature_flag_audit_log ENABLE ROW LEVEL SECURITY;
-- No public policies — all reads/writes are performed by the API server's service-role key.
