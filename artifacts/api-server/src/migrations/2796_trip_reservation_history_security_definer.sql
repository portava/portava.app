-- 2796_trip_reservation_history_security_definer.sql
--
-- Trips v4 §15.4. Repairs a latent defect 2784 introduced: the booking-history
-- trigger cannot run for any caller except the service role, which silently
-- killed the two client write paths 2784 deliberately kept.
--
-- WHAT 2784 INTENDED, AND WHAT IT DID
-- ===================================
-- 2784 made a deliberate privilege decision and said so: "clients cancel; only
-- the service deletes (account deletion)". It revoked DELETE on
-- trip_reservations from `authenticated` and dropped
-- trip_reservations_owner_delete. It did NOT revoke INSERT or UPDATE, and it
-- left trip_reservations_owner_insert and trip_reservations_owner_update in
-- place — those policies exist precisely so an owner may write their own
-- reservation.
--
-- In the same file it added public.trip_reservations_history() as an ordinary
-- trigger, which is SECURITY INVOKER, and granted `authenticated` only SELECT
-- on trip_reservation_events. So the trigger appends the history row AS THE
-- CALLER, and the caller has no INSERT on the table it appends to.
--
-- MEASURED, not reasoned about. Against production 2026-09-17, as role
-- `authenticated` with JWT claims set, inside a rolled-back transaction:
--
--   service_role INSERT trip_reservations              -> ok, history created(v0)
--   service_role UPDATE trip_reservations              -> ok, version 0 -> 1,
--                                                        history confirmed(v1)
--   UPDATE a trip_reservation_events row               -> refused, 42501
--                                                        (append-only holds)
--   authenticated INSERT trip_reservations             -> 42501
--                        permission denied for table trip_reservation_events
--
-- The two owner policies are therefore unreachable: every client write 42501s
-- inside the trigger. portava-ci measured identically, so this is a defect of
-- the chain and not drift on one database.
--
-- WHY THIS IS LATENT AND NOT AN OUTAGE
-- ====================================
-- Nothing writes trip_reservations as `authenticated` today: the API server
-- holds the service role and travel-buddy-standalone has no direct
-- trip_reservations access at all (measured: zero references). Production
-- carries 0 reservation rows. So no user has hit this. It is still a broken
-- contract — a policy that grants a write nobody can perform is worse than no
-- policy, because it reads as permission.
--
-- THE FIX, AND WHY THIS ONE
-- =========================
-- SECURITY DEFINER on the history trigger only. The append then runs with the
-- function owner's rights, so it succeeds for any caller the RLS policies
-- already admitted, while `authenticated` still holds no direct INSERT on
-- trip_reservation_events — a client still cannot forge a history row, it can
-- only cause one to be written as the honest consequence of a write RLS let it
-- make. search_path is pinned, which an unpinned SECURITY DEFINER function must
-- always do.
--
-- The two append-only guards stay SECURITY INVOKER. They only RAISE; giving
-- them the owner's rights would buy nothing and widen what runs as owner.
--
-- ACTOR ATTRIBUTION. 2784 read the actor from a transaction-local GUC the route
-- sets. A client write sets no GUC, so its history row would have recorded a
-- null actor — the row would exist and not say who caused it. The actor now
-- falls back to auth.uid(), which is the authenticated caller's own id and
-- cannot be chosen by them. The GUC still wins when the server set it, so
-- server-written history is unchanged. Neither source is trusted beyond what it
-- is: the GUC is set by our own routes, auth.uid() is derived from a verified
-- JWT, and the column stays nullable because "we do not know" is a real answer.
--
-- Nothing else in 2784 changes: the row shape, the event vocabulary, the
-- version bump, the cancelled_at coupling and the changed-keys minimisation are
-- reproduced verbatim.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_reservation_events') IS NULL THEN
    RAISE EXCEPTION '2796: requires 2784 (trip_reservation_events)';
  END IF;
  IF to_regprocedure('public.trip_reservations_history()') IS NULL THEN
    RAISE EXCEPTION '2796: requires 2784 (trip_reservations_history)';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'trip_reservations_history') THEN
    RAISE EXCEPTION '2796: trip_reservations_history is already SECURITY DEFINER; this migration has run';
  END IF;
  -- The defect only exists while the client may write the parent and not the
  -- history. If a later change revoked the parent write, this file is the wrong
  -- repair and should not run.
  IF NOT has_table_privilege('authenticated', 'public.trip_reservations', 'INSERT') THEN
    RAISE EXCEPTION '2796: authenticated no longer holds INSERT on trip_reservations; the client write path this repairs no longer exists';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trip_reservations_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  keys text[] := '{}';
  k text;
  et text;
  actor uuid;
BEGIN
  -- The route's transaction-local GUC first; a client write sets none, so fall
  -- back to the caller's own verified id rather than recording nobody.
  BEGIN
    actor := NULLIF(current_setting('portava.actor', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN actor := NULL; END;
  IF actor IS NULL THEN
    BEGIN
      actor := auth.uid();
    EXCEPTION WHEN OTHERS THEN actor := NULL; END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.trip_reservation_events (reservation_id, trip_id, event_type, from_status, to_status, version, actor_user_id, changed_keys)
    VALUES (NEW.id, NEW.trip_id, 'created', NULL, NEW.status, NEW.version, actor, '{}');
    RETURN NEW;
  END IF;
  -- UPDATE: bump the version, then record what changed (keys only).
  NEW.version := OLD.version + 1;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN NEW.cancelled_at := coalesce(NEW.cancelled_at, now()); END IF;
  FOR k IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
    IF k NOT IN ('version', 'updated_at') AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN keys := array_append(keys, k); END IF;
  END LOOP;
  et := CASE
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'confirmed' THEN 'confirmed'
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'dismissed' THEN 'dismissed'
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'cancelled' THEN 'cancelled'
    ELSE 'updated' END;
  INSERT INTO public.trip_reservation_events (reservation_id, trip_id, event_type, from_status, to_status, version, actor_user_id, changed_keys)
  VALUES (NEW.id, NEW.trip_id, et, OLD.status, NEW.status, NEW.version, actor, keys);
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.trip_reservations_history() IS
  'Trips spec §15.4 booking history, appended by trigger. SECURITY DEFINER (2796) so the append runs with the owner''s rights: 2784 left this SECURITY INVOKER while granting authenticated only SELECT on trip_reservation_events, which made every client write to trip_reservations fail 42501 inside the trigger and left trip_reservations_owner_insert / _update unreachable. A client still holds no direct INSERT on the history table, so it can cause a history row only as the honest consequence of a write RLS admitted. search_path is pinned. Actor: the route''s portava.actor GUC, else auth.uid(); never a value the caller chooses.';

-- A definer function must not be callable directly; it is reached only as a trigger.
REVOKE ALL ON FUNCTION public.trip_reservations_history() FROM PUBLIC, anon, authenticated;

DO $post$
DECLARE r record; n int; rid uuid;
BEGIN
  SELECT p.prosecdef, p.proconfig INTO r
    FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
   WHERE n2.nspname = 'public' AND p.proname = 'trip_reservations_history';
  IF NOT r.prosecdef THEN RAISE EXCEPTION '2796: the trigger is still SECURITY INVOKER'; END IF;
  IF r.proconfig IS NULL OR NOT (r.proconfig::text LIKE '%search_path%') THEN
    RAISE EXCEPTION '2796: a SECURITY DEFINER function must pin search_path';
  END IF;

  -- The append-only guards must NOT have become definer.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace n3 ON n3.oid = p.pronamespace
   WHERE n3.nspname = 'public'
     AND p.proname IN ('trip_reservation_events_append_only','trip_reservation_events_no_direct_delete')
     AND p.prosecdef;
  IF n <> 0 THEN RAISE EXCEPTION '2796: an append-only guard became SECURITY DEFINER (% of them)', n; END IF;

  -- The client still may not write the history table directly.
  IF has_table_privilege('authenticated','public.trip_reservation_events','INSERT')
     OR has_table_privilege('authenticated','public.trip_reservation_events','UPDATE')
     OR has_table_privilege('authenticated','public.trip_reservation_events','DELETE') THEN
    RAISE EXCEPTION '2796: authenticated gained a direct write on trip_reservation_events; the repair must not widen that';
  END IF;
  IF NOT has_table_privilege('authenticated','public.trip_reservation_events','SELECT') THEN
    RAISE EXCEPTION '2796: authenticated can no longer read its own booking history';
  END IF;
  -- 2784's other privilege decision stands: clients cancel, only the service deletes.
  IF has_table_privilege('authenticated','public.trip_reservations','DELETE') THEN
    RAISE EXCEPTION '2796: authenticated regained DELETE on trip_reservations';
  END IF;

  -- Behaviour, in a subtransaction that is undone: the service path still works
  -- end to end and still writes exactly two history rows for insert+update.
  BEGIN
    INSERT INTO public.trip_reservations (trip_id, user_id, type, title)
    SELECT t.id, t.owner_id, 'stay', '2796 postcondition probe'
      FROM public.trips t WHERE t.owner_id IS NOT NULL ORDER BY t.created_at LIMIT 1
    RETURNING id INTO rid;
    IF rid IS NULL THEN
      RAISE NOTICE '2796: no trip with an owner on this database; the behavioural probe was skipped';
    ELSE
      UPDATE public.trip_reservations SET status = 'confirmed' WHERE id = rid;
      SELECT count(*) INTO n FROM public.trip_reservation_events WHERE reservation_id = rid;
      IF n <> 2 THEN RAISE EXCEPTION '2796: expected 2 history rows from insert+update, found %', n; END IF;
      SELECT version INTO n FROM public.trip_reservations WHERE id = rid;
      IF n <> 1 THEN RAISE EXCEPTION '2796: the version was not bumped to 1, found %', n; END IF;
    END IF;
    RAISE EXCEPTION 'ROLLBACK_PROBE';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'ROLLBACK_PROBE' THEN RAISE; END IF;
  END;
END
$post$;

COMMIT;
