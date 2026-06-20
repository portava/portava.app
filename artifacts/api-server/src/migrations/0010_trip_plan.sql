-- Migration: trip_plan_items
-- Run manually against Supabase SQL editor.
-- Direction: up only. To roll back, drop the table and index.

CREATE TABLE IF NOT EXISTS trip_plan_items (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  creator_id     uuid        NOT NULL REFERENCES auth.users(id),
  title          text        NOT NULL,
  category       text        NOT NULL DEFAULT 'activity',
  -- 'accommodation' | 'activity' | 'dining' | 'transport' | 'free_time' | 'meeting_point' | 'other'
  status         text        NOT NULL DEFAULT 'tentative',
  -- 'confirmed' | 'tentative' | 'done' | 'cancelled'
  source_type    text        NOT NULL DEFAULT 'manual',
  -- 'manual' | 'place' | 'meetup'
  source_id      text        NULL,
  -- external reference ID for place/meetup sourced items
  day_date       date        NULL,
  -- which trip day this item falls on (null = unscheduled)
  starts_at      timestamptz NULL,
  ends_at        timestamptz NULL,
  location_name  text        NULL,
  -- public-safe label only — no GPS coordinates stored
  notes          text        NULL,
  sort_order     integer     NOT NULL DEFAULT 0,
  visibility     text        NOT NULL DEFAULT 'members',
  -- 'members' | 'public'
  removed_at     timestamptz NULL,
  -- soft-delete sentinel; non-null = hidden
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Prevent duplicate place/meetup items per trip.
-- Partial index: only enforces when source_id IS NOT NULL and item is not removed.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_items_source_uniq
  ON trip_plan_items (trip_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND removed_at IS NULL;

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE trip_plan_items ENABLE ROW LEVEL SECURITY;

-- Accepted trip members (owner or member role) can read non-removed items.
CREATE POLICY "plan_items_select" ON trip_plan_items
  FOR SELECT USING (
    removed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = trip_plan_items.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- Accepted members can insert; creator_id must equal their own user id.
CREATE POLICY "plan_items_insert" ON trip_plan_items
  FOR INSERT WITH CHECK (
    creator_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = trip_plan_items.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- Owner can update any item; member can only update their own.
CREATE POLICY "plan_items_update" ON trip_plan_items
  FOR UPDATE USING (
    creator_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = trip_plan_items.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role = 'owner'
    )
  );
