-- Operational monitoring only. Never creates test users, calls models, changes
-- serving flags, or copies prompts, coordinates, actor ids or media into history.
-- Apply through the Supabase migration API; no application deployment required.
set lock_timeout = '3s';
set statement_timeout = '30s';

create schema intelligence_monitor;
revoke all on schema intelligence_monitor from public, anon, authenticated, service_role;

create table intelligence_monitor.snapshots (
  run_id uuid not null,
  system text not null check (system in ('compass','sensing','community','media','discovery','input')),
  measured_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  state text not null check (state in ('observed','needs_attention','no_data','disabled','unreadable')),
  sample_count bigint not null check (sample_count >= 0),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  flags jsonb not null check (jsonb_typeof(flags) = 'object'),
  effectiveness text not null default 'unverified' check (effectiveness = 'unverified'),
  collector_version text not null default 'intelligence-monitor-v1',
  primary key (run_id, system),
  check (window_start < window_end)
);
create index snapshots_system_time on intelligence_monitor.snapshots(system, measured_at desc);
create index snapshots_retention on intelligence_monitor.snapshots(measured_at);
alter table intelligence_monitor.snapshots enable row level security;
revoke all on intelligence_monitor.snapshots from public, anon, authenticated, service_role;

-- This badge reports operational observations, never an effectiveness grade.
create function intelligence_monitor.state_for(m jsonb, enabled boolean)
returns text language sql immutable security invoker set search_path = pg_catalog as $$
  select case
    when m ? 'error_sqlstate' then 'unreadable'
    when coalesce((m->>'privacy_key_violations')::bigint, 0) > 0 then 'needs_attention'
    when enabled is false then 'disabled'
    when coalesce((m->>'failures')::bigint, 0) > 0
      or coalesce((m->>'stalled_assets')::bigint, 0) > 0 then 'needs_attention'
    when coalesce((m->>'sample_count')::bigint, 0) = 0 then 'no_data'
    else 'observed' end
$$;

create function intelligence_monitor.measure(p_system text, p_start timestamptz, p_end timestamptz)
returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare m jsonb; extra jsonb;
begin
  if p_start is null or p_end is null or p_start >= p_end or p_end - p_start > interval '24 hours' then
    raise exception 'monitor window must be positive and at most 24 hours';
  end if;
  case p_system
  when 'compass' then
    select jsonb_build_object(
      'sample_count', count(*) filter (where role='user'),
      'user_turns', count(*) filter (where role='user'),
      'assistant_replies', count(*) filter (where role='assistant'),
      'failures', count(*) filter (where role='system-event' and content='assistant_unavailable'),
      'last_activity', max(created_at), 'latency_p95_ms', null,
      'limitations', jsonb_build_array('Persisted conversation events only; pre-persistence failures are not measured.', 'Reply counts are not paired success rates.', 'Answer usefulness and factual accuracy require adjudication.')
    ) into m from public.compass_conversation_messages where created_at >= p_start and created_at < p_end;
  when 'sensing' then
    select jsonb_build_object('sample_count', count(*), 'anonymous_contributions', count(*),
      'last_activity', max(created_at)) into m
      from public.sensing_anon_contributions where created_at >= p_start and created_at < p_end;
    select jsonb_build_object('publications',count(*),
      'unexpired_publications',count(*) filter (where expires_at > p_end),
      'limitations',jsonb_build_array('Anonymous aggregate volumes only; no contributor linking.', 'Disabled publication is not a system failure.', 'Field accuracy and device battery cost are not measured.')) into extra
      from public.sensing_published_aggregates where published_at >= p_start and published_at < p_end;
    m := m || extra;
  when 'community' then
    select jsonb_build_object('sample_count',count(*), 'observations_received', count(*),
      'last_activity',max(received_at)) into m from public.intel_observations where received_at >= p_start and received_at < p_end;
    select jsonb_build_object('current_eligible_snapshots',count(*) filter (where privacy_eligible and expires_at > p_end),
      'privacy_withheld_snapshots',count(*) filter (where not privacy_eligible),
      'limitations',jsonb_build_array('Snapshot counts are not independent witnesses.', 'Reliability and usefulness need independent outcomes; confidence is not measured accuracy.')) into extra
      from public.intel_state_snapshots where computed_at >= p_start and computed_at < p_end;
    m := m || extra;
  when 'media' then
    select jsonb_build_object('sample_count',count(*), 'assets_created',count(*),
      'ready_assets',count(*) filter (where processing_status='ready'),
      'failures',count(*) filter (where processing_status='failed'),
      'stalled_assets',count(*) filter (where processing_status in ('pending','processing') and created_at < p_end - interval '1 hour'),
      'future_capture_timestamps',count(*) filter (where captured_at > p_end),
      'last_activity',max(created_at),
      'limitations',jsonb_build_array('Asset processing health is not feed relevance or playback success.', 'Only assets created in the observation window are included.', 'Personalization effectiveness needs serving and outcome evaluation.')) into m
      from public.media_assets where created_at >= p_start and created_at < p_end and deleted_at is null;
  when 'discovery' then
    -- Exclude analytics rows: they are neither impressions nor outcomes.
    select jsonb_build_object('sample_count',count(*) filter (where outcome='impression'),
      'impressions', count(*) filter (where outcome='impression'),
      'taps',count(*) filter (where outcome='tap'), 'saves',count(*) filter (where outcome='save'),
      'dismissals',count(*) filter (where outcome='dismiss'), 'last_activity',max(served_at)) into m
      from public.rank_events where surface='discovery' and served_at >= p_start and served_at < p_end and outcome <> 'analytics';
    -- Shadow diagnostic timings are separate from ordinary production requests.
    select jsonb_build_object('diagnostic_serves', count(*),
      'diagnostic_pde_timing_samples',count(*) filter (where pde_ms >= 0),
      'diagnostic_pde_p95_ms', case when count(*) filter (where pde_ms >= 0) >= 60 then
        percentile_cont(0.95) within group (order by pde_ms) filter (where pde_ms >= 0) else null end,
      'limitations',jsonb_build_array('Impressions count item exposures, not requests or unique people.', 'Outcome counts are not a causal conversion rate.', 'Diagnostic timing is unavailable without 60 valid samples; photo coverage and live API success are not measured.')) into extra
      from public.discovery_shadow_serves where observed_at >= p_start and observed_at < p_end;
    m := m || extra;
  when 'input' then
    -- Retries of the same request event count once. Keys never leave the CTE.
    with recent as materialized (
      select distinct on (session_id, coalesce(request_id, id::text), event_name)
        event_name, received_at, props
      from public.input_assistance_telemetry_events
      where received_at >= p_start and received_at < p_end
      order by session_id, coalesce(request_id, id::text), event_name, received_at desc, id desc
    ), typed as (
      select *, case when event_name='suggestion_request_completed'
        and props->>'degraded' is distinct from 'true'
        and jsonb_typeof(props->'serverMs')='number'
        then case when (props->>'serverMs')::numeric between 0 and 3600000
          then (props->>'serverMs')::numeric else null end else null end as server_ms,
        case when event_name='suggestion_request_completed'
        and props->>'degraded' is distinct from 'true'
        and jsonb_typeof(props->'clientMs')='number'
        then case when (props->>'clientMs')::numeric between 0 and 3600000
          then (props->>'clientMs')::numeric else null end else null end as client_ms
      from recent
    ) select jsonb_build_object(
      'sample_count',count(*) filter (where event_name='suggestion_request_completed'),
      'completed_requests',count(*) filter (where event_name='suggestion_request_completed'),
      'degraded_requests',count(*) filter (where event_name='suggestion_request_completed' and props->>'degraded'='true'),
      'selections',count(*) filter (where event_name='suggestion_selected'),
      'selection_reversals',count(*) filter (where event_name='selection_reversed'),
      'corrections_accepted',count(*) filter (where event_name='correction_accepted'),
      'tasks_completed',count(*) filter (where event_name='downstream_task_completed' and props->>'ok'='true'),
      'failures',count(*) filter (where event_name in ('action_completed','downstream_task_completed') and props->>'ok'='false'),
      'privacy_key_violations',count(*) filter (where props ?| array['text','query','message','userId','user_id','lat','lng']),
      'server_timing_samples',count(server_ms), 'client_timing_samples',count(client_ms),
      'server_p95_ms',case when count(server_ms)>=60 then percentile_cont(0.95) within group (order by server_ms) else null end,
      'client_p95_ms',case when count(client_ms)>=60 then percentile_cont(0.95) within group (order by client_ms) else null end,
      'last_activity',max(received_at),
      'limitations',jsonb_build_array('Client-reported timing; degraded responses excluded from server latency.', 'Percentiles require 60 valid samples.', 'Selection reversals are counts, not a cohort-matched rate.', 'Raw input, account ids and coordinates are never copied to snapshots.')
    ) into m from typed;
  else raise exception 'unknown monitored system';
  end case;
  return m;
end $$;

create function intelligence_monitor.collect()
returns uuid language plpgsql security invoker set search_path = pg_catalog as $$
declare
  run uuid := gen_random_uuid(); measured timestamptz := clock_timestamp();
  win_end timestamptz := date_trunc('hour', measured);
  sys text; m jsonb; f jsonb; enabled boolean;
begin
  -- Prevent overlapping manual and scheduled runs; retain one completed batch/hour.
  if not pg_try_advisory_xact_lock(728114, 61113) then return null; end if;
  select run_id into run from intelligence_monitor.snapshots where window_end=win_end limit 1;
  if found then return run; end if;
  run := gen_random_uuid();
  foreach sys in array array['compass','sensing','community','media','discovery','input'] loop
    begin
      select coalesce(jsonb_object_agg(ff.flag,ff.enabled),'{}'::jsonb) into f from public.feature_flags ff
      where ff.flag = any(case sys
        when 'compass' then array['COMPASS_ENABLED']
        when 'sensing' then array['sensing_publication_enabled','sensing_consent_split_enabled','sensing_presence_context_enabled']
        when 'community' then array['intel_capture_quick_signal','intel_claim_projection_crowd','intel_outcome_attribution_enabled']
        when 'media' then array['MEDIA_RANKING_ENABLED','MEDIA_WATCH_STAGE24_RANKING_ENABLED','MEDIA_WORLD_SHELL_ENABLED','media_processing_worker_enabled','media_transcoder_enabled']
        when 'discovery' then array['DISCOVERY_ENGINE_MODE','discovery_serve_log_enabled']
        when 'input' then array['wall_input_intelligence_enabled'] end);
      m := intelligence_monitor.measure(sys, win_end-interval '24 hours', win_end);
      -- Only these exact capabilities have a whole-path switch. Other flags
      -- describe individual lanes; a disabled lane does not disable its system.
      enabled := case sys when 'compass' then (f->>'COMPASS_ENABLED')::boolean
        when 'sensing' then (f->>'sensing_publication_enabled')::boolean else null end;
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
comment on schema intelligence_monitor is 'Admin-only operational aggregates. Not a quality grade, truth store or source of personalization.';

-- No network calls or API secrets. The job reads serving tables and writes only
-- its own six aggregate rows. Caller-level timeout also bounds a stalled read.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('intelligence-system-monitor-hourly', '7 * * * *',
  $job$set statement_timeout='20s'; set lock_timeout='2s'; select intelligence_monitor.collect();$job$);
