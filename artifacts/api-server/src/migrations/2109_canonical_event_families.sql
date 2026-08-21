-- 2109_canonical_event_families.sql
-- A read model over canonical_events that tags each event with its family:
-- exposure / action / outcome / satisfaction. One row per event, same grain as
-- canonical_events, plus a `family` column. Callers select a family with
-- `WHERE family = 'action'`; four separate views were avoided to keep the live
-- object surface (and the audit that must explain it) small.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION
-- ========================================
-- Carries a 4-digit prefix in the 2100-2999 band. audit:schema reports this
-- view missing-from-live until the migration is applied to a target; that is
-- expected, exactly as for 2100-2102.
--
-- SECURITY — security_invoker = true is load-bearing, not decorative.
-- canonical_events has deny-default RLS: authenticated sees only its own rows
-- (actor_id = auth.uid()), anon sees nothing. A view runs with the view OWNER's
-- privileges by default, which would BYPASS that policy and hand every caller
-- every traveler's events. security_invoker = true makes the view evaluate
-- canonical_events' RLS as the querying role, so the read model inherits exactly
-- the same row visibility as the base table.
--
-- The verb -> family CASE mirrors src/lib/eventFamilies.ts VERB_FAMILY exactly
-- and is pinned by eventFamilies.test.ts. Change both together.

CREATE OR REPLACE VIEW public.canonical_event_families
  WITH (security_invoker = true) AS
SELECT
  ce.*,
  CASE ce.verb
    WHEN 'impression'   THEN 'exposure'
    WHEN 'open'         THEN 'action'
    WHEN 'save'         THEN 'action'
    WHEN 'join'         THEN 'action'
    WHEN 'direction'    THEN 'action'
    WHEN 'arrival'      THEN 'outcome'
    WHEN 'completion'   THEN 'outcome'
    WHEN 'rejection'    THEN 'outcome'
    WHEN 'satisfaction' THEN 'satisfaction'
  END AS family
FROM public.canonical_events ce;

COMMENT ON VIEW public.canonical_event_families IS
  'Read model over canonical_events tagging each event with its family (exposure/action/outcome/satisfaction). security_invoker=true so canonical_events RLS is enforced for the querying role. verb->family mirrors src/lib/eventFamilies.ts VERB_FAMILY.';

-- Grants mirror canonical_events' read surface, via the 2093 grant-fix shape:
-- REVOKE ALL first (Supabase default-grants ALL to service_role on new objects),
-- then GRANT only SELECT. RLS (through security_invoker) still filters rows.
-- authenticated + service_role may read; PUBLIC and anon get nothing.
REVOKE ALL ON public.canonical_event_families FROM PUBLIC;
REVOKE ALL ON public.canonical_event_families FROM anon;
REVOKE ALL ON public.canonical_event_families FROM authenticated;
REVOKE ALL ON public.canonical_event_families FROM service_role;
GRANT SELECT ON public.canonical_event_families TO authenticated;
GRANT SELECT ON public.canonical_event_families TO service_role;
