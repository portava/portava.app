-- Extend the existing private hourly monitor. No change to schedule, serving
-- flags or source rows; no identities, content, locations or tokens retained.
set lock_timeout = '3s';
set statement_timeout = '30s';
alter table intelligence_monitor.snapshots drop constraint snapshots_system_check;
alter table intelligence_monitor.snapshots add constraint snapshots_system_check
  check (system in ('compass','sensing','community','media','discovery','input','wall','map','trips','events','highlights','moments','stamps'));
alter table intelligence_monitor.snapshots alter column collector_version set default 'intelligence-monitor-v2';
alter function intelligence_monitor.measure(text,timestamptz,timestamptz) rename to measure_intelligence_v1;
create function intelligence_monitor.measure(p_system text, p_start timestamptz, p_end timestamptz)
returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare m jsonb;
begin
  if p_start is null or p_end is null or p_start >= p_end or p_end - p_start > interval '24 hours' then
    raise exception 'monitor window must be positive and at most 24 hours';
  end if;
  case p_system
  when 'wall' then
    select jsonb_build_object('sample_count',count(*),'feed_opens',count(*) filter(where event_name='wall_feed_open'),
      'impressions',count(*) filter(where event_name='wall_impression'),'actions',count(*) filter(where event_name='wall_action'),
      'real_world_outcomes',count(*) filter(where event_name='wall_real_world_outcome'),'last_activity',max(occurred_at),
      'limitations',jsonb_build_array('Client telemetry counts are not unique sessions or a feed success rate.','Relevance, accessibility and completeness require live evaluation.')) into m
      from public.wall_telemetry_events where occurred_at >= p_start and occurred_at < p_end;
  when 'map' then
    select jsonb_build_object('sample_count',count(*),'opens',count(*) filter(where event_name='map_opened'),
      'places_opened',count(*) filter(where event_name='place_opened'),'routes_started',count(*) filter(where event_name='route_started'),
      'trip_stops_added',count(*) filter(where event_name='trip_stop_added'),'last_activity',max(received_at),
      'limitations',jsonb_build_array('Telemetry counts are not map render, tile or geolocation success rates.','An off projection flag does not disable legacy map layers.','No coordinates or telemetry payloads retained.')) into m
      from public.map_telemetry_events where received_at >= p_start and received_at < p_end;
  when 'trips' then
    select jsonb_build_object('sample_count',count(*),'created',count(*),
      'invalid_date_ranges',count(*) filter(where end_date < start_date),
      'failures',count(*) filter(where end_date < start_date),'last_activity',max(created_at),
      'limitations',jsonb_build_array('Created rows do not measure failed attempts, collaboration correctness or itinerary feasibility.')) into m
      from public.trips where created_at >= p_start and created_at < p_end;
  when 'events' then
    select jsonb_build_object('sample_count',count(*),'created',count(*),
      'invalid_time_ranges',count(*) filter(where ends_at < starts_at),
      'invalid_capacity_counts',count(*) filter(where going_count < 0 or waitlist_count < 0),
      'failures',count(*) filter(where ends_at < starts_at or going_count < 0 or waitlist_count < 0),'last_activity',max(created_at),
      'limitations',jsonb_build_array('Created rows cannot establish join, waitlist, reminder or nearby-discovery success.')) into m
      from public.events where created_at >= p_start and created_at < p_end;
  when 'highlights' then
    select jsonb_build_object('sample_count',count(*),'created',count(*),
      'archived',count(*) filter(where archived_at is not null),'deleted',count(*) filter(where deleted_at is not null),
      'invalid_expiry',count(*) filter(where expires_at < created_at),
      'failures',count(*) filter(where expires_at < created_at),'last_activity',max(created_at),
      'limitations',jsonb_build_array('Publication rows do not prove media playback, audience enforcement or shared-post resolution.','Archive and deletion counts are normal lifecycle activity.')) into m
      from public.highlights where created_at >= p_start and created_at < p_end;
  when 'moments' then
    select jsonb_build_object('sample_count',count(*),'memories_created',count(*),
      'invalid_time_ranges',count(*) filter(where ends_at < starts_at),
      'failures',count(*) filter(where ends_at < starts_at),'last_activity',max(created_at),
      'live_transition_effectiveness','unmeasured',
      'limitations',jsonb_build_array('Counts personal-memory creation. Wall live transitions are computed on read and have no persisted success denominator.','No memory content or subject identity retained.')) into m
      from public.memories where created_at >= p_start and created_at < p_end;
  when 'stamps' then
    select jsonb_build_object('sample_count',count(*),'awarded',count(*),
      'revoked',count(*) filter(where is_revoked is true),'last_activity',max(created_at),
      'limitations',jsonb_build_array('Award rows do not prove presence evidence, artwork delivery or content-reaction success.','Revocation is normal lifecycle activity, not a system failure.')) into m
      from public.user_stamps where created_at >= p_start and created_at < p_end;
  else return intelligence_monitor.measure_intelligence_v1(p_system,p_start,p_end);
  end case;
  return m;
end $$;

create or replace function intelligence_monitor.collect()
returns uuid language plpgsql security invoker set search_path = pg_catalog as $$
declare
  run uuid := gen_random_uuid(); measured timestamptz := clock_timestamp();
  win_end timestamptz := date_trunc('hour', measured);
  sys text; m jsonb; f jsonb; enabled boolean;
begin
  -- Prevent overlapping manual and scheduled runs; retain one completed batch/hour.
  if not pg_try_advisory_xact_lock(728114, 61113) then return null; end if;
  select run_id into run from intelligence_monitor.snapshots where window_end=win_end limit 1;
  if not found then run := gen_random_uuid(); end if;
  foreach sys in array array['compass','sensing','community','media','discovery','input','wall','map','trips','events','highlights','moments','stamps'] loop
    if exists(select 1 from intelligence_monitor.snapshots s where s.run_id=run and s.system=sys) then continue; end if;
    begin
      select coalesce(jsonb_object_agg(ff.flag,ff.enabled),'{}'::jsonb) into f from public.feature_flags ff
      where ff.flag = any(case sys
        when 'compass' then array['COMPASS_ENABLED']
        when 'sensing' then array['sensing_publication_enabled','sensing_consent_split_enabled','sensing_presence_context_enabled']
        when 'community' then array['intel_capture_quick_signal','intel_claim_projection_crowd','intel_outcome_attribution_enabled']
        when 'media' then array['MEDIA_RANKING_ENABLED','MEDIA_WATCH_STAGE24_RANKING_ENABLED','MEDIA_WORLD_SHELL_ENABLED','media_processing_worker_enabled','media_transcoder_enabled']
        when 'discovery' then array['DISCOVERY_ENGINE_MODE','discovery_serve_log_enabled']
        when 'input' then array['wall_input_intelligence_enabled']
        when 'wall' then array['wall_enabled','wall_live_for_you_enabled','wall_telemetry_enabled']
        when 'map' then array['map_projection_enabled','map_telemetry_enabled','map_world_moments_enabled']
        when 'highlights' then array['highlights_feed_bounded_enabled']
        when 'moments' then array['wall_enabled','wall_moments_enabled']
        when 'stamps' then array['stamp_system_v2_enabled']
        else array[]::text[] end);
      m := intelligence_monitor.measure(sys, win_end-interval '24 hours', win_end);
      -- Only these exact capabilities have a whole-path switch. Other flags
      -- describe individual lanes; a disabled lane does not disable its system.
      enabled := case sys when 'compass' then (f->>'COMPASS_ENABLED')::boolean
        when 'sensing' then (f->>'sensing_publication_enabled')::boolean
        when 'wall' then (f->>'wall_enabled')::boolean else null end;
      insert into intelligence_monitor.snapshots(run_id,system,measured_at,window_start,window_end,state,sample_count,metrics,flags)
      values(run,sys,measured,win_end-interval '24 hours',win_end,intelligence_monitor.state_for(m,enabled),(m->>'sample_count')::bigint,m,f);
    exception when others then
      -- Only SQLSTATE, never SQLERRM: errors can contain private values.
      insert into intelligence_monitor.snapshots(run_id,system,measured_at,window_start,window_end,state,sample_count,metrics,flags)
      values(run,sys,measured,win_end-interval '24 hours',win_end,'unreadable',0,jsonb_build_object('error_sqlstate',SQLSTATE),'{}');
    end;
  end loop;
  -- Retention applies only to the monitor's own anonymous aggregate history.
  delete from intelligence_monitor.snapshots where measured_at < measured-interval '90 days';
  return run;
end $$;

revoke all on all functions in schema intelligence_monitor from public, anon, authenticated, service_role;
