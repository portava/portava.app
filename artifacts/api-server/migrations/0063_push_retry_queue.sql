-- Migration 0063: push_retry_queue
-- Persists failed push notifications so the server can retry them with
-- exponential backoff after network errors or 5xx responses from Expo.
-- Safe to re-run: uses IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS push_retry_queue (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id      UUID        REFERENCES notifications(id) ON DELETE SET NULL,
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tokens               TEXT[]      NOT NULL,
  payload              JSONB       NOT NULL,
  attempt_count        INT         NOT NULL DEFAULT 1,
  max_attempts         INT         NOT NULL DEFAULT 3,
  next_retry_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error           TEXT,
  status               TEXT        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','sent','failed')),
  delivery_attempt_id  UUID        REFERENCES notification_delivery_attempts(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prq_status_next_retry_idx
  ON push_retry_queue (status, next_retry_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS prq_user_idx ON push_retry_queue (user_id);

-- Service-role only: no user-facing RLS policies needed.
-- The retry worker runs with the service role client.
ALTER TABLE push_retry_queue ENABLE ROW LEVEL SECURITY;
