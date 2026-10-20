BEGIN;

CREATE TABLE IF NOT EXISTS public.creator_attribution_scan_cursors (
  producer text PRIMARY KEY CHECK (producer = 'travel_partner'),
  after_booking_id uuid,
  cycle_upper_id uuid,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT creator_attribution_scan_cursor_bounds CHECK (
    after_booking_id IS NULL OR (cycle_upper_id IS NOT NULL AND after_booking_id <= cycle_upper_id)
  )
);

ALTER TABLE public.creator_attribution_scan_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.creator_attribution_scan_cursors FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.creator_attribution_scan_cursors TO service_role;
GRANT UPDATE (after_booking_id, cycle_upper_id, revision) ON public.creator_attribution_scan_cursors TO service_role;

INSERT INTO public.creator_attribution_scan_cursors (producer)
VALUES ('travel_partner')
ON CONFLICT (producer) DO NOTHING;

DO $post$
DECLARE
  actual_columns text[];
BEGIN
  SELECT array_agg(column_name || ':' || data_type || ':' || is_nullable ORDER BY column_name)
    INTO actual_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creator_attribution_scan_cursors';
  IF actual_columns IS DISTINCT FROM ARRAY['after_booking_id:uuid:YES', 'cycle_upper_id:uuid:YES', 'producer:text:NO', 'revision:uuid:NO'] THEN
    RAISE EXCEPTION '3989: unexpected cursor columns';
  END IF;
  IF (SELECT count(*) FROM public.creator_attribution_scan_cursors) <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.creator_attribution_scan_cursors WHERE producer = 'travel_partner' AND revision IS NOT NULL
      AND (after_booking_id IS NULL OR (cycle_upper_id IS NOT NULL AND after_booking_id <= cycle_upper_id))
  ) THEN
    RAISE EXCEPTION '3989: singleton cursor seed is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.creator_attribution_scan_cursors'::regclass
      AND conname = 'creator_attribution_scan_cursor_bounds' AND contype = 'c' AND convalidated
  ) THEN
    RAISE EXCEPTION '3989: cursor cycle bounds constraint is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.creator_attribution_scan_cursors'::regclass) THEN
    RAISE EXCEPTION '3989: cursor RLS is disabled';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.creator_attribution_scan_cursors', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.creator_attribution_scan_cursors', 'after_booking_id', 'UPDATE')
     OR NOT has_column_privilege('service_role', 'public.creator_attribution_scan_cursors', 'cycle_upper_id', 'UPDATE')
     OR NOT has_column_privilege('service_role', 'public.creator_attribution_scan_cursors', 'revision', 'UPDATE')
     OR has_column_privilege('service_role', 'public.creator_attribution_scan_cursors', 'producer', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_attribution_scan_cursors', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_any_column_privilege('service_role', 'public.creator_attribution_scan_cursors', 'INSERT,REFERENCES') THEN
    RAISE EXCEPTION '3989: service cursor privileges must be SELECT and position/bound/revision UPDATE only';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) AS roles(role_name)
     WHERE has_table_privilege(role_name, 'public.creator_attribution_scan_cursors', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(role_name, 'public.creator_attribution_scan_cursors', 'SELECT,INSERT,UPDATE,REFERENCES')
  ) THEN
    RAISE EXCEPTION '3989: cursor privileges are exposed to clients';
  END IF;
END
$post$;

COMMIT;
