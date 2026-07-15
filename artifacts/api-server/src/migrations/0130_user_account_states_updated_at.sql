-- 0130_user_account_states_updated_at.sql
-- POST /api/me/deactivate (and reactivate) upsert `updated_at` on
-- user_account_states, but migration 0063 created the table without that
-- column, so every deactivate failed with PGRST204. Add it.
ALTER TABLE user_account_states
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
