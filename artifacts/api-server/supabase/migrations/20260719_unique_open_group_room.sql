-- One open group room per context (Phase 4 concurrent-start guard).
-- Two simultaneous group starts for the same (context_type, context_id) must
-- never fork two rooms: the partial unique index makes the second INSERT fail
-- with 23505, and the calls route then joins the winning room instead
-- (GroupRoomConflictError handling in callStoreAdapter/routes/calls).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_group_room_per_context
  ON call_sessions (context_type, context_id)
  WHERE status IN ('ringing', 'active') AND call_type = 'group_voice';
