-- migration: 0102_safe_return_single_session
-- Enforces at the database level that each user can have at most one open
-- (pending or active) Safe Return session at a time.
-- The application layer pre-checks with getActiveSession() for a fast 409
-- response; this index is the concurrency-safe backstop for true race conditions.

CREATE UNIQUE INDEX IF NOT EXISTS safe_return_sessions_one_open_per_user
  ON safe_return_sessions (user_id)
  WHERE status IN ('pending', 'active');
