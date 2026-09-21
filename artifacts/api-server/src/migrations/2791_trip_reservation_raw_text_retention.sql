-- 2791_trip_reservation_raw_text_retention.sql
--
-- Trips spec §21.3 — projections and decisions are recorded "without
-- retaining unnecessary sensitive raw data". census-trips TR403: *"the
-- counter-example is `trip_reservations.raw_text` (0172:22), which retains
-- the traveller's entire pasted booking email verbatim, indefinitely, for
-- re-extraction. Justified in its header ("audit / re-extract") and it is
-- exactly the retention this rule asks to avoid."*
--
-- The text is kept for the purpose it was pasted for — re-extraction while
-- the traveller is still confirming what the parser read — and not beyond it:
--
--   raw_text_retain_until  — thirty days from the row's creation by default
--                            (existing rows: from THEIR created_at, so an old
--                            paste is already past it); NULL once forgotten.
--   trip_reservations_forget_raw_text()
--                          — sets raw_text to NULL past retention and reports
--                            the count. service_role only; the server
--                            schedules it, nothing in the database does.
--
-- 2784's history trigger sees the forget as an UPDATE: it bumps `version` and
-- records an `updated` event whose changed_keys name raw_text — which is the
-- right record for a deletion of evidence: the history says the text was
-- forgotten and when, without keeping it. A client holding a stale If-Match
-- version meets TRIP_VERSION_CONFLICT on its next write, as for any change.
--
-- Additive. No row loses its text at apply time; the prune is a separate,
-- reported call. Applied on scripts/local-db; rehearsed by
-- src/test/db/tripReservationRawTextRetention.db.test.ts.

DO $pre$
BEGIN
  IF to_regclass('public.trip_reservations') IS NULL THEN
    RAISE EXCEPTION '2791: public.trip_reservations does not exist (0172)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_reservations' AND column_name = 'raw_text') THEN
    RAISE EXCEPTION '2791: trip_reservations.raw_text does not exist — nothing to bound';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'trip_reservations' AND column_name = 'raw_text_retain_until') THEN
    RAISE EXCEPTION '2791: raw_text_retain_until already exists — this file was applied, or a sibling added it';
  END IF;
END
$pre$;

ALTER TABLE public.trip_reservations
  ADD COLUMN raw_text_retain_until timestamptz NULL DEFAULT now() + interval '30 days';

-- Existing rows: thirty days from their own creation. A row with no text has
-- nothing to forget and no deadline.
UPDATE public.trip_reservations
   SET raw_text_retain_until = CASE WHEN raw_text IS NULL THEN NULL ELSE created_at + interval '30 days' END;

COMMENT ON COLUMN public.trip_reservations.raw_text_retain_until IS
  'Trips spec §21.3: raw_text is kept for re-extraction until this instant (30 days from creation by default) and forgotten by trip_reservations_forget_raw_text(); NULL once forgotten or when there was no text.';

CREATE OR REPLACE FUNCTION public.trip_reservations_forget_raw_text()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE n bigint;
BEGIN
  UPDATE public.trip_reservations
     SET raw_text = NULL, raw_text_retain_until = NULL
   WHERE raw_text IS NOT NULL AND raw_text_retain_until IS NOT NULL AND raw_text_retain_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'forgotten', n, 'at', now());
END;
$fn$;
REVOKE ALL ON FUNCTION public.trip_reservations_forget_raw_text() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.trip_reservations_forget_raw_text() IS
  'Trips spec §21.3: forgets trip_reservations.raw_text past raw_text_retain_until and reports the count. service_role only; nothing in the database schedules it.';

DO $post$
DECLARE stale bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_reservations' AND column_name = 'raw_text_retain_until') THEN
    RAISE EXCEPTION '2791: raw_text_retain_until was not added';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trip_reservations WHERE raw_text IS NOT NULL AND raw_text_retain_until IS NULL) THEN
    RAISE EXCEPTION '2791: a row keeps text with no retention deadline';
  END IF;
  IF to_regprocedure('public.trip_reservations_forget_raw_text()') IS NULL THEN
    RAISE EXCEPTION '2791: trip_reservations_forget_raw_text() is missing';
  END IF;
  SELECT count(*) INTO stale FROM public.trip_reservations WHERE raw_text IS NOT NULL AND raw_text_retain_until < now();
  RAISE NOTICE '2791: % reservation(s) already past raw_text retention; the next trip_reservations_forget_raw_text() forgets them', stale;
END
$post$;
