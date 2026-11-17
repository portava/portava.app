-- Non-destructive checks, runnable on CI and production after migration.
do $$
declare n integer; role_name text;
begin
  if intelligence_monitor.state_for('{"sample_count":0}',true) <> 'no_data' then raise exception 'zero data must not pass'; end if;
  if intelligence_monitor.state_for('{"sample_count":0}',false) <> 'disabled' then raise exception 'disabled must remain explicit'; end if;
  if intelligence_monitor.state_for('{"sample_count":500,"failures":1}',true) <> 'needs_attention' then raise exception 'failure must remain visible'; end if;
  if intelligence_monitor.state_for('{"sample_count":500}',true) <> 'observed' then raise exception 'observations are not grades'; end if;
  if intelligence_monitor.state_for('{"error_sqlstate":"42P01"}',true) <> 'unreadable' then raise exception 'unreadable must not become zero'; end if;
  if intelligence_monitor.state_for('{"privacy_key_violations":1}',false) <> 'needs_attention' then raise exception 'disabled must not hide a privacy alarm'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(role_name,'intelligence_monitor','USAGE') then raise exception 'unexpected schema grant: %',role_name; end if;
    if has_table_privilege(role_name,'intelligence_monitor.snapshots','SELECT') then raise exception 'unexpected table grant: %',role_name; end if;
    if has_function_privilege(role_name,'intelligence_monitor.collect()','EXECUTE') then raise exception 'unexpected collector grant: %',role_name; end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='intelligence_monitor' and p.prosecdef;
  if n <> 0 then raise exception 'monitor must not use security definer'; end if;
  if not (select relrowsecurity from pg_class where oid='intelligence_monitor.snapshots'::regclass) then raise exception 'RLS missing'; end if;
end $$;

-- The collector writes only aggregate snapshots. Repeated same-hour collection
-- must reuse the six-row batch rather than manufacture extra measurements.
begin;
select intelligence_monitor.collect();
do $$
declare first_run uuid; second_run uuid; n integer;
begin
  first_run := intelligence_monitor.collect();
  second_run := intelligence_monitor.collect();
  if first_run is distinct from second_run then raise exception 'same-hour collection not idempotent'; end if;
  select count(*) into n from intelligence_monitor.snapshots where run_id=first_run;
  if n <> 6 then raise exception 'expected six systems, got %',n; end if;
  if exists(select 1 from intelligence_monitor.snapshots where run_id=first_run and state='unreadable') then raise exception 'collector source read failed'; end if;
  if exists(select 1 from intelligence_monitor.snapshots where run_id=first_run and effectiveness <> 'unverified') then raise exception 'operational data fabricated an effectiveness grade'; end if;
  if exists(select 1 from intelligence_monitor.snapshots where run_id=first_run and metrics ?| array['content','prompt','actor_id','user_id','lat','lng','contributor_token']) then raise exception 'private data in snapshot'; end if;
end $$;
rollback;
