-- Ranking config audit log: append-only record of every admin ranking config change.
--
-- Written by PATCH /admin/ranking/config/:key (best-effort — table absence is non-fatal).
-- Provides a trail of who changed what ranking parameter and when.

CREATE TABLE IF NOT EXISTS ranking_config_audit_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key          TEXT        NOT NULL,
  changed_by_user_id  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  old_value           JSONB,
  new_value           JSONB,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ranking_config_audit_log_key_idx
  ON ranking_config_audit_log (config_key, changed_at DESC);

CREATE INDEX IF NOT EXISTS ranking_config_audit_log_user_idx
  ON ranking_config_audit_log (changed_by_user_id);

-- RLS: service role manages writes; no user-facing read policy (admin access via service client).
ALTER TABLE ranking_config_audit_log ENABLE ROW LEVEL SECURITY;
