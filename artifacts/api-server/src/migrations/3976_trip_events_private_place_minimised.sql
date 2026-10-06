-- 3976_trip_events_private_place_minimised.sql
--
-- census-trips §85 (verifier R1 on 87df318f4) and lead ruling D-65 (2026-10-06):
-- "Owner-only covers the place's location and also its name, title, notes,
-- description, place and source identifiers, and any text derived from them:
-- event payloads, caches, offline bundles, daily briefs, plan lists, Telegraph
-- trip context, Today."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-06). Its
-- application is the owner's. Needs 2420 (trip_events), 2763/2773
-- (trip_snapshots and the fold) and 3972 (the owner-only plan-item policy).
--
-- WHAT WAS OPEN
-- =============
-- The kernel writes every command's input and result into trip_events, minus
-- only lat/lng (2590: "no coordinates ... in the crew-readable event"). So a
-- private plan item's title, location_name, notes, description, place and
-- source ids, city and country sat in an event that 2420's
-- `trip_events_crew_select` (authz.is_trip_crew) let EVERY accepted member read
-- straight through PostgREST — the door 3972 closed on trip_plan_items, open
-- one table over. The same text was then PROJECTED: the snapshot fold (2773)
-- copies a plan event's `title` into trip_snapshots, which every crew member
-- reads (2763's trip_snapshots_select_crew, and GET /trips/:id/snapshots/:v).
-- 3974's restore event also carried the admin's free-text `reason` and the
-- appeal id.
--
-- THE TWO LAYERS THIS CLOSES
-- ==========================
-- 1. THE DOOR. No client reads trip_events (measured: no `.from('trip_events')`
--    in travel-buddy-standalone or any other package; every server reader runs
--    as service_role). The crew policy and the authenticated SELECT grant are
--    withdrawn. trip_snapshots keeps its crew policy: it is what the API serves.
-- 2. WHAT IS STORED, and so what is projected. A BEFORE INSERT trigger removes
--    the naming and locating keys from a plan-family event (`payload`,
--    `result`, and `payload.patch`) unless the item is KNOWN public right now
--    (`trip_plan_items.location_is_private = false`). Unknown — no item id, an
--    item that is gone, a NULL — is treated as private, the same fail-closed
--    rule domain/trips/policies/privateAnchorAccess.ts applies. A restore
--    event (`payload.via = 'admin_restore'`) loses `reason` and `appeal_id`;
--    the appeal itself keeps both, and trip_members.permissions keeps the
--    appeal id the restore came from.
--    A PUBLIC item that later becomes private would keep its old events' text,
--    so the flip itself (an AFTER UPDATE trigger on trip_plan_items) redacts
--    that item's earlier events and nulls its title in every stored snapshot.
--
-- APPEND-ONLY STILL HOLDS. 2420's trigger refuses every UPDATE of trip_events.
-- It is replaced by one that refuses every UPDATE EXCEPT the redaction itself:
-- an update whose only change is payload_json, and whose new payload_json is
-- exactly public.trip_event_minimised(type, old payload, forced). Nothing else
-- can be written through it — not a different payload, not a re-ordering, not
-- an added key — so the ledger can only lose the keys this file names.
--
-- REPLAY STILL HOLDS. The fold reads events only (2773). A redacted
-- `trip.plan_added` folds to `"title": null`; a redacted update folds to no
-- title change (jsonb_strip_nulls). The snapshot redaction writes exactly
-- `"title": null` for the item, so trip_snapshot_verify_replay compares equal.
--
-- Existing rows are minimised by the same function (section 5), once.
--
-- Rollback: db/rollback/2026-10-06-3976-trip-events-private-place-minimised-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_events') IS NULL THEN
    RAISE EXCEPTION '3976: trip_events is required (2420)';
  END IF;
  IF to_regclass('public.trip_snapshots') IS NULL THEN
    RAISE EXCEPTION '3976: trip_snapshots is required (2763)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_plan_items' AND column_name = 'location_is_private') THEN
    RAISE EXCEPTION '3976: trip_plan_items.location_is_private is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_trip_events_append_only' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '3976: trg_trip_events_append_only (2420) is missing; this file replaces its function and will not create the trigger from nothing';
  END IF;
END
$pre$;

-- ── 1. The keys that name or locate a plan item ────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_event_place_keys_removed(o jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  k CONSTANT text[] := ARRAY[
    'title', 'name', 'location_name', 'venue_name', 'neighborhood', 'address',
    'notes', 'description', 'place_id', 'google_place_id', 'source_id',
    'route_stop_id', 'structured_location', 'city', 'country', 'metadata',
    'lat', 'lng', 'destination_lat', 'destination_lng'];
  r jsonb;
BEGIN
  IF o IS NULL OR jsonb_typeof(o) <> 'object' THEN
    RETURN o;
  END IF;
  r := o - k;
  IF jsonb_typeof(r->'patch') = 'object' THEN
    r := jsonb_set(r, '{patch}', (r->'patch') - k);
  END IF;
  RETURN r;
END;
$fn$;

-- ── 2. One event's payload, minimised ──────────────────────────────────────
-- p_force: minimise a plan event whatever the item's state (the flip and the
-- append-only check use it); otherwise only when the item is not known public.
CREATE OR REPLACE FUNCTION public.trip_event_minimised(p_type text, p_payload jsonb, p_force boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  p        jsonb := coalesce(p_payload, '{}'::jsonb);
  v_item   text;
  v_public boolean := NULL;
BEGIN
  IF jsonb_typeof(p) <> 'object' THEN
    RETURN p;
  END IF;
  IF left(coalesce(p_type, ''), 10) = 'trip.plan_' OR p->>'family' = 'plan' THEN
    IF NOT p_force THEN
      v_item := coalesce(p->'result'->>'id', p->'payload'->>'item_id', p->'payload'->>'id', p->'payload'->>'plan_id');
      IF v_item IS NOT NULL AND v_item ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT (i.location_is_private = false) INTO v_public
          FROM public.trip_plan_items i WHERE i.id = v_item::uuid;
      END IF;
    END IF;
    IF v_public IS NOT TRUE THEN
      IF jsonb_typeof(p->'payload') = 'object' THEN
        p := jsonb_set(p, '{payload}', public.trip_event_place_keys_removed(p->'payload'));
      END IF;
      IF jsonb_typeof(p->'result') = 'object' THEN
        p := jsonb_set(p, '{result}', public.trip_event_place_keys_removed(p->'result'));
      END IF;
    END IF;
  END IF;
  IF jsonb_typeof(p->'payload') = 'object' AND p->'payload'->>'via' = 'admin_restore' THEN
    p := jsonb_set(p, '{payload}', (p->'payload') - 'reason' - 'appeal_id');
  END IF;
  RETURN p;
END;
$fn$;

-- ── 3. At write ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_events_minimise_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  NEW.payload_json := public.trip_event_minimised(NEW.type, NEW.payload_json, false);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_trip_events_minimise ON public.trip_events;
CREATE TRIGGER trg_trip_events_minimise
  BEFORE INSERT ON public.trip_events
  FOR EACH ROW EXECUTE FUNCTION public.trip_events_minimise_on_insert();

-- ── 4. Append-only, except the redaction ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_events_refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  -- 3976: the one UPDATE allowed is the redaction: every column but
  -- payload_json unchanged, and payload_json exactly the forced minimisation
  -- of the old one. Nothing else can be written through this.
  IF (to_jsonb(NEW) - 'payload_json') = (to_jsonb(OLD) - 'payload_json')
     AND NEW.payload_json = public.trip_event_minimised(OLD.type, OLD.payload_json, true) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'trip_events is append-only: UPDATE refused (event_id=%)', OLD.event_id
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

-- ── 5. When a public item becomes private, its history follows ─────────────
CREATE OR REPLACE FUNCTION public.trip_plan_item_redact_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_id text := NEW.id::text;
BEGIN
  IF NEW.location_is_private IS NOT DISTINCT FROM OLD.location_is_private OR NEW.location_is_private = false THEN
    RETURN NEW;
  END IF;
  UPDATE public.trip_events e
     SET payload_json = public.trip_event_minimised(e.type, e.payload_json, true)
   WHERE e.trip_id = NEW.trip_id
     AND (left(e.type, 10) = 'trip.plan_' OR e.payload_json->>'family' = 'plan')
     AND coalesce(e.payload_json->'result'->>'id', e.payload_json->'payload'->>'item_id',
                  e.payload_json->'payload'->>'id', e.payload_json->'payload'->>'plan_id') = v_id
     AND e.payload_json <> public.trip_event_minimised(e.type, e.payload_json, true);
  UPDATE public.trip_snapshots s
     SET snapshot_json = jsonb_set(s.snapshot_json, ARRAY['plans', v_id, 'title'], 'null'::jsonb)
   WHERE s.trip_id = NEW.trip_id
     AND jsonb_typeof(s.snapshot_json->'plans'->v_id) = 'object'
     AND (s.snapshot_json->'plans'->v_id->'title') IS DISTINCT FROM 'null'::jsonb;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_trip_plan_items_redact_history ON public.trip_plan_items;
CREATE TRIGGER trg_trip_plan_items_redact_history
  AFTER UPDATE OF location_is_private ON public.trip_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_item_redact_history();

-- ── 6. The rows already written ────────────────────────────────────────────
UPDATE public.trip_events e
   SET payload_json = public.trip_event_minimised(e.type, e.payload_json, true)
 WHERE public.trip_event_minimised(e.type, e.payload_json, false) <> e.payload_json;

-- One UPDATE per snapshot, rebuilding its `plans` object (an UPDATE ... FROM
-- a join with several matches per row would apply only one of them).
UPDATE public.trip_snapshots s
   SET snapshot_json = jsonb_set(s.snapshot_json, '{plans}', (
         SELECT coalesce(jsonb_object_agg(p.key,
                  CASE WHEN jsonb_typeof(p.value) = 'object'
                        AND NOT EXISTS (SELECT 1 FROM public.trip_plan_items i
                                         WHERE i.id::text = p.key AND i.location_is_private = false)
                       THEN jsonb_set(p.value, '{title}', 'null'::jsonb)
                       ELSE p.value END), '{}'::jsonb)
           FROM jsonb_each(s.snapshot_json->'plans') AS p(key, value)))
 WHERE jsonb_typeof(s.snapshot_json->'plans') = 'object'
   AND EXISTS (SELECT 1 FROM jsonb_each(s.snapshot_json->'plans') AS q(key, value)
                WHERE jsonb_typeof(q.value) = 'object'
                  AND (q.value->'title') IS DISTINCT FROM 'null'::jsonb
                  AND NOT EXISTS (SELECT 1 FROM public.trip_plan_items i
                                   WHERE i.id::text = q.key AND i.location_is_private = false));

-- ── 7. The client door ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS trip_events_crew_select ON public.trip_events;
REVOKE ALL ON public.trip_events FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.trip_event_place_keys_removed(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_event_minimised(text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_events_minimise_on_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_plan_item_redact_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_event_place_keys_removed(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_event_minimised(text, jsonb, boolean) TO service_role;

COMMENT ON FUNCTION public.trip_event_minimised(text, jsonb, boolean) IS
  '3976 (census-trips §85, lead ruling D-65): a plan-family trip event loses every key that names or locates the item (title, location_name, notes, description, place/source ids, city, country, coordinates, ...) unless the item is KNOWN public now; p_force minimises regardless. A restore event loses the admin reason and the appeal id.';

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  n int;
  v jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.trip_events'::regclass AND polname = 'trip_events_crew_select') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): trip_events_crew_select still exists';
  END IF;
  IF has_table_privilege('authenticated', 'public.trip_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): authenticated can still SELECT trip_events';
  END IF;
  IF has_table_privilege('anon', 'public.trip_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): anon can SELECT trip_events';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname IN ('trg_trip_events_minimise', 'trg_trip_plan_items_redact_history', 'trg_trip_events_append_only')
     AND NOT tgisinternal;
  IF n <> 3 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3976): expected 3 triggers, found %', n; END IF;

  -- A plan event with an unknown item loses its naming keys; coordinates too.
  v := public.trip_event_minimised('trip.plan_added',
         '{"family":"plan","payload":{"title":"Hotel X","notes":"room 4","stage_id":"s"},"result":{"id":"not-a-uuid","title":"Hotel X","status":"planned","city":"Lisboa"}}'::jsonb, false);
  IF v->'payload' ? 'title' OR v->'payload' ? 'notes' OR v->'result' ? 'title' OR v->'result' ? 'city' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): an unknown item kept its naming keys: %', v;
  END IF;
  IF v->'result'->>'status' <> 'planned' OR v->'payload'->>'stage_id' <> 's' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): minimisation removed a key that does not name or locate: %', v;
  END IF;
  -- A patch is minimised too.
  v := public.trip_event_minimised('trip.plan_updated', '{"payload":{"patch":{"title":"T","starts_at":"x"}},"result":{"id":"x"}}'::jsonb, true);
  IF v->'payload'->'patch' ? 'title' OR NOT (v->'payload'->'patch' ? 'starts_at') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): the patch was not minimised correctly: %', v;
  END IF;
  -- A restore event loses the reason and the appeal id, and keeps the rest.
  v := public.trip_event_minimised('trip.participant_added',
         '{"payload":{"via":"admin_restore","reason":"r","appeal_id":"a","user_id":"u"},"result":{"role":"member"}}'::jsonb, false);
  IF v->'payload' ? 'reason' OR v->'payload' ? 'appeal_id' OR v->'payload'->>'user_id' <> 'u' OR v->'result'->>'role' <> 'member' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): the restore event was not minimised correctly: %', v;
  END IF;
  -- Other families are untouched.
  v := public.trip_event_minimised('trip.participant_removed', '{"payload":{"role_at_removal":"member","title":"t"}}'::jsonb, true);
  IF NOT (v->'payload' ? 'title') OR v->'payload'->>'role_at_removal' <> 'member' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3976): a non-plan event was changed: %', v;
  END IF;
END
$post$;
