-- L259: bounded durable route fanout. FALSE gate; no deployment activation.
-- Requires only 2860, 2992, 3623, 3828, 3871, 3873, 3895. No dependency on later files.
-- New service-only tables and functions; existing canonical/immutable triggers remain authoritative.
BEGIN;
DO $pre$ BEGIN
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_fanout_enabled') THEN RAISE EXCEPTION '3908 refuses an existing rollout flag';END IF;
 IF to_regclass('public.layover_route_subjects') IS NULL OR to_regclass('public.layover_recommendation_supersessions') IS NULL OR to_regclass('public.layover_external_events') IS NULL THEN RAISE EXCEPTION '3908 route, event and immutable-history prerequisites missing';END IF;
END $pre$;
CREATE TABLE public.layover_route_dispatches(
 event_id text PRIMARY KEY REFERENCES public.layover_external_events(event_id) ON DELETE CASCADE,
 after_session_id uuid REFERENCES public.layover_sessions(id) ON DELETE SET NULL,
 scan_complete boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.layover_route_work(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_id text NOT NULL REFERENCES public.layover_external_events(event_id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','leased','retry','done','obsolete')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,
 lease_until timestamptz,
 reason text CHECK(reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{1,100}$'),
 snapshot_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 UNIQUE(event_id,session_id),
 CHECK((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((state IN('done','obsolete'))=(settled_at IS NOT NULL))
);
CREATE INDEX layover_route_work_due_idx ON public.layover_route_work(next_attempt_at,created_at) WHERE state IN('pending','retry','leased');
CREATE INDEX layover_route_work_session_idx ON public.layover_route_work(session_id);
CREATE INDEX layover_route_work_user_idx ON public.layover_route_work(user_id);
ALTER TABLE public.layover_route_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layover_route_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_route_dispatches,public.layover_route_work FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.layover_route_dispatches,public.layover_route_work TO service_role;

CREATE FUNCTION public.layover_route_fanout_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 SELECT NOT EXISTS(SELECT required FROM unnest(ARRAY['layover_route_fanout_enabled','layover_route_subjects_enabled','layover_event_ingest_enabled','layover_decision_persistence_enabled','layover_canonical_snapshot_enabled','layover_recommendation_snapshot_enabled','layover_recommendation_status_enabled','layover_stable_recommendation_ids_enabled']) required WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag=required AND enabled))
$fn$;
REVOKE ALL ON FUNCTION public.layover_route_fanout_ready() FROM PUBLIC,anon,authenticated,service_role;

-- No row can reveal an origin: these are server-minted opaque measured-route identities.
CREATE FUNCTION public.layover_route_watch_state(p_event text,p_session uuid,p_user uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 SELECT jsonb_build_object('refs',coalesce(jsonb_agg(DISTINCT b.route_ref),'[]'::jsonb),'revision',md5(coalesce(jsonb_agg(jsonb_build_array(b.id,b.route_ref,b.snapshot_id) ORDER BY b.id)::text,'[]')))
 FROM public.layover_route_subjects b JOIN public.layover_external_events e ON e.event_id=p_event JOIN public.layover_sessions s ON s.id=b.session_id AND s.user_id=b.user_id
 WHERE b.session_id=p_session AND b.user_id=p_user AND date_trunc('milliseconds',s.created_at)<=e.received_at
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.subject_refs)='array' THEN e.subject_refs ELSE '[]'::jsonb END) x WHERE x->>'kind'='route' AND x->>'ref'=b.route_ref)
$fn$;
REVOKE ALL ON FUNCTION public.layover_route_watch_state(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.layover_route_fanout_claim(p_limit integer DEFAULT 200) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE e public.layover_external_events%ROWTYPE; d public.layover_route_dispatches%ROWTYPE; w public.layover_route_work%ROWTYPE; s public.layover_sessions%ROWTYPE; r record; page_count integer=0; scanned integer=0; tasks jsonb='[]'; watch jsonb; token uuid; stamp timestamptz; why text;
BEGIN
 IF NOT public.layover_route_fanout_ready() THEN RAISE EXCEPTION 'route_fanout_disabled'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'route_fanout_limit'; END IF;
 -- One keyset page per tick. Mixed subject envelopes are deliberately NOT claimed.
 SELECT q.* INTO e FROM public.layover_external_events q LEFT JOIN public.layover_route_dispatches x ON x.event_id=q.event_id
 WHERE q.processed_at IS NULL AND q.event_type='mobility.route_degraded' AND coalesce(x.scan_complete,false)=false
 AND jsonb_array_length(CASE WHEN jsonb_typeof(q.subject_refs)='array' THEN q.subject_refs ELSE '[]'::jsonb END) BETWEEN 1 AND 64
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.subject_refs)='array' THEN q.subject_refs ELSE '[]'::jsonb END) ref WHERE ref->>'kind' IS DISTINCT FROM 'route' OR coalesce(ref->>'ref','') !~ '^layover-route:v1:[a-f0-9]{64}$')
 ORDER BY coalesce(x.updated_at,q.received_at),q.event_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
 IF FOUND THEN
  INSERT INTO public.layover_route_dispatches(event_id) VALUES(e.event_id) ON CONFLICT DO NOTHING;
  SELECT * INTO d FROM public.layover_route_dispatches WHERE event_id=e.event_id FOR UPDATE;
  FOR r IN SELECT DISTINCT b.session_id,s0.user_id FROM public.layover_route_subjects b JOIN public.layover_sessions s0 ON s0.id=b.session_id AND s0.user_id=b.user_id
   WHERE (d.after_session_id IS NULL OR b.session_id>d.after_session_id) AND date_trunc('milliseconds',s0.created_at)<=e.received_at
    AND s0.status IN('active','returning') AND s0.departure_time>clock_timestamp() AND e.occurred_at<=coalesce(s0.boarding_time,s0.departure_time)
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.subject_refs)='array' THEN e.subject_refs ELSE '[]'::jsonb END) ref WHERE ref->>'ref'=b.route_ref)
   ORDER BY b.session_id,s0.user_id LIMIT p_limit+1
  LOOP
   page_count=page_count+1;IF page_count>p_limit THEN EXIT;END IF;
   INSERT INTO public.layover_route_work(event_id,session_id,user_id) VALUES(e.event_id,r.session_id,r.user_id) ON CONFLICT(event_id,session_id) DO NOTHING;
   d.after_session_id=r.session_id;scanned=scanned+1;
  END LOOP;
  UPDATE public.layover_route_dispatches SET after_session_id=d.after_session_id,scan_complete=(page_count<=p_limit),updated_at=clock_timestamp() WHERE event_id=e.event_id;
 END IF;
 -- Independent from scanning: retry older work and reclaim expired leases, without resending completed work.
 FOR w IN SELECT * FROM public.layover_route_work WHERE (state IN('pending','retry') AND next_attempt_at<=clock_timestamp()) OR (state='leased' AND lease_until<=clock_timestamp()) ORDER BY next_attempt_at,created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
 LOOP
  SELECT * INTO e FROM public.layover_external_events WHERE event_id=w.event_id;
  SELECT * INTO s FROM public.layover_sessions WHERE id=w.session_id;
  why=NULL;
  IF NOT FOUND OR s.user_id<>w.user_id THEN why='owner_changed';
  ELSIF s.status NOT IN('active','returning') THEN why='session_closed';
  ELSIF s.departure_time<=clock_timestamp() THEN why='session_departed';
  ELSIF e.occurred_at>coalesce(s.boarding_time,s.departure_time) THEN why='event_after_cutoff';END IF;
  watch=public.layover_route_watch_state(w.event_id,w.session_id,w.user_id);
  IF why IS NULL AND jsonb_array_length(watch->'refs')=0 THEN why='route_no_longer_watched';END IF;
  IF why IS NOT NULL THEN
   UPDATE public.layover_route_work SET state='obsolete',reason=why,settled_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=w.id;
   CONTINUE;
  END IF;
  token=gen_random_uuid();stamp=clock_timestamp();
  UPDATE public.layover_route_work SET state='leased',attempts=attempts+1,lease_token=token,lease_until=stamp+interval '5 minutes',reason=NULL WHERE id=w.id;
  SELECT * INTO e FROM public.layover_external_events WHERE event_id=w.event_id;
  tasks=tasks||jsonb_build_array(jsonb_build_object('event',to_jsonb(e),'session',to_jsonb(s),'token',token,'workId',w.id,'claimedAt',stamp,'sessionRevision',md5(to_jsonb(s)::text),'routeRevision',watch->>'revision','routeRefs',watch->'refs'));
 END LOOP;
 -- No processed stamp while undiscovered or unfinished work remains. A zero-match event is a real completed scan.
 UPDATE public.layover_external_events q SET processed_at=clock_timestamp() WHERE q.event_id IN(
  SELECT x.event_id FROM public.layover_route_dispatches x JOIN public.layover_external_events p ON p.event_id=x.event_id WHERE x.scan_complete AND p.processed_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.layover_route_work work WHERE work.event_id=x.event_id AND work.state NOT IN('done','obsolete')) ORDER BY x.updated_at LIMIT 200 FOR UPDATE OF p SKIP LOCKED);
 RETURN jsonb_build_object('scanned',scanned,'tasks',tasks,'hasMore',EXISTS(SELECT 1 FROM public.layover_external_events q WHERE q.processed_at IS NULL AND q.event_type='mobility.route_degraded' AND jsonb_array_length(CASE WHEN jsonb_typeof(q.subject_refs)='array' THEN q.subject_refs ELSE '[]'::jsonb END) BETWEEN 1 AND 64 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.subject_refs)='array' THEN q.subject_refs ELSE '[]'::jsonb END) ref WHERE ref->>'kind' IS DISTINCT FROM 'route' OR coalesce(ref->>'ref','') !~ '^layover-route:v1:[a-f0-9]{64}$')));
END $fn$;
REVOKE ALL ON FUNCTION public.layover_route_fanout_claim(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_route_fanout_claim(integer) TO service_role;

CREATE FUNCTION public.layover_route_fanout_retry(p_event text,p_session uuid,p_token uuid,p_reason text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE n integer;
BEGIN
 IF NOT public.layover_route_fanout_ready() THEN RAISE EXCEPTION 'route_fanout_disabled';END IF;
 IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{1,100}$' THEN RAISE EXCEPTION 'route_fanout_reason';END IF;
 UPDATE public.layover_route_work SET state='retry',reason=p_reason,next_attempt_at=clock_timestamp()+least(3600,power(2,least(attempts,12))) * interval '1 second',lease_token=NULL,lease_until=NULL
 WHERE event_id=p_event AND session_id=p_session AND state='leased' AND lease_token=p_token AND lease_until>clock_timestamp();
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_route_fanout_retry(text,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_route_fanout_retry(text,uuid,uuid,text) TO service_role;

CREATE FUNCTION public.layover_route_fanout_settle(p_event text,p_session uuid,p_token uuid,p_session_revision text,p_route_revision text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE w public.layover_route_work%ROWTYPE;s public.layover_sessions%ROWTYPE;c public.layover_recommendations%ROWTYPE;watch jsonb;snapshot text;version integer;publication jsonb;decision jsonb;reasons text[];history jsonb='[]';why text;
BEGIN
 IF NOT public.layover_route_fanout_ready() THEN RAISE EXCEPTION 'route_fanout_disabled';END IF;
 SELECT * INTO w FROM public.layover_route_work WHERE event_id=p_event AND session_id=p_session FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','lease_lost');END IF;
 IF w.state IN('done','obsolete') THEN RETURN jsonb_build_object('state',w.state,'snapshotId',w.snapshot_id,'reason',w.reason);END IF;
 IF w.state<>'leased' OR w.lease_token IS DISTINCT FROM p_token OR w.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('state','lease_lost');END IF;
 -- Match the canonical writer lock ordering; no computation may race its session revision check.
 PERFORM pg_advisory_xact_lock(hashtextextended('layover_certcomp_version:'||p_session::text,0));
 SELECT * INTO s FROM public.layover_sessions WHERE id=p_session FOR UPDATE;
 IF NOT FOUND OR s.user_id<>w.user_id THEN why='owner_changed';
 ELSIF s.status NOT IN('active','returning') THEN why='session_closed';
 ELSIF s.departure_time<=clock_timestamp() THEN why='session_departed';
 ELSIF (SELECT occurred_at FROM public.layover_external_events WHERE event_id=p_event)>coalesce(s.boarding_time,s.departure_time) THEN why='event_after_cutoff';END IF;
 watch=public.layover_route_watch_state(p_event,p_session,w.user_id);
 IF why IS NULL AND jsonb_array_length(watch->'refs')=0 THEN why='route_no_longer_watched';END IF;
 IF why IS NOT NULL THEN
  UPDATE public.layover_route_work SET state='obsolete',reason=why,settled_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=w.id;
  RETURN jsonb_build_object('state','obsolete','reason',why);
 END IF;
 IF md5(to_jsonb(s)::text) IS DISTINCT FROM p_session_revision OR watch->>'revision' IS DISTINCT FROM p_route_revision THEN RETURN jsonb_build_object('state','revision_changed');END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR p_payload->'computation'->>'session_id' IS DISTINCT FROM p_session::text
 OR p_payload->'computation'->>'user_id' IS DISTINCT FROM w.user_id::text OR p_payload->'budget'->>'session_id' IS DISTINCT FROM p_session::text
 OR p_payload->'returnPlan'->>'session_id' IS DISTINCT FROM p_session::text OR p_payload->'decision'->>'sessionId' IS DISTINCT FROM p_session::text
 OR p_payload->'publication'->'event'->>'eventId' IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'route_fanout_payload_owner';END IF;
 snapshot=p_payload->'computation'->>'snapshot_id';
 IF snapshot IS NULL OR snapshot !~ '^snap:[a-f0-9]{32}$' OR p_payload->'budget'->>'snapshot_id' IS DISTINCT FROM snapshot OR p_payload->'returnPlan'->>'snapshot_id' IS DISTINCT FROM snapshot THEN RAISE EXCEPTION 'route_fanout_snapshot';END IF;
 SELECT snapshot_version INTO version FROM public.layover_certified_computations WHERE snapshot_id=s.active_snapshot_id AND session_id=p_session;
 version=coalesce(version,0);
 -- Reject historical identity reuse; retries after commit see the done checkpoint above.
 IF EXISTS(SELECT 1 FROM public.layover_certified_computations WHERE snapshot_id=snapshot) THEN RAISE EXCEPTION 'route_fanout_snapshot_conflict';END IF;
 INSERT INTO public.layover_certified_computations(session_id,user_id,engine_version,feasibility_version,input_hash,computed_at,verdict,confidence,buffer_percentile,cutoff_at,hard_return_time,total_buffer_min,usable_minutes,inputs,breakdown,estimates,reason_codes,snapshot_id,input_facts,source_refs,rules_applied,ledger_version,expected_active_version) SELECT r.session_id,r.user_id,r.engine_version,r.feasibility_version,r.input_hash,r.computed_at,r.verdict,r.confidence,r.buffer_percentile,r.cutoff_at,r.hard_return_time,r.total_buffer_min,r.usable_minutes,r.inputs,r.breakdown,r.estimates,r.reason_codes,r.snapshot_id,r.input_facts,r.source_refs,r.rules_applied,r.ledger_version,version FROM jsonb_populate_record(NULL::public.layover_certified_computations,p_payload->'computation') r;
 INSERT INTO public.layover_time_budgets(snapshot_id,session_id,scheduled_minutes,deplane_min,immigration_min,baggage_min,exit_min,outbound_min,return_min,security_min,transfer_min,contingency_min,boarding_min,total_buffer_min,usable_minutes,buffer_percentile,computed_at) SELECT r.snapshot_id,r.session_id,r.scheduled_minutes,r.deplane_min,r.immigration_min,r.baggage_min,r.exit_min,r.outbound_min,r.return_min,r.security_min,r.transfer_min,r.contingency_min,r.boarding_min,r.total_buffer_min,r.usable_minutes,r.buffer_percentile,r.computed_at FROM jsonb_populate_record(NULL::public.layover_time_budgets,p_payload->'budget') r;
 INSERT INTO public.layover_return_plans(snapshot_id,session_id,hard_return_by,recommended_return_by,latest_activity_departure_at,risk_band,confidence,reason_codes,computed_at) SELECT r.snapshot_id,r.session_id,r.hard_return_by,r.recommended_return_by,r.latest_activity_departure_at,r.risk_band,r.confidence,r.reason_codes,r.computed_at FROM jsonb_populate_record(NULL::public.layover_return_plans,p_payload->'returnPlan') r;
 -- Optional3893: tighten the already authorized bound timer in this transaction.
 -- OFF touches no product table; ON with unavailable schema refuses settlement.
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_safe_return_product_enabled' AND enabled) THEN
  UPDATE public.layover_safe_return_links SET certified_deadline=(p_payload->'computation'->>'hard_return_time')::timestamptz,certification=p_payload->'publication'->'certification'
  WHERE layover_session_id=p_session AND user_id=w.user_id AND certified_deadline>(p_payload->'computation'->>'hard_return_time')::timestamptz;
 END IF;
 SELECT snapshot_version INTO version FROM public.layover_certified_computations WHERE snapshot_id=snapshot AND session_id=p_session;
 -- Preserve exactly the same evidence projection and reason vocabulary as supersedeCards.
 FOR c IN SELECT * FROM public.layover_recommendations r WHERE r.session_id=p_session AND r.superseded_at IS NULL AND (
  (r.snapshot_id IS NOT NULL AND r.snapshot_id<>snapshot) OR EXISTS(SELECT 1 FROM public.layover_plan_stops stop WHERE stop.session_id=p_session AND stop.recommendation_id=r.id AND stop.id::text IN(SELECT jsonb_array_elements_text(coalesce(p_payload->'publication'->'invalidation'->'noLongerFeasible','[]'::jsonb))))) FOR UPDATE
 LOOP
  reasons=ARRAY[]::text[];
  IF c.snapshot_id IS NOT NULL AND c.snapshot_id<>snapshot THEN reasons=array_append(reasons,'stale_certification');END IF;
  IF EXISTS(SELECT 1 FROM public.layover_plan_stops stop WHERE stop.session_id=p_session AND stop.recommendation_id=c.id AND stop.id::text IN(SELECT jsonb_array_elements_text(coalesce(p_payload->'publication'->'invalidation'->'noLongerFeasible','[]'::jsonb)))) THEN reasons=array_append(reasons,'no_longer_feasible');END IF;
  INSERT INTO public.layover_recommendation_supersessions(session_id,recommendation_id,rec_key,superseded_snapshot_id,superseding_snapshot_id,superseding_snapshot_version,prior_status,reasons,cause,card)
  VALUES(p_session,c.id,c.rec_key,c.snapshot_id,snapshot,version,c.recommendation_status,reasons,'external_event',jsonb_build_object('id',c.id,'rec_key',c.rec_key,'snapshot_id',c.snapshot_id,'rec_type',c.rec_type,'title',c.title,'place_id',c.place_id,'inside_airport',c.inside_airport,'safety_rating',c.safety_rating,'travel_time_min',c.travel_time_min,'activity_time_min',c.activity_time_min,'return_buffer_min',c.return_buffer_min,'hard_return_time',c.hard_return_time,'warning_reason',c.warning_reason,'sort_order',c.sort_order,'recommendation_status',c.recommendation_status,'status_reason',c.status_reason,'risk_band',c.risk_band,'confidence',c.confidence,'utility_score',c.utility_score,'expires_at',c.expires_at,'plan_json',c.plan_json)) ON CONFLICT(recommendation_id,superseding_snapshot_id) DO NOTHING;
  UPDATE public.layover_recommendations SET recommendation_status='SUPERSEDED',status_reason=CASE WHEN 'no_longer_feasible'=ANY(reasons) THEN 'no_longer_feasible' ELSE 'stale_certification' END,superseded_by_snapshot_id=snapshot,superseded_at=clock_timestamp() WHERE id=c.id;
  history=history||jsonb_build_array(jsonb_build_object('recommendationId',c.id,'citedSnapshotId',c.snapshot_id,'why',to_jsonb(reasons)));
 END LOOP;
 publication=((p_payload->'publication')-'snapshotUnavailableReason')||jsonb_build_object('snapshotPersisted',true,'snapshotId',snapshot,'invalidationApplied',jsonb_build_object('applied',true,'currentSnapshotId',snapshot,'currentSnapshotVersion',version,'superseded',history));
 decision=((p_payload->'decision')-'snapshotUnavailableReason')||jsonb_build_object('snapshotId',snapshot);
 -- Same transaction as the work checkpoint: a crash cannot publish the ledger twice.
 INSERT INTO public.layover_events(id,session_id,user_id,event_type,metadata) VALUES(w.id,p_session,w.user_id,'session_updated',jsonb_build_object('replan',publication,'decision',decision));
 UPDATE public.layover_route_work SET state='done',snapshot_id=snapshot,settled_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,reason=NULL WHERE id=w.id;
 -- The next claim pass finalizes the source event. Do not reverse its event/work
 -- lock order here: the atomic ledger and done checkpoint are already committed together.
 RETURN jsonb_build_object('state','done','snapshotId',snapshot);
END $fn$;
REVOKE ALL ON FUNCTION public.layover_route_fanout_settle(text,uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_route_fanout_settle(text,uuid,uuid,text,text,jsonb) TO service_role;

INSERT INTO public.feature_flags(flag,enabled,description) VALUES('layover_route_fanout_enabled',false,'3908: durable leased route event fanout; requires canonical snapshots, route watches and event ingestion') ON CONFLICT(flag) DO NOTHING;
DO $post$ BEGIN
 IF (SELECT count(*) FROM pg_class WHERE oid IN('public.layover_route_dispatches'::regclass,'public.layover_route_work'::regclass) AND relrowsecurity)<>2
 OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN('public.layover_route_dispatches'::regclass,'public.layover_route_work'::regclass))
 OR EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_fanout_enabled' AND enabled IS DISTINCT FROM false)
 THEN RAISE EXCEPTION '3908 private rollout postcondition failed';END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
