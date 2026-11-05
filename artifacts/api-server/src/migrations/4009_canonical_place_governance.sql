-- Generated with supabase migration new canonical_place_governance; normalized
-- to the repository ledger. Ownerless place review is separate from sanctions.
-- No feature flags, business lifecycle or person Trust score are changed by withholding.
BEGIN;
ALTER TABLE public.places ADD COLUMN moderation_status text NOT NULL DEFAULT 'visible'
  CHECK (moderation_status IN ('visible','withheld'));
ALTER TABLE public.places ADD COLUMN governance_version bigint NOT NULL DEFAULT 0;
ALTER TABLE public.places ADD COLUMN merge_previous_status text
  CHECK (merge_previous_status IN ('active','closed','temporarily_closed','moved','duplicate','unverified'));
CREATE TABLE public.place_governance_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL,
  performed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  place_id uuid NOT NULL, report_id uuid REFERENCES public.moderation_reports(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN ('withhold','restore','merge','unmerge')),
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 1000),
  intent jsonb NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  receipt jsonb NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(performed_by,operation_id)
);
ALTER TABLE public.place_governance_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.place_governance_actions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.place_governance_actions TO service_role;
CREATE INDEX place_governance_actions_place_idx ON public.place_governance_actions(place_id,created_at DESC);

-- Only a boolean is exposed to clients. Definer avoids recursive places RLS;
-- bounded, cycle-aware traversal cannot expose a withheld merge ancestor.
CREATE FUNCTION public.canonical_place_is_visible(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  WITH RECURSIVE chain AS (
    SELECT id,moderation_status,merged_into_place_id,ARRAY[id] AS visited,false AS cycle
      FROM public.places WHERE id=p_id
    UNION ALL
    SELECT p.id,p.moderation_status,p.merged_into_place_id,c.visited||p.id,p.id=ANY(c.visited)
      FROM chain c JOIN public.places p ON p.id=c.merged_into_place_id
      WHERE NOT c.cycle AND cardinality(c.visited)<32
  ) SELECT EXISTS(SELECT 1 FROM chain WHERE merged_into_place_id IS NULL)
       AND NOT EXISTS(SELECT 1 FROM chain WHERE moderation_status<>'visible' OR cycle);
$fn$;
REVOKE ALL ON FUNCTION public.canonical_place_is_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canonical_place_is_visible(uuid) TO anon,authenticated,service_role;
DROP POLICY IF EXISTS places_read ON public.places;
CREATE POLICY places_read ON public.places FOR SELECT USING(public.canonical_place_is_visible(id));
DROP POLICY IF EXISTS epr_read ON public.external_place_references;
CREATE POLICY epr_read ON public.external_place_references FOR SELECT USING(public.canonical_place_is_visible(place_id));

-- Community listings can also reach the registry through an OSM reference.
-- Read the unfiltered registry in this definer; a client-side places query
-- would otherwise mistake an RLS-hidden canonical row for an unlinked one.
CREATE FUNCTION public.discovery_place_is_visible(p_id uuid,p_canonical_id uuid,p_osm_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT (p_canonical_id IS NULL OR public.canonical_place_is_visible(p_canonical_id))
    AND NOT EXISTS(SELECT 1 FROM public.places p WHERE p.id=p_id AND NOT public.canonical_place_is_visible(p.id))
    AND NOT EXISTS(SELECT 1 FROM public.external_place_references r
      WHERE r.provider='osm' AND r.provider_place_id=regexp_replace(p_osm_id,'^osm/','')
        AND NOT public.canonical_place_is_visible(r.place_id));
$fn$;
REVOKE ALL ON FUNCTION public.discovery_place_is_visible(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discovery_place_is_visible(uuid,uuid,text) TO anon,authenticated,service_role;
-- Restrictive policy composes with existing lifecycle/owner policies. Owners
-- retain access needed to retract their own listing; public distribution does not.
CREATE POLICY discovery_places_canonical_moderation ON public.discovery_places AS RESTRICTIVE
  FOR SELECT TO anon,authenticated USING (
    submitted_by=(SELECT auth.uid()) OR public.discovery_place_is_visible(id,canonical_location_id,osm_id)
  );

CREATE FUNCTION public.get_place_governance_context(p_admin_id uuid,p_id uuid,p_action text,p_report_id uuid DEFAULT NULL,p_into_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' SET timezone='UTC' AS $fn$
DECLARE target jsonb; destination jsonb; report_row jsonb;
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_admin_id AND role='admin') THEN
    RAISE EXCEPTION USING ERRCODE='PT403',MESSAGE='admin_role_required'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('withhold','restore','merge','unmerge') OR p_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='invalid_place_action'; END IF;
  SELECT to_jsonb(p) INTO target FROM public.places p WHERE id=p_id;
  IF target IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='place_not_found'; END IF;
  IF p_report_id IS NOT NULL THEN
    SELECT to_jsonb(r) INTO report_row FROM public.moderation_reports r WHERE id=p_report_id;
    IF report_row IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='report_not_found'; END IF;
    IF report_row->>'subject_type' IS DISTINCT FROM 'place' OR lower(report_row->>'subject_id') IS DISTINCT FROM p_id::text
      OR report_row->>'status' IS NULL OR (report_row->>'status' NOT IN ('open','reviewing')
        AND NOT (p_action='restore' AND report_row->>'status' IN ('actioned','dismissed')
          AND EXISTS(SELECT 1 FROM public.place_governance_actions a WHERE a.place_id=p_id AND a.report_id=p_report_id AND a.action='withhold'))) OR report_row->>'subject_user_id' IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.discovery_places WHERE id=p_id) THEN
      RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='ambiguous_or_changed_report'; END IF;
  ELSIF p_action IN ('withhold','restore') THEN
    RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='report_required';
  END IF;
  IF (p_action='withhold' AND target->>'moderation_status'<>'visible')
    OR (p_action='restore' AND target->>'moderation_status'<>'withheld')
    OR (p_action='unmerge' AND target->>'merged_into_place_id' IS NULL)
    OR (p_action='merge' AND (p_into_id IS NULL OR p_into_id=p_id OR target->>'merged_into_place_id' IS NOT NULL))
    OR (p_action<>'merge' AND p_into_id IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='place_action_changed'; END IF;
  IF p_action='merge' THEN
    SELECT to_jsonb(p) INTO destination FROM public.places p WHERE id=p_into_id;
    IF destination IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='destination_not_found'; END IF;
    IF destination->>'merged_into_place_id' IS NOT NULL OR destination->>'moderation_status'<>'visible'
      OR target->>'moderation_status'<>'visible' THEN
      RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='merge_destination_unavailable'; END IF;
  END IF;
  RETURN jsonb_build_object('contractVersion',1,'placeId',p_id,'reportId',p_report_id,'action',p_action,'intoId',p_into_id,
    'name',target->>'name','status',target->>'status','moderationStatus',target->>'moderation_status',
    'mergedIntoId',target->>'merged_into_place_id','restoreStatus',coalesce(target->>'merge_previous_status','unverified'),
    'destinationName',destination->>'name',
    'contextToken',encode(sha256(convert_to(jsonb_build_object('place',target,'destination',destination,'report',report_row)::text,'UTF8')),'hex'));
END $fn$;

CREATE FUNCTION public.apply_place_governance_action(p_admin_id uuid,p_id uuid,p_action text,p_report_id uuid,p_into_id uuid,
  p_operation_id uuid,p_reason text,p_expected_context_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' SET timezone='UTC' SET lock_timeout='1500ms' AS $fn$
DECLARE intent_value jsonb; prior public.place_governance_actions%ROWTYPE; context jsonb; before_value jsonb; after_value jsonb;
  receipt_value jsonb; action_id uuid:=gen_random_uuid(); committed_at timestamptz; previous_parent uuid; count_refs integer; affected_ids uuid[];
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
  p_reason:=btrim(p_reason);
  IF p_admin_id IS NULL OR p_id IS NULL OR p_operation_id IS NULL OR p_action IS NULL OR p_action NOT IN ('withhold','restore','merge','unmerge')
    OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 1000
    OR p_expected_context_token IS NULL OR p_expected_context_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='invalid_place_intent'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PLACE_GOVERNANCE_V1:'||p_admin_id::text||':'||p_operation_id::text,0));
  PERFORM 1 FROM public.profiles WHERE id=p_admin_id AND role='admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT403',MESSAGE='admin_role_required'; END IF;
  intent_value:=jsonb_build_object('placeId',p_id,'action',p_action,'reportId',p_report_id,'intoId',p_into_id,
    'reason',p_reason,'contextToken',p_expected_context_token);
  SELECT * INTO prior FROM public.place_governance_actions WHERE performed_by=p_admin_id AND operation_id=p_operation_id;
  IF FOUND THEN
    IF prior.intent IS DISTINCT FROM intent_value THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='place_intent_conflict'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  -- One graph lock serializes merge/unmerge and withholding against each other.
  PERFORM pg_advisory_xact_lock(hashtextextended('CANONICAL_PLACE_GRAPH_V1',0));
  IF p_report_id IS NOT NULL THEN PERFORM 1 FROM public.moderation_reports WHERE id=p_report_id FOR UPDATE; END IF;
  PERFORM 1 FROM public.places WHERE id=p_id OR id=p_into_id ORDER BY id FOR UPDATE;
  context:=public.get_place_governance_context(p_admin_id,p_id,p_action,p_report_id,p_into_id);
  IF context->>'contextToken' IS DISTINCT FROM p_expected_context_token THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='place_context_changed'; END IF;
  SELECT to_jsonb(p),merged_into_place_id INTO before_value,previous_parent FROM public.places p WHERE id=p_id;
  committed_at:=clock_timestamp();
  IF p_action IN ('withhold','restore') THEN
    UPDATE public.places SET moderation_status=CASE p_action WHEN 'withhold' THEN 'withheld' ELSE 'visible' END,updated_at=committed_at WHERE id=p_id;
  ELSIF p_action='merge' THEN
    UPDATE public.places SET merge_previous_status=status,status='duplicate',merged_into_place_id=p_into_id,updated_at=committed_at WHERE id=p_id;
  ELSE
    -- Pre-4009 merges did not record prior lifecycle. Never assert they reopened.
    UPDATE public.places SET status=coalesce(merge_previous_status,'unverified'),merge_previous_status=NULL,
      merged_into_place_id=NULL,updated_at=committed_at WHERE id=p_id;
  END IF;
  -- Invalidate every member of both old/new merge groups. A cache rebuild that
  -- began before this action carries its old version and cannot revive it later.
  WITH RECURSIVE edges(a,b) AS (
    SELECT id,merged_into_place_id FROM public.places WHERE merged_into_place_id IS NOT NULL
    UNION ALL SELECT merged_into_place_id,id FROM public.places WHERE merged_into_place_id IS NOT NULL
  ), affected(id) AS (
    SELECT unnest(array_remove(ARRAY[p_id,p_into_id,previous_parent],NULL))
    UNION SELECT e.b FROM affected a JOIN edges e ON e.a=a.id
  ) SELECT array_agg(id) INTO affected_ids FROM affected;
  IF cardinality(affected_ids)>4096 THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='place_graph_too_large'; END IF;
  UPDATE public.places SET governance_version=governance_version+1,updated_at=committed_at WHERE id=ANY(affected_ids);
  SELECT to_jsonb(p) INTO after_value FROM public.places p WHERE id=p_id;
  IF p_action IN ('merge','unmerge') THEN
    SELECT count(*) INTO count_refs FROM public.external_place_references WHERE place_id=p_id;
    INSERT INTO public.place_merge_log(action,survivor_place_id,affected_place_id,admin_id,ref_count,created_at)
      VALUES(p_action,coalesce(p_into_id,previous_parent),p_id,p_admin_id,count_refs,committed_at);
  END IF;
  receipt_value:=jsonb_build_object('ok',true,'contractVersion',1,'operationId',p_operation_id,'auditId',action_id,
    'placeId',p_id,'reportId',p_report_id,'action',p_action,'intoId',p_into_id,'replayed',false,'committedAt',committed_at);
  INSERT INTO public.place_governance_actions(id,operation_id,performed_by,place_id,report_id,action,reason,intent,before_state,after_state,receipt,created_at)
    VALUES(action_id,p_operation_id,p_admin_id,p_id,p_report_id,p_action,p_reason,intent_value,before_value,after_value,receipt_value,committed_at);
  RETURN receipt_value;
END $fn$;
REVOKE ALL ON FUNCTION public.get_place_governance_context(uuid,uuid,text,uuid,uuid),
  public.apply_place_governance_action(uuid,uuid,text,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_place_governance_context(uuid,uuid,text,uuid,uuid),
  public.apply_place_governance_action(uuid,uuid,text,uuid,uuid,uuid,text,text) TO service_role;

-- Admission is serialized with moderation, including service-role writers.
-- Retractions/deletes and unrelated moderation updates remain possible.
CREATE FUNCTION public.canonical_place_link_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE target_text text; direct_id uuid; linked_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('CANONICAL_PLACE_GRAPH_V1',0));
  IF TG_TABLE_NAME='reviews' AND pg_catalog.to_jsonb(NEW)->>'state' IN ('hidden','removed') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='discovery_places' THEN
    IF NOT public.discovery_place_is_visible(NEW.id,NEW.canonical_location_id,NEW.osm_id) THEN
      RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='canonical_place_unavailable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='hidden_gems' THEN
    linked_id:=NEW.canonical_place_id;
    IF linked_id IS NOT NULL AND NOT public.canonical_place_is_visible(linked_id) THEN
      RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='canonical_place_unavailable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.entity_type::text NOT IN ('place','gem') THEN RETURN NEW; END IF;
  target_text:=NEW.entity_id::text;
  IF target_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  direct_id:=target_text::uuid;
  -- The UUID namespaces overlap. A canonical hold always wins; reviews also
  -- use entity_type=place for a hidden-gem fallback.
  IF EXISTS(SELECT 1 FROM public.places WHERE id=direct_id) AND NOT public.canonical_place_is_visible(direct_id) THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='canonical_place_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM public.discovery_places d WHERE d.id=direct_id
    AND NOT public.discovery_place_is_visible(d.id,d.canonical_location_id,d.osm_id)) THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='canonical_place_unavailable'; END IF;
  SELECT canonical_place_id INTO linked_id FROM public.hidden_gems WHERE id=direct_id;
  IF linked_id IS NOT NULL AND NOT public.canonical_place_is_visible(linked_id) THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='canonical_place_unavailable'; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.canonical_place_link_admission() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER canonical_place_community_admission BEFORE INSERT OR UPDATE OF canonical_location_id,osm_id
  ON public.discovery_places FOR EACH ROW EXECUTE FUNCTION public.canonical_place_link_admission();
CREATE TRIGGER canonical_place_review_admission BEFORE INSERT OR UPDATE OF entity_type,entity_id,body,rating,state
  ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.canonical_place_link_admission();
CREATE TRIGGER canonical_place_vote_admission BEFORE INSERT OR UPDATE OF entity_type,entity_id,vote
  ON public.place_votes FOR EACH ROW EXECUTE FUNCTION public.canonical_place_link_admission();
CREATE TRIGGER canonical_place_gem_admission BEFORE INSERT OR UPDATE OF canonical_place_id
  ON public.hidden_gems FOR EACH ROW EXECUTE FUNCTION public.canonical_place_link_admission();

-- Forward replacement of the canonical context only; 3476/3988 remain byte-identical.
CREATE OR REPLACE FUNCTION public.discovery_trend_place_context_canonical()
 RETURNS TABLE(place_key text, creator_id text, cell_key text, cell_label text, city text, created_at timestamp with time zone, content_class text, trail_ids text[])
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- D-66 (3977): a Trail under review is its creator's alone, as loadTrendContext reads it.
  v_review text := CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trails' AND column_name = 'review_state')
      THEN $r$ AND t.review_state = 'approved'$r$
    ELSE ''
  END;
  v_members text := CASE
    WHEN to_regclass('public.content_trails') IS NOT NULL AND to_regclass('public.trails') IS NOT NULL THEN
      $m$SELECT lower(ct.source_id::text) AS pkey,
                array_agg(DISTINCT lower(ct.trail_id::text) ORDER BY lower(ct.trail_id::text)) AS tids
           FROM public.content_trails ct JOIN public.trails t ON t.id = ct.trail_id
          WHERE ct.source_type = 'place' AND t.lifecycle_status <> 'archived'$m$ || v_review || $m$
          GROUP BY lower(ct.source_id::text)$m$
    ELSE $m$SELECT NULL::text AS pkey, NULL::text[] AS tids WHERE false$m$
  END;
BEGIN
  -- 3476's context, over both place tables. lib/discoveryTrendNormalised
  -- EPHEMERAL_TYPES / ENDURING_TYPES / TREND_V2_CELL_DEG (0.02).
  RETURN QUERY EXECUTE format($q$
  WITH u AS (
    SELECT lower(dp.id::text) AS pkey,
           lower(dp.submitted_by::text) AS creator,
           NULLIF(lower(btrim(COALESCE(dp.city, ''), ' ')), '') AS pcity,
           NULLIF(btrim(COALESCE(dp.neighborhood, ''), ' '), '') AS hood,
           dp.lat, dp.lng, dp.created_at AS pcreated,
           lower(btrim(COALESCE(dp.category, ''), ' '))   AS cat,
           lower(btrim(COALESCE(dp.place_type, ''), ' ')) AS typ
      FROM public.discovery_places dp
     WHERE public.discovery_place_is_visible(dp.id,dp.canonical_location_id,dp.osm_id)
    UNION ALL
    -- lib/discoveryTrendCanonicalContext canonicalContextPlaceRow: no submitter;
    -- primary_category is the category; no place_type.
    SELECT lower(pl.id::text), NULL::text,
           NULLIF(lower(btrim(COALESCE(pl.city, ''), ' ')), ''),
           NULLIF(btrim(COALESCE(pl.neighborhood, ''), ' '), ''),
           pl.latitude, pl.longitude, pl.created_at,
           lower(btrim(COALESCE(pl.primary_category, ''), ' ')),
           ''::text
      FROM public.places pl
     WHERE pl.status = 'active' AND pl.merged_into_place_id IS NULL AND public.canonical_place_is_visible(pl.id)
       AND NOT EXISTS (SELECT 1 FROM public.discovery_places d WHERE d.id = pl.id)
  ), p AS (
    SELECT u.* FROM u
     WHERE NOT EXISTS (SELECT 1 FROM public.protected_zones z WHERE z.active)
        OR public.discovery_trend_position_is_clear(u.lat, u.lng)
  ), keyed AS (
    SELECT p.*,
           CASE WHEN p.hood IS NOT NULL AND p.pcity IS NOT NULL THEN 'n:' || p.pcity || ':' || lower(p.hood)
                WHEN p.lat IS NOT NULL AND p.lng IS NOT NULL
                  THEN 'g:' || floor(p.lat / 0.02::double precision)::bigint::text || ':' || floor(p.lng / 0.02::double precision)::bigint::text
           END AS ckey
      FROM p
  ), members AS (%s)
  SELECT k.pkey, k.creator, k.ckey,
         CASE WHEN k.ckey LIKE 'n:%%' THEN min(k.hood COLLATE "C") OVER (PARTITION BY k.ckey) END,
         k.pcity, k.pcreated,
         CASE WHEN k.cat = ANY (ARRAY['event','events','festival','concert','performance','party']) THEN 'ephemeral'
              WHEN k.cat = ANY (ARRAY['temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins',
                                      'landmark','museum','heritage site','historic district','attraction','beach','park','garden','viewpoint']) THEN 'enduring'
              WHEN k.typ = ANY (ARRAY['event','events','festival','concert','performance','party']) THEN 'ephemeral'
              WHEN k.typ = ANY (ARRAY['temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins',
                                      'landmark','museum','heritage site','historic district','attraction','beach','park','garden','viewpoint']) THEN 'enduring'
              ELSE 'standard' END,
         COALESCE(mm.tids, ARRAY[]::text[])
    FROM keyed k LEFT JOIN members mm ON mm.pkey = k.pkey
  $q$, v_members);
END
$function$;
-- Retained occurrence text remains history; a new fill may not copy a withheld catalog name.
CREATE OR REPLACE FUNCTION public.memory_place_occurrence_name_fill()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_place text := NULLIF(btrim(NEW.place_id), '');
  v_given text := left(NULLIF(btrim(NEW.place_display_name_at_occurrence), ''), 300);
  v_catalog text;
BEGIN
  -- Rule 2: the same place keeps its recorded text.
  IF TG_OP = 'UPDATE' AND NEW.place_id IS NOT DISTINCT FROM OLD.place_id THEN
    IF OLD.place_display_name_at_occurrence IS NOT NULL THEN
      NEW.place_display_name_at_occurrence := OLD.place_display_name_at_occurrence;
    ELSIF v_place IS NULL THEN
      NEW.place_display_name_at_occurrence := NULL;
    ELSE
      NEW.place_display_name_at_occurrence := v_given; -- a first capture only; never a catalog backfill
    END IF;
    RETURN NEW;
  END IF;
  -- Rule 1: no place, no place name.
  IF v_place IS NULL THEN
    NEW.place_display_name_at_occurrence := NULL;
    RETURN NEW;
  END IF;
  -- Rule 3: a changed place never keeps the old place's text.
  IF TG_OP = 'UPDATE' AND NEW.place_display_name_at_occurrence IS NOT DISTINCT FROM OLD.place_display_name_at_occurrence THEN
    v_given := NULL;
  END IF;
  IF v_given IS NULL AND v_place ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT left(NULLIF(btrim(p.name), ''), 300) INTO v_catalog FROM public.places p WHERE p.id = v_place::uuid AND public.canonical_place_is_visible(p.id);
    v_given := v_catalog;
  END IF;
  NEW.place_display_name_at_occurrence := v_given;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_place_occurrence_name_fill() FROM PUBLIC,anon,authenticated;
DO $post$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.get_place_governance_context(uuid,uuid,text,uuid,uuid)',
    'public.apply_place_governance_action(uuid,uuid,text,uuid,uuid,uuid,text,text)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
      OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN
      RAISE EXCEPTION '4009 governance RPC privilege postcondition failed: %',f;
    END IF;
  END LOOP;
  IF has_table_privilege('anon','public.place_governance_actions','SELECT')
    OR has_table_privilege('authenticated','public.place_governance_actions','SELECT') THEN
    RAISE EXCEPTION '4009 audit table is exposed to client roles'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgname IN
    ('canonical_place_review_admission','canonical_place_vote_admission','canonical_place_gem_admission','canonical_place_community_admission'))<>4 THEN
    RAISE EXCEPTION '4009 positive-admission trigger missing'; END IF;
END $post$;

COMMIT;
