-- LOCAL THROWAWAY DATABASE ONLY; independent expectations for the fixture.
do $$
declare m jsonb; t timestamptz := date_trunc('hour',now());
begin
  m := intelligence_monitor.measure('input',t-interval '24 hours',t);
  if (m->>'sample_count')::int <> 62 then raise exception 'request retries counted twice: %',m; end if;
  if (m->>'server_timing_samples')::int <> 60 then raise exception 'malformed/degraded timings counted: %',m; end if;
  if abs((m->>'server_p95_ms')::numeric-570.5)>0.001 then raise exception 'wrong percentile: %',m; end if;
  if (m->>'degraded_requests')::int <> 1 then raise exception 'degradation hidden'; end if;
  m := intelligence_monitor.measure('discovery',t-interval '24 hours',t);
  if (m->>'sample_count')::int <> 1 then raise exception 'analytics masquerading as impressions'; end if;
  if m->'diagnostic_pde_p95_ms' <> 'null'::jsonb then raise exception 'zero-sample percentile fabricated'; end if;
  m := intelligence_monitor.measure('media',t-interval '24 hours',t);
  if (m->>'stalled_assets')::int <> 1 then raise exception 'stalled processing invisible'; end if;
  m := intelligence_monitor.measure('compass',t-interval '24 hours',t);
  if m ? 'content' or m ? 'prompt' then raise exception 'prompt copied'; end if;
end $$;

-- A source outage must be visible per system without killing other collectors.
alter table public.intel_observations rename to unavailable_observations;
select intelligence_monitor.collect();
do $$
begin
  if not exists(select 1 from intelligence_monitor.snapshots where system='community' and state='unreadable' and metrics->>'error_sqlstate'='42P01') then raise exception 'outage hidden'; end if;
  if not exists(select 1 from intelligence_monitor.snapshots where system='sensing' and state='disabled') then raise exception 'disabled sensing reported as healthy'; end if;
  if not exists(select 1 from intelligence_monitor.snapshots where system='input' and state='observed') then raise exception 'one source outage broke other systems'; end if;
end $$;
