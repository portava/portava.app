-- LOCAL ONLY. Checks both schema versions in the same hour, without resetting history.
select intelligence_monitor.collect();
do $$ declare n int; m jsonb; r record; begin
  select count(*) into n from intelligence_monitor.snapshots where window_end=date_trunc('hour',now());
  if n<>13 then raise exception 'expected thirteen systems, got %',n; end if;
  perform intelligence_monitor.collect();
  if (select count(*) from intelligence_monitor.snapshots where window_end=date_trunc('hour',now()))<>13 then raise exception 'duplicate collection'; end if;
  m:=intelligence_monitor.measure('trips',date_trunc('hour',now())-interval '24 hours',date_trunc('hour',now()));
  if m->>'failures'<>'1' or intelligence_monitor.state_for(m,null)<>'needs_attention' then raise exception 'invalid date range hidden'; end if;
  if exists(select 1 from intelligence_monitor.snapshots where metrics::text like '%never-copy-me%') then raise exception 'private payload copied'; end if;
  for r in select oid from pg_proc where pronamespace='intelligence_monitor'::regnamespace loop
    if has_function_privilege('authenticated',r.oid,'execute') or has_function_privilege('service_role',r.oid,'execute') then raise exception 'monitor exposed'; end if;
  end loop;
  if exists(select 1 from intelligence_monitor.snapshots where effectiveness<>'unverified') then raise exception 'unsupported effectiveness claim'; end if;
end $$;
