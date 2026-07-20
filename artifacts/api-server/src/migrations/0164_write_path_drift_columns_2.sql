-- 0164: second batch of write-path drift columns — found by the maintained
-- AST-based checker (src/scripts/checkWritePathColumns.ts, task 1939), the
-- committed successor of the one-off task-1925 perl audit.
--
-- One unknown column fails an entire PostgREST insert/update, so each of
-- these breaks its whole write path while missing live:
--   * highlights.filter_id / filter_intensity — written by the save-story-
--     to-highlight insert (POST /stories/:id/save).
--   * highlights.updated_at — written by the appeal-resolution restore.
--   * message_requests.updated_at — written by the block-cleanup cancels.
--   * message_threads.created_by — written by rent-a-buddy booking-thread
--     creation.
--   * moderation_actions.metadata — written by the admin event-moderation
--     audit insert.
--   * plan_attendance_events.metadata — written by geofence attendance
--     audit inserts.
--   * reports.notes — written by the review-report insert.
--   * trip_plan_items.added_by / city / country / description — written by
--     the hidden-gem add-to-plan insert.
--   * user_friendships.accepted_request_id — written by friend-request
--     accept/auto-accept upserts.

ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS filter_id text NOT NULL DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS filter_intensity integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE message_requests
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE message_threads
  ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE moderation_actions
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE plan_attendance_events
  ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE trip_plan_items
  ADD COLUMN IF NOT EXISTS added_by uuid,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE user_friendships
  ADD COLUMN IF NOT EXISTS accepted_request_id uuid;
