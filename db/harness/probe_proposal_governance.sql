\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''
\set X '''44444444-4444-4444-4444-444444444444'''

INSERT INTO public.profiles (id, handle) VALUES (:X,'third') ON CONFLICT DO NOTHING;
INSERT INTO public.trip_members (trip_id, user_id, role, status)
  VALUES (:T,:S,'member','accepted'), (:T,:X,'member','accepted') ON CONFLICT DO NOTHING;

\echo '--- CREATE_PROPOSAL records the author and defaults to the narrowest rule'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','CREATE_PROPOSAL','idempotency_key','G1','payload',jsonb_build_object('proposal_type','cancel_plan')))->>'ok';
SELECT 'rule='||decision_rule||' author_is_creator='||(proposed_by = :S)::text FROM trip_proposals;

\echo '--- host rule: the plain member who PROPOSED it may not accept it'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','ACCEPT_PROPOSAL','idempotency_key','G2','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals))))->>'reason';

\echo '--- an ANYONE proposal can be accepted by any crew member'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','CREATE_PROPOSAL','idempotency_key','G3','payload',jsonb_build_object('proposal_type','other','decision_rule','anyone')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:X,'type','ACCEPT_PROPOSAL','idempotency_key','G4','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='anyone'))))->>'ok';
SELECT 'status='||status FROM trip_proposals WHERE decision_rule='anyone';
SELECT '"other" is accepted but NOT applied: '||(payload_json->'result'->'applied'->>'status')||' / '||(payload_json->'result'->'applied'->>'reason') FROM trip_events WHERE type='trip.proposal_accepted' ORDER BY sequence DESC LIMIT 1;

\echo '--- a NON-member cannot accept even an ANYONE proposal'
INSERT INTO public.profiles (id, handle) VALUES ('55555555-5555-5555-5555-555555555555','outsider') ON CONFLICT DO NOTHING;
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id','55555555-5555-5555-5555-555555555555','type','CREATE_PROPOSAL','idempotency_key','G5','payload',jsonb_build_object('proposal_type','other','decision_rule','anyone')))->>'reason';

\echo '--- MAJORITY: the electorate is 3 (owner + two members)'
SELECT 'electorate='||count(*) FROM public.trip_proposal_electorate(:T);
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','CREATE_PROPOSAL','idempotency_key','M1','payload',jsonb_build_object('proposal_type','add_plan','decision_rule','majority','payload_json',jsonb_build_object('plan',jsonb_build_object('title','Voted-in plan','privacy_scope','crew')))))->>'ok';

\echo '--- with no votes at all, accepting is refused and the tally says why'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','M2','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority'))))->>'reason';
SELECT 'plans still='||count(*)||' (the proposal was NOT applied)' FROM trip_plan_items WHERE title='Voted-in plan';

\echo '--- one yes out of three is not a majority'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','VOTE_ON_PROPOSAL','idempotency_key','M3','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority'),'vote','yes')))->>'ok';
SELECT 'tally='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority')))::text;
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','M4','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority'))))->>'reason';

\echo '--- two out of three is'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:X,'type','VOTE_ON_PROPOSAL','idempotency_key','M5','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority'),'vote','yes')))->>'ok';
SELECT 'majority_met='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority'))->>'majority_met');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','M6','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority'))))->>'ok';

\echo '--- AND THE PLAN ACTUALLY EXISTS: acceptance mutated canonical state'
SELECT 'plans='||count(*)||' title='||max(title)||' scope='||max(privacy_scope)||' visibility='||max(visibility) FROM trip_plan_items WHERE title='Voted-in plan';
SELECT 'applied='||(payload_json->'result'->'applied'->>'status')||' effect='||(payload_json->'result'->'applied'->>'effect') FROM trip_events WHERE type='trip.proposal_accepted' ORDER BY sequence DESC LIMIT 1;

\echo '--- a decided proposal takes no further votes'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','VOTE_ON_PROPOSAL','idempotency_key','M7','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority'),'vote','no')))->>'reason';

\echo '--- UNANIMOUS: silence defeats it, an abstention does not'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CREATE_PROPOSAL','idempotency_key','U1','payload',jsonb_build_object('proposal_type','cancel_plan','decision_rule','unanimous','payload_json',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Voted-in plan')))))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','VOTE_ON_PROPOSAL','idempotency_key','U2','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous'),'vote','yes')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','VOTE_ON_PROPOSAL','idempotency_key','U3','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous'),'vote','yes')))->>'ok';
SELECT 'two of three voted -> unanimous_met='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='unanimous'))->>'unanimous_met')||'  <- silence defeats it';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:X,'type','VOTE_ON_PROPOSAL','idempotency_key','U4','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous'),'vote','abstain')))->>'ok';
SELECT 'the third abstains -> unanimous_met='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='unanimous'))->>'unanimous_met')||'  <- an abstention does not block';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','ACCEPT_PROPOSAL','idempotency_key','U5','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous'))))->>'ok';
SELECT 'and the plan is now: '||status||' version='||version FROM trip_plan_items WHERE title='Voted-in plan';

\echo '--- one NO defeats unanimity outright'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CREATE_PROPOSAL','idempotency_key','N1','payload',jsonb_build_object('proposal_type','other','decision_rule','unanimous')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','VOTE_ON_PROPOSAL','idempotency_key','N2','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous' AND proposal_type='other'),'vote','yes')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','VOTE_ON_PROPOSAL','idempotency_key','N3','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous' AND proposal_type='other'),'vote','yes')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:X,'type','VOTE_ON_PROPOSAL','idempotency_key','N4','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous' AND proposal_type='other'),'vote','no')))->>'ok';
SELECT 'unanimous_met='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='unanimous' AND proposal_type='other'))->>'unanimous_met');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','N5','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='unanimous' AND proposal_type='other'))))->>'reason';

\echo '--- a proposal whose payload cannot be carried out is REFUSED and stays pending'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CREATE_PROPOSAL','idempotency_key','P1','payload',jsonb_build_object('proposal_type','add_plan','decision_rule','anyone','payload_json',jsonb_build_object('plan',jsonb_build_object('privacy_scope','crew')))))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','P2','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE proposal_type='add_plan' AND decision_rule='anyone'))))->>'reason';
SELECT 'status='||status||'  <- a decision that could not take effect is not recorded' FROM trip_proposals WHERE proposal_type='add_plan' AND decision_rule='anyone';

\echo '--- votes from someone who LEFT the trip stop counting'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CREATE_PROPOSAL','idempotency_key','L1','payload',jsonb_build_object('proposal_type','other','decision_rule','majority')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','VOTE_ON_PROPOSAL','idempotency_key','L2','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'),'vote','yes')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:X,'type','VOTE_ON_PROPOSAL','idempotency_key','L3','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'),'vote','yes')))->>'ok';
SELECT 'with both present: yes='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'))->>'yes')||' met='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'))->>'majority_met');
DELETE FROM public.trip_members WHERE trip_id=:T AND user_id=:X;
SELECT 'after one leaves: electorate='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'))->>'electorate')||' yes='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'))->>'yes')||' met='||(public.trip_proposal_tally((SELECT id FROM trip_proposals WHERE decision_rule='majority' AND proposal_type='other'))->>'majority_met');

\echo '--- ledger'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
