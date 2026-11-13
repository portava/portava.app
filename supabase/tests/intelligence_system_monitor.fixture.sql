-- LOCAL THROWAWAY DATABASE ONLY. Minimal source shapes; synthetic rows never
-- enter a connected project. Run with scripts/test-intelligence-monitor.sh.
create role anon;
create role authenticated;
create role service_role;
create table public.feature_flags(flag text primary key, enabled boolean);
insert into public.feature_flags values ('COMPASS_ENABLED',true),('sensing_publication_enabled',false);
create table public.compass_conversation_messages(role text, content text, created_at timestamptz);
create table public.sensing_anon_contributions(created_at timestamptz);
create table public.sensing_published_aggregates(published_at timestamptz, expires_at timestamptz);
create table public.intel_observations(received_at timestamptz);
create table public.intel_state_snapshots(computed_at timestamptz, expires_at timestamptz, privacy_eligible boolean);
create table public.media_assets(created_at timestamptz, deleted_at timestamptz, captured_at timestamptz, processing_status text);
create table public.rank_events(surface text, outcome text, served_at timestamptz);
create table public.discovery_shadow_serves(observed_at timestamptz,pde_ms integer);
create table public.input_assistance_telemetry_events(id bigint generated always as identity,session_id text,request_id text,event_name text,received_at timestamptz,props jsonb);
insert into public.compass_conversation_messages values('user','synthetic question',date_trunc('hour',now())-interval '1 hour'),('assistant','synthetic answer',date_trunc('hour',now())-interval '1 hour');
insert into public.rank_events values('discovery','impression',date_trunc('hour',now())-interval '1 hour'),('discovery','analytics',date_trunc('hour',now())-interval '1 hour');
insert into public.media_assets values(date_trunc('hour',now())-interval '2 hours',null,null,'pending');
insert into public.input_assistance_telemetry_events(session_id,request_id,event_name,received_at,props)
select 'fixture','request-'||i,'suggestion_request_completed',date_trunc('hour',now())-interval '1 hour',jsonb_build_object('serverMs',i*10,'clientMs',i*12) from generate_series(1,60) as i;
insert into public.input_assistance_telemetry_events(session_id,request_id,event_name,received_at,props) values
 ('fixture','request-1','suggestion_request_completed',date_trunc('hour',now())-interval '59 minutes','{"serverMs":10,"clientMs":12}'),
 ('fixture','malformed','suggestion_request_completed',date_trunc('hour',now())-interval '1 hour','{"serverMs":"not a number","clientMs":-1}'),
 ('fixture','degraded','suggestion_request_completed',date_trunc('hour',now())-interval '1 hour','{"serverMs":99999,"clientMs":99999,"degraded":true}');
