-- Migration: 20260724_compass_memories
--
-- Phase 6: Layered Compass Memory.
--
-- Structured, durable insight records replacing unbounded raw-chat recall:
--   scope = 'session'   → tied to one conversation (expires with it)
--   scope = 'trip'      → tied to an active trip
--   scope = 'long_term' → durable personal preference
--   scope = 'circle'    → group fact, visible ONLY inside that circle
--                          (circle_owner_id identifies the circle; enforced
--                          by CHECK + membership checks in CompassMemoryService)
--
-- source = 'taught'     → explicit "Teach My Compass" statement
--          'compressed'  → distilled from conversation on a bounded cadence
--          'inferred'    → derived from behaviour signals
--
-- Also adds compass_conversations.compressed_message_count so compression
-- runs on a bounded cadence (every N new messages) instead of every turn.

CREATE TABLE IF NOT EXISTS public.compass_memories (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL,
  scope            TEXT        NOT NULL CHECK (scope IN ('session','trip','long_term','circle')),
  circle_owner_id  UUID,
  trip_id          UUID,
  conversation_id  UUID,
  category         TEXT        NOT NULL DEFAULT 'general',
  content          TEXT        NOT NULL,
  source           TEXT        NOT NULL DEFAULT 'compressed' CHECK (source IN ('taught','compressed','inferred')),
  confidence       REAL        NOT NULL DEFAULT 0.8,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scope <> 'circle' OR circle_owner_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS compass_memories_user_scope_idx
  ON public.compass_memories (user_id, scope, updated_at DESC);

CREATE INDEX IF NOT EXISTS compass_memories_circle_idx
  ON public.compass_memories (circle_owner_id)
  WHERE circle_owner_id IS NOT NULL;

ALTER TABLE public.compass_conversations
  ADD COLUMN IF NOT EXISTS compressed_message_count INT NOT NULL DEFAULT 0;

COMMENT ON TABLE public.compass_memories IS
  'Layered Compass memory (Phase 6): structured durable insights per user, scoped session/trip/long_term/circle.';
COMMENT ON COLUMN public.compass_memories.circle_owner_id IS
  'For scope=circle only: the circle (identified by its owner). Group facts never leave this circle.';
