-- 2776_trip_presence_freshness_and_ordering.sql
--
-- The FIRST of two §10 rules the presence family (2767 + 2768) does not yet
-- enforce. This file is the schema half — the freshness computation and the
-- read surface. `2777_trip_kernel_presence_ordering.sql` is the kernel half,
-- and the two are split because one is a view and the other is a transform of
-- trip_kernel_execute; a single migration would have to be rolled back as one
-- thing when they are independently withdrawable.
--
-- 1. OUT-OF-ORDER OBSERVATIONS OVERWRITE NEWER ONES  (fixed by 2777)
-- =================================================================
-- SET_PRESENCE is an upsert with no comparison of observed_at, so a message
-- that was delayed in flight — a queued mobile write, a retried request, a
-- reconnecting client flushing its buffer — replaces a NEWER observation with
-- an OLDER one. The row then says the traveller is where they were ten minutes
-- ago, with a fresh-looking expires_at, and nothing anywhere can tell.
--
-- §10.2's rule is "The Trip Map must never draw a stale location as if it were
-- current." Silent last-write-wins is precisely how a stale location becomes
-- the current one. The fix is a comparison at the point of the write:
-- ON CONFLICT ... DO UPDATE ... WHERE EXCLUDED.observed_at >= observed_at.
--
-- The kernel then reports which happened. An ignored write is NOT an error —
-- the client did nothing wrong and retrying is the correct behaviour that
-- caused it — so the command still succeeds and the result carries
-- `applied: false, reason: STALE_OBSERVATION`. Returning a refusal would make
-- a well-behaved retry look like a failure.
--
-- 2. FRESHNESS IS NOT DERIVABLE BY A READER TODAY
-- ===============================================
-- §10.2 names four states: LIVE | RECENT | LAST_KNOWN | OFFLINE. Every reader
-- of trip_presence would otherwise compute them itself from observed_at and
-- expires_at, with its own thresholds — which is how one surface shows a
-- marker as live and another shows the same row as stale.
--
-- public.trip_presence_freshness(observed_at, expires_at, at) is that one
-- computation, and public.trip_presence_current is the view a reader should
-- use. THE VIEW DOES NOT HIDE EXPIRED ROWS: it labels them OFFLINE and keeps
-- them, because "we know where they were an hour ago" and "we have never known
-- where they are" are different facts and a filtered-out row cannot express the
-- difference. §10.4 depends on that distinction — last-known data "may remain
-- useful but is not live truth".
--
-- THE THRESHOLDS, AND THAT THEY ARE A READING
-- ===========================================
-- §10.2 names the four states and does not say what separates them. The
-- boundaries below are derived from what the row itself carries, not from
-- invented constants:
--   LIVE        not expired, and observed within the last quarter of its own
--               TTL. A row with a 20-minute TTL is live for 5 minutes.
--   RECENT      not expired, observed longer ago than that.
--   LAST_KNOWN  expired, but by less than its own TTL again.
--   OFFLINE     expired by more than its own TTL, or never observed.
-- Deriving from the TTL rather than a fixed number means a presence a client
-- declared short-lived goes stale quickly and one declared long-lived does not,
-- which is what a TTL is for. It is an interpretation, it is written down, and
-- widening it is a one-line change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2776 (Trips).

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_presence') IS NULL THEN
    RAISE EXCEPTION '2776: requires 2763 (trip_presence)';
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence'::regclass AND attname='source' AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION '2776: requires 2767 — trip_presence has no source column'; END IF;
  IF to_regclass('public.trip_presence_current') IS NOT NULL THEN
    RAISE EXCEPTION '2776: trip_presence_current already exists';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trip_presence_freshness(
  p_observed_at timestamptz, p_expires_at timestamptz, p_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_observed_at IS NULL OR p_expires_at IS NULL OR p_at IS NULL THEN 'offline'
    -- The row's own TTL is the unit. A presence declared short-lived goes
    -- stale quickly and one declared long-lived does not, which is the point
    -- of carrying a TTL at all.
    WHEN p_expires_at <= p_observed_at THEN 'offline'
    WHEN p_at <= p_observed_at + (p_expires_at - p_observed_at) / 4 THEN 'live'
    WHEN p_at <  p_expires_at                                       THEN 'recent'
    WHEN p_at <  p_expires_at + (p_expires_at - p_observed_at)      THEN 'last_known'
    ELSE 'offline'
  END;
$fn$;

COMMENT ON FUNCTION public.trip_presence_freshness(timestamptz, timestamptz, timestamptz) IS
  'Trips spec §10.2: live | recent | last_known | offline, lowercased. ONE computation, so two surfaces cannot disagree about whether the same row is current — which is how §10.2''s rule that the map must never draw a stale location as current gets broken in practice. The boundaries are derived from the row''s OWN TTL rather than fixed constants: live is the first quarter of it, last_known is up to one TTL past expiry. §10.2 names the four states and does not say what separates them, so those boundaries are an interpretation and are written here rather than left in each reader.';

CREATE VIEW public.trip_presence_current AS
  SELECT p.trip_id,
         p.user_id,
         p.presence_state,
         p.visibility,
         p.source,
         p.confidence,
         p.observed_at,
         p.expires_at,
         public.trip_presence_freshness(p.observed_at, p.expires_at, now()) AS freshness,
         (p.expires_at <= now())                                           AS expired,
         EXTRACT(EPOCH FROM (now() - p.observed_at))::bigint               AS observed_seconds_ago
    FROM public.trip_presence p;

COMMENT ON VIEW public.trip_presence_current IS
  'Trips spec §10.2. The read surface for presence, carrying the freshness label beside the row. IT DOES NOT FILTER EXPIRED ROWS OUT: "we know where they were an hour ago" and "we have never known where they are" are different facts, a filtered row cannot express the difference, and §10.4 depends on it — last-known data may remain useful but is not live truth. A reader that wants only current presence filters on freshness itself, having seen the label.';

-- The view inherits trip_presence's RLS (it is not SECURITY DEFINER and the
-- underlying table's policy applies), so the grant is the same as the table's.
REVOKE ALL ON public.trip_presence_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_presence_current TO authenticated;

DO $post$
DECLARE n int; t text;
BEGIN
  IF to_regclass('public.trip_presence_current') IS NULL THEN
    RAISE EXCEPTION '2776: the view is absent after create';
  END IF;

  -- The four §10.2 states, each produced by a real input rather than asserted.
  IF public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T12:03:00Z') <> 'live' THEN
    RAISE EXCEPTION '2776: 3 minutes into a 20-minute TTL is not live';
  END IF;
  IF public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T12:10:00Z') <> 'recent' THEN
    RAISE EXCEPTION '2776: 10 minutes into a 20-minute TTL is not recent';
  END IF;
  IF public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T12:30:00Z') <> 'last_known' THEN
    RAISE EXCEPTION '2776: 10 minutes past a 20-minute TTL is not last_known';
  END IF;
  IF public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T13:00:00Z') <> 'offline' THEN
    RAISE EXCEPTION '2776: 40 minutes past a 20-minute TTL is not offline';
  END IF;
  -- A null anywhere is offline, never live. Fail-closed: an unknown freshness
  -- rendered as current is the exact §10.2 violation.
  FOREACH t IN ARRAY ARRAY['o','e','a'] LOOP
    IF public.trip_presence_freshness(
         CASE WHEN t='o' THEN NULL ELSE '2026-10-01T12:00:00Z'::timestamptz END,
         CASE WHEN t='e' THEN NULL ELSE '2026-10-01T12:20:00Z'::timestamptz END,
         CASE WHEN t='a' THEN NULL ELSE '2026-10-01T12:01:00Z'::timestamptz END) <> 'offline' THEN
      RAISE EXCEPTION '2776: a null % does not read as offline', t;
    END IF;
  END LOOP;

  -- The view must expose the label, and must NOT filter.
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence_current'::regclass
     AND attname IN ('freshness','expired','observed_seconds_ago') AND NOT attisdropped;
  IF n <> 3 THEN RAISE EXCEPTION '2776: the view does not expose freshness, expired and age'; END IF;
  IF position('WHERE' in pg_get_viewdef('public.trip_presence_current'::regclass)) > 0 THEN
    RAISE EXCEPTION '2776: the view filters rows. An expired presence must be LABELLED offline, not hidden — a hidden row cannot say "we knew an hour ago" instead of "we never knew".';
  END IF;

  IF has_table_privilege('anon','public.trip_presence_current','SELECT') THEN
    RAISE EXCEPTION '2776: anon can read presence';
  END IF;
END
$post$;

COMMIT;
