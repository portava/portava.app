-- 3970_trip_private_anchor_shares.sql
--
-- Trips spec §14.1 / §14.4 — "hotel/private anchors (access controlled)" —
-- census-trips TR256, and the owner's decision of 2026-10-04 (Trips, verbatim):
--
--   "Private anchors: Owner-only by default. The owner can share an individual
--    anchor with selected trip members; trip membership or organizer status
--    alone does not grant access."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-05). Its
-- application is the owner's, through the normal reviewed PR and CI path.
--
-- ── WHAT AN ANCHOR IS HERE ─────────────────────────────────────────────────
-- A trip plan item whose `location_is_private` is TRUE: §14.1's private anchor
-- is the item's LOCATION, and `GET /trips/:tripId/map-projection` already puts
-- such items in a layer of their own (`privateAnchors`) and nowhere else
-- (server/trips/readRoutes/tripMapProjection.ts). What it did NOT do is decide
-- who may read that layer: every trip member received every other member's
-- private coordinates. The access rule now lives in
-- domain/trips/policies/privateAnchorAccess.ts and is unconditional — the
-- creator of the item, and nobody else, unless the creator granted it here.
--
-- ── THIS TABLE ─────────────────────────────────────────────────────────────
-- One row per (anchor, member) grant made by the anchor's owner. A missing row
-- is "not shared" — which is exactly what an absent table means too, so the
-- reader treats 42P01 as zero grants (the owner-only default) and every OTHER
-- read error as an unreadable layer, never as an empty one.
--
-- Written only by the API as service_role (routes/tripAnchorShares.ts), after
-- it has checked that the caller created the anchor and that the member is an
-- accepted member of the same trip. RLS is enabled with NO policy and every
-- client privilege is revoked: a client cannot read who an anchor is shared
-- with, nor grant itself one.
--
-- NOT a kernel command, deliberately: a grant is one person's privacy choice
-- about their own location, not Trip aggregate state, and must not bump
-- `trips.version` (the client's concurrency token for the shared plan).
--
-- ── DELETION ───────────────────────────────────────────────────────────────
-- Every row dies with its anchor (plan item), its trip, its owner or its
-- member: four ON DELETE CASCADE foreign keys. Nothing here outlives the
-- account or the location it names.
--
-- ── FLAG ───────────────────────────────────────────────────────────────────
-- `trip_private_anchor_sharing_enabled`, seeded FALSE. OFF / absent /
-- unreadable: no grant can be written and the projection ignores grants, so
-- every anchor is owner-only (the decision's default). A REVOKE is honoured
-- with the flag off — a retraction is never refused.
--
-- Rollback: db/rollback/2026-10-05-3970-trip-private-anchor-shares-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_private_anchor_shares') IS NOT NULL THEN
    RAISE EXCEPTION '3970: trip_private_anchor_shares already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_plan_items') IS NULL OR to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION '3970: trips / trip_plan_items missing';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3970: public.feature_flags does not exist';
  END IF;
END
$pre$;

CREATE TABLE public.trip_private_anchor_shares (
  plan_item_id uuid        NOT NULL REFERENCES public.trip_plan_items(id) ON DELETE CASCADE,
  trip_id      uuid        NOT NULL REFERENCES public.trips(id)           ON DELETE CASCADE,
  owner_id     uuid        NOT NULL REFERENCES auth.users(id)             ON DELETE CASCADE,
  member_id    uuid        NOT NULL REFERENCES auth.users(id)             ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_item_id, member_id),
  CONSTRAINT trip_private_anchor_shares_not_self CHECK (member_id <> owner_id)
);

COMMENT ON TABLE public.trip_private_anchor_shares IS
  'Trips §14.1 private-anchor grants (census-trips TR256; owner decision 2026-10-04: owner-only by default, shareable per anchor to selected trip members). One row = the anchor''s owner let one member see that anchor''s location. Written only by the API as service_role after an owner + membership check; no client privilege; RLS on with no policy.';

CREATE INDEX idx_trip_private_anchor_shares_member ON public.trip_private_anchor_shares (trip_id, member_id);

ALTER TABLE public.trip_private_anchor_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_private_anchor_shares FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.trip_private_anchor_shares TO service_role;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'trip_private_anchor_sharing_enabled',
    false,
    'Trips §14.1 private-anchor sharing (census-trips TR256; owner decision 2026-10-04). ON: an anchor''s owner may grant individual accepted trip members sight of that anchor''s location (routes/tripAnchorShares.ts), and the map projection honours those grants. OFF / absent / unreadable (the seed): no grant can be written and grants are ignored, so every private anchor is visible to its owner only. Revoking a grant works in both states.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_private_anchor_shares') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): trip_private_anchor_shares was not created';
  END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'trip_private_anchor_shares' AND c.relrowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): RLS is not enabled on trip_private_anchor_shares';
  END IF;

  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public.trip_private_anchor_shares'::regclass;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): % polic(ies) on trip_private_anchor_shares; it must have none (service_role only)', n;
  END IF;

  IF has_table_privilege('anon', 'public.trip_private_anchor_shares', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trip_private_anchor_shares', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trip_private_anchor_shares', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trip_private_anchor_shares', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): a client role holds a privilege on trip_private_anchor_shares';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.trip_private_anchor_shares'::regclass AND contype = 'f' AND confdeltype = 'c';
  IF n <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): expected 4 ON DELETE CASCADE foreign keys, found %', n;
  END IF;

  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'trip_private_anchor_sharing_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): trip_private_anchor_sharing_enabled is not present';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'trip_private_anchor_sharing_enabled' AND enabled = TRUE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970): trip_private_anchor_sharing_enabled is ON; it must ship OFF';
  END IF;
END
$post$;
