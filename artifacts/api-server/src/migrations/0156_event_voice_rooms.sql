-- Migration 0156: Event Voice Rooms (calls spec Phase 5)
--
-- Adds the raise-hand state to call participants and the immutable
-- moderation audit log. Rooms themselves reuse the canonical call tables
-- from 0155 (context_type = 'event').

ALTER TABLE call_participants
  ADD COLUMN IF NOT EXISTS hand_raised_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS call_moderation_actions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     uuid        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  actor_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id   uuid        NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action      text        NOT NULL CHECK (action IN ('promote_speaker','demote_speaker','mute','remove','end_room')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_moderation_actions_call
  ON call_moderation_actions (call_id, created_at DESC);
