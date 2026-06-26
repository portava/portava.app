-- Migration: trip_flow (route_plans, route_stops, route_legs)
-- Direction: up only. Run against Supabase SQL editor.

-- ── route_plans ───────────────────────────────────────────────────────────────

CREATE TYPE route_style AS ENUM ('nightlife', 'scenic', 'foodie', 'low_walking', 'custom');
CREATE TYPE route_plan_status AS ENUM ('draft', 'active', 'completed', 'cancelled');

CREATE TABLE IF NOT EXISTS route_plans (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trip_id           uuid        NULL REFERENCES trips(id) ON DELETE SET NULL,
  title             text        NOT NULL DEFAULT 'My Route',
  start_location    jsonb       NULL,
  -- { label: string, lat: number, lng: number }
  end_location      jsonb       NULL,
  route_style       route_style NOT NULL DEFAULT 'custom',
  status            route_plan_status NOT NULL DEFAULT 'draft',
  compass_explanation text      NULL,
  -- cached Compass pipeline output explaining stop order
  is_approximated   boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE route_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "route_plans_owner_select" ON route_plans
  FOR SELECT USING (owner_user_id = auth.uid());

CREATE POLICY "route_plans_member_select" ON route_plans
  FOR SELECT USING (
    trip_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = route_plans.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

CREATE POLICY "route_plans_owner_insert" ON route_plans
  FOR INSERT WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY "route_plans_owner_update" ON route_plans
  FOR UPDATE USING (owner_user_id = auth.uid());

CREATE POLICY "route_plans_owner_delete" ON route_plans
  FOR DELETE USING (owner_user_id = auth.uid());

-- ── route_stops ───────────────────────────────────────────────────────────────

CREATE TYPE checkpoint_status AS ENUM ('pending', 'arrived', 'skipped', 'cancelled');
CREATE TYPE stop_source_type AS ENUM ('manual', 'place', 'meetup', 'hidden_gem', 'discovery', 'plan_item');

CREATE TABLE IF NOT EXISTS route_stops (
  id                    uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  route_plan_id         uuid              NOT NULL REFERENCES route_plans(id) ON DELETE CASCADE,
  source_type           stop_source_type  NOT NULL DEFAULT 'manual',
  source_id             text              NULL,
  title                 text              NOT NULL,
  structured_location   jsonb             NOT NULL DEFAULT '{}',
  -- { label: string, lat: number, lng: number, address?: string }
  order_index           integer           NOT NULL DEFAULT 0,
  planned_arrival_time  timestamptz       NULL,
  planned_departure_time timestamptz      NULL,
  checkpoint_status     checkpoint_status NOT NULL DEFAULT 'pending',
  arrived_at            timestamptz       NULL,
  notes                 text              NULL,
  created_at            timestamptz       NOT NULL DEFAULT now(),
  updated_at            timestamptz       NOT NULL DEFAULT now()
);

ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "route_stops_owner_all" ON route_stops
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM route_plans rp
      WHERE rp.id = route_stops.route_plan_id
        AND rp.owner_user_id = auth.uid()
    )
  );

CREATE POLICY "route_stops_member_select" ON route_stops
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM route_plans rp
      JOIN trip_members tm ON tm.trip_id = rp.trip_id
      WHERE rp.id = route_stops.route_plan_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
        AND rp.trip_id IS NOT NULL
    )
  );

-- ── route_legs ────────────────────────────────────────────────────────────────

CREATE TYPE transport_mode AS ENUM ('walk', 'rideshare', 'transit', 'bike', 'drive');

CREATE TABLE IF NOT EXISTS route_legs (
  id               uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  route_plan_id    uuid           NOT NULL REFERENCES route_plans(id) ON DELETE CASCADE,
  from_stop_id     uuid           NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
  to_stop_id       uuid           NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
  distance_meters  integer        NOT NULL DEFAULT 0,
  duration_seconds integer        NOT NULL DEFAULT 0,
  mode             transport_mode NOT NULL DEFAULT 'walk',
  provider         text           NULL DEFAULT 'approximated',
  polyline         text           NULL,
  safety_notes     text           NULL,
  is_approximated  boolean        NOT NULL DEFAULT true,
  created_at       timestamptz    NOT NULL DEFAULT now()
);

ALTER TABLE route_legs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "route_legs_owner_all" ON route_legs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM route_plans rp
      WHERE rp.id = route_legs.route_plan_id
        AND rp.owner_user_id = auth.uid()
    )
  );

CREATE POLICY "route_legs_member_select" ON route_legs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM route_plans rp
      JOIN trip_members tm ON tm.trip_id = rp.trip_id
      WHERE rp.id = route_legs.route_plan_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
        AND rp.trip_id IS NOT NULL
    )
  );

-- ── Extend trip_plan_items with optional route link ───────────────────────────

ALTER TABLE trip_plan_items
  ADD COLUMN IF NOT EXISTS route_stop_id uuid NULL REFERENCES route_stops(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS trip_plan_items_route_stop_idx
  ON trip_plan_items (route_stop_id)
  WHERE route_stop_id IS NOT NULL;
