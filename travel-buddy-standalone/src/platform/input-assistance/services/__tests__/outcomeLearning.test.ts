/**
 * Outcome learning, the client's pure half (OD-INPUT-1/2; census G320/G370).
 *
 * The properties under test are the ones the decision names: nothing leaves the
 * device without the opt-in; the gate is bound to the ACCOUNT it was read for;
 * a report is a no-op without consent and never touches more than it should
 * with it; and the per-name sink filter catches an emit that bypassed the
 * reporter.
 *
 * Run: node --test --experimental-strip-types src/platform/input-assistance/services/__tests__/outcomeLearning.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_OUTCOME_TASKS,
  MAX_OUTCOME_ENTITIES,
  OUTCOME_DISCLOSURE_VERSION,
  applyOutcomeConsent,
  beginOutcomeAccount,
  createOutcomeConsentSync,
  currentOutcomeAccount,
  gateOutcomeEvents,
  outcomeLearningConsented,
  parseOutcomeConsentState,
  reportInputTaskOutcome,
  setOutcomePoster,
  stateGrantsOutcomes,
  holdOutcomeWithdrawal, clearOutcomeWithdrawal, isCurrentOutcomeAuthorization, outcomeAuthorizationSignal,
  type OutcomeConsentState,
  type TaskOutcomeBody,
} from '../outcomeLearning.ts';
import { setTelemetrySink, resetTelemetrySink, type InputTelemetryEvent } from '../inputTelemetry.ts';
import { createTelemetryBatcher, type TelemetryBatch } from '../telemetryBatcher.ts';

const FIELD = { fieldId: 'trip.destination', context: 'trip_destination' as const };
const STATE: OutcomeConsentState = {
  available: true, enabled: true, consentVersion: OUTCOME_DISCLOSURE_VERSION,
  consentedAt: '2026-10-05T00:00:00.000Z', withdrawnAt: null,
  currentDisclosureVersion: OUTCOME_DISCLOSURE_VERSION, retentionDays: 30,
};

function capture(): { events: InputTelemetryEvent[]; done: () => void } {
  const events: InputTelemetryEvent[] = [];
  setTelemetrySink((e) => { events.push(e); });
  return { events, done: () => resetTelemetrySink() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a missing, withdrawn, obsolete-version or malformed grant cannot authorize learning', () => {
  beginOutcomeAccount('grant-validation');
  applyOutcomeConsent('grant-validation', true);
  assert.equal(outcomeLearningConsented(), false);
  for (const state of [
    {...STATE, consentedAt:null}, {...STATE, consentedAt:'private text'},
    {...STATE, withdrawnAt:'2026-11-13T00:00:00Z'}, {...STATE, consentVersion:'old'},
  ]) assert.equal(stateGrantsOutcomes(state), false);
});

test('buffered outcomes are discarded on withdrawal and cannot revive after regrant', async () => {
  const batches: TelemetryBatch[] = [];
  const batcher = createTelemetryBatcher({sessionId:'test',schedule:()=>{},post:async batch=>{batches.push(batch);return {ok:true};}});
  const sink = gateOutcomeEvents(batcher.sink);
  beginOutcomeAccount('queued-grant'); applyOutcomeConsent('queued-grant',true,STATE.consentedAt);
  sink({name:'downstream_task_completed',context:'trip_destination',fieldId:'trip.destination',at:1,props:{task:'trip_created',ok:true}});
  sink({name:'input_opened',context:'trip_destination',fieldId:'trip.destination',at:1});
  holdOutcomeWithdrawal('queued-grant');
  clearOutcomeWithdrawal('queued-grant'); applyOutcomeConsent('queued-grant',true,'2026-11-13T00:00:00Z');
  await batcher.flush();
  assert.deepEqual(batches[0]!.events.map(e=>e.name),['input_opened']);
  assert.equal(batcher.dropped(),1);
});

test('wire outcomes contain grant metadata but no account or local authorization proof', async () => {
  let batch: TelemetryBatch | undefined;
  const batcher = createTelemetryBatcher({sessionId:'opaque',schedule:()=>{},post:async value=>{batch=value;return {ok:true};}});
  beginOutcomeAccount('private-account-id'); applyOutcomeConsent('private-account-id',true,STATE.consentedAt);
  gateOutcomeEvents(batcher.sink)({name:'downstream_task_completed',context:'trip_destination',fieldId:'trip.destination',at:1,props:{task:'trip_created',ok:true}});
  await batcher.flush();
  assert.equal(batch!.events[0]!.outcomeConsentedAt,STATE.consentedAt);
  assert.deepEqual(batch!.events[0]!.props,{task:'trip_created',ok:true});
  assert.ok(!JSON.stringify(batch).includes('private-account-id'));
});

test('in-flight authorization aborts immediately on withdrawal or A-to-B-to-A account changes', () => {
  for (const change of [()=>holdOutcomeWithdrawal('request-owner'),()=>{beginOutcomeAccount('other');beginOutcomeAccount('request-owner');}]) {
    clearOutcomeWithdrawal('request-owner'); beginOutcomeAccount('request-owner'); applyOutcomeConsent('request-owner',true,STATE.consentedAt);
    let body: TaskOutcomeBody | undefined;
    reportInputTaskOutcome(FIELD,'trip_created',true,[{entityType:'city',entityId:'c1'}],{post:async b=>{body=b;return true;}});
    const request = outcomeAuthorizationSignal([body!]);
    assert.equal(request.signal.aborted,false);
    change();
    assert.equal(request.signal.aborted,true);
    applyOutcomeConsent('request-owner',true,STATE.consentedAt);
    assert.equal(isCurrentOutcomeAuthorization(body!),false);
    request.dispose();
  }
  clearOutcomeWithdrawal('request-owner');
});

test('late boot and consent answers cannot override a newer auth event or withdrawal', async () => {
  let auth!: (account:string|null)=>void, boot!: (account:string|null)=>void, answer!: (state:OutcomeConsentState)=>void;
  const stop=createOutcomeConsentSync({subscribeAuth:cb=>{auth=cb;return()=>{};},currentUserId:()=>new Promise(resolve=>{boot=resolve;}),fetchConsent:()=>new Promise(resolve=>{answer=resolve;}),post:async()=>true});
  auth('new-owner'); boot('stale-owner'); await tick();
  assert.equal(currentOutcomeAccount(),'new-owner');
  holdOutcomeWithdrawal('new-owner'); answer(STATE); await tick();
  assert.equal(outcomeLearningConsented(),false);
  stop(); clearOutcomeWithdrawal('new-owner');
});

test('teardown invalidates an unresolved initial account lookup', async () => {
  let boot!: (account:string|null)=>void;
  const stop=createOutcomeConsentSync({subscribeAuth:()=>()=>{},currentUserId:()=>new Promise(resolve=>{boot=resolve;}),fetchConsent:async()=>STATE,post:async()=>true});
  stop(); boot('disposed-owner'); await tick();
  assert.equal(currentOutcomeAccount(),null);
  assert.equal(outcomeLearningConsented(),false);
});

test('a synchronous auth notification takes precedence over the bootstrap account lookup', async () => {
  const stop=createOutcomeConsentSync({subscribeAuth:cb=>{cb('current-owner');return()=>{};},
    currentUserId:async()=> 'stale-owner',fetchConsent:async()=>STATE,post:async()=>true});
  await tick();
  assert.equal(currentOutcomeAccount(),'current-owner');
  assert.equal(outcomeLearningConsented(),true);
  stop();
});

test('the gate is CLOSED by default and closes again on every account change', () => {
  beginOutcomeAccount(null);
  assert.equal(outcomeLearningConsented(), false);
  beginOutcomeAccount('u1');
  assert.equal(outcomeLearningConsented(), false, 'a new account starts closed');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  assert.equal(outcomeLearningConsented(), true);
  beginOutcomeAccount('u2');
  assert.equal(outcomeLearningConsented(), false, 'switching account closes it');
});

test('an answer for a PREVIOUS account never opens the gate for the current one', () => {
  beginOutcomeAccount('u2');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  assert.equal(outcomeLearningConsented(), false);
  applyOutcomeConsent(null, true, '2026-10-05T00:00:00.000Z');
  assert.equal(outcomeLearningConsented(), false, 'signed out is never consented');
});

test('without consent a report does NOTHING — no event, no request', () => {
  beginOutcomeAccount('u1');
  const { events, done } = capture();
  const posts: TaskOutcomeBody[] = [];
  try {
    const r = reportInputTaskOutcome(FIELD, 'trip_created', true, [{ entityType: 'city', entityId: 'c1' }], {
      post: async (b) => { posts.push(b); return true; },
    });
    assert.equal(r, 'not_consented');
    assert.equal(events.length, 0);
    assert.equal(posts.length, 0);
  } finally {
    done();
  }
});

test('with consent: the §44 event carries {task, ok} only, and a success credits its entities', async () => {
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  const { events, done } = capture();
  const posts: TaskOutcomeBody[] = [];
  try {
    const r = reportInputTaskOutcome(FIELD, 'trip_created', true, [{ entityType: 'city', entityId: 'c1' }], {
      post: async (b) => { posts.push(b); return true; },
    });
    await tick();
    assert.equal(r, 'reported');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, 'downstream_task_completed');
    assert.deepEqual(events[0]!.props, { task: 'trip_created', ok: true });
    assert.ok(!JSON.stringify(events[0]).includes('c1'), 'the shared stream never carries the entity');
    assert.deepEqual(posts, [{
      context: 'trip_destination', fieldId: 'trip.destination', task: 'trip_created', ok: true,
      outcomeConsentedAt: STATE.consentedAt!,
      entities: [{ entityType: 'city', entityId: 'c1' }],
    }]);
  } finally {
    done();
    beginOutcomeAccount(null);
  }
});

test('a FAILED task is reported as failed and credits nothing', async () => {
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  const { events, done } = capture();
  const posts: TaskOutcomeBody[] = [];
  try {
    reportInputTaskOutcome(FIELD, 'trip_created', false, [{ entityType: 'city', entityId: 'c1' }], {
      post: async (b) => { posts.push(b); return true; },
    });
    await tick();
    assert.deepEqual(events.map((e) => e.props), [{ task: 'trip_created', ok: false }]);
    assert.equal(posts.length, 0);
  } finally {
    done();
    beginOutcomeAccount(null);
  }
});

test('credited entities are bounded and malformed ones are dropped', async () => {
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  const posts: TaskOutcomeBody[] = [];
  const many = Array.from({ length: 15 }, (_, i) => ({ entityType: 'city', entityId: `c${i}` }));
  reportInputTaskOutcome(FIELD, 'trip_created', true, [{ entityType: 'city', entityId: '' }, ...many], {
    post: async (b) => { posts.push(b); return true; },
  });
  await tick();
  assert.equal(posts[0]!.entities.length, MAX_OUTCOME_ENTITIES);
  assert.ok(posts[0]!.entities.every((e) => e.entityId.length > 0));
  beginOutcomeAccount(null);
});

test('a rejecting poster never surfaces to the caller', async () => {
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  assert.equal(
    reportInputTaskOutcome(FIELD, 'trip_created', true, [{ entityType: 'city', entityId: 'c1' }], {
      post: async () => { throw new Error('offline'); },
    }),
    'reported',
  );
  await tick();
  beginOutcomeAccount(null);
});

test('the sink filter drops downstream_task_completed without consent and passes everything else', () => {
  const seen: string[] = [];
  const sink = gateOutcomeEvents((e) => { seen.push(e.name); });
  const ev = (name: InputTelemetryEvent['name']): InputTelemetryEvent => ({ name, fieldId: 'f', context: 'global_search', at: 0 });
  beginOutcomeAccount('u1');
  sink(ev('suggestion_selected'));
  sink(ev('downstream_task_completed'));
  assert.deepEqual(seen, ['suggestion_selected']);
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  sink(ev('downstream_task_completed'));
  assert.deepEqual(seen, ['suggestion_selected', 'downstream_task_completed']);
  beginOutcomeAccount(null);
});

test('only the server\'s exact shape is a state; a grant needs it OFFERED and ON', () => {
  assert.equal(parseOutcomeConsentState(null), null);
  assert.equal(parseOutcomeConsentState({ enabled: true }), null, 'missing fields are unreadable, not off');
  const s = parseOutcomeConsentState({ ...STATE, extra: 1 });
  assert.ok(s);
  assert.equal(stateGrantsOutcomes(s), true);
  assert.equal(stateGrantsOutcomes({ ...STATE, available: false }), false, 'flag off grants nothing');
  assert.equal(stateGrantsOutcomes({ ...STATE, enabled: false }), false);
  assert.equal(stateGrantsOutcomes(null), false);
});

test('the sync opens the gate for the signed-in account that opted in, and closes it on switch', async () => {
  let listener: ((u: string | null) => void) | null = null;
  const answers: Record<string, OutcomeConsentState | null> = { u1: STATE, u2: { ...STATE, enabled: false } };
  const stop = createOutcomeConsentSync({
    subscribeAuth: (cb) => { listener = cb; return () => { listener = null; }; },
    currentUserId: async () => 'u1',
    fetchConsent: async () => answers[(await Promise.resolve(currentAccountForTest()))] ?? null,
    post: async () => true,
  });
  await tick(); await tick();
  assert.equal(outcomeLearningConsented(), true, 'u1 opted in');
  listener!('u2');
  assert.equal(outcomeLearningConsented(), false, 'closed the moment the account changes');
  await tick(); await tick();
  assert.equal(outcomeLearningConsented(), false, 'u2 did not opt in');
  stop();
  assert.equal(outcomeLearningConsented(), false);
  assert.equal(listener, null, 'teardown unsubscribes');
});

test('a failed consent read leaves the gate closed', async () => {
  const stop = createOutcomeConsentSync({
    subscribeAuth: () => () => {},
    currentUserId: async () => 'u1',
    fetchConsent: async () => { throw new Error('offline'); },
    post: async () => true,
  });
  await tick(); await tick();
  assert.equal(outcomeLearningConsented(), false);
  stop();
});

test('teardown unbinds the poster — a report after it credits nothing', async () => {
  const posts: TaskOutcomeBody[] = [];
  const stop = createOutcomeConsentSync({
    subscribeAuth: () => () => {},
    currentUserId: async () => 'u1',
    fetchConsent: async () => STATE,
    post: async (b) => { posts.push(b); return true; },
  });
  await tick(); await tick();
  stop();
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true, '2026-10-05T00:00:00.000Z');
  reportInputTaskOutcome(FIELD, 'trip_created', true, [{ entityType: 'city', entityId: 'c1' }]);
  await tick();
  assert.equal(posts.length, 0);
  setOutcomePoster(null);
  beginOutcomeAccount(null);
});

test('the task vocabulary is closed and matches the server', () => {
  assert.deepEqual([...INPUT_OUTCOME_TASKS], ['trip_created', 'trip_destinations_saved', 'event_created', 'message_sent']);
});

// The account whose consent the sync is currently reading (test helper).
function currentAccountForTest(): string {
  return currentOutcomeAccount() ?? '';
}
