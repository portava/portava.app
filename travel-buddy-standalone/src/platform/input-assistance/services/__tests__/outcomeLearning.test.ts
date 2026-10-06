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
  type OutcomeConsentState,
  type TaskOutcomeBody,
} from '../outcomeLearning.ts';
import { setTelemetrySink, resetTelemetrySink, type InputTelemetryEvent } from '../inputTelemetry.ts';

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

test('the gate is CLOSED by default and closes again on every account change', () => {
  beginOutcomeAccount(null);
  assert.equal(outcomeLearningConsented(), false);
  beginOutcomeAccount('u1');
  assert.equal(outcomeLearningConsented(), false, 'a new account starts closed');
  applyOutcomeConsent('u1', true);
  assert.equal(outcomeLearningConsented(), true);
  beginOutcomeAccount('u2');
  assert.equal(outcomeLearningConsented(), false, 'switching account closes it');
});

test('an answer for a PREVIOUS account never opens the gate for the current one', () => {
  beginOutcomeAccount('u2');
  applyOutcomeConsent('u1', true);
  assert.equal(outcomeLearningConsented(), false);
  applyOutcomeConsent(null, true);
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
  applyOutcomeConsent('u1', true);
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
      entities: [{ entityType: 'city', entityId: 'c1' }],
    }]);
  } finally {
    done();
    beginOutcomeAccount(null);
  }
});

test('a FAILED task is reported as failed and credits nothing', async () => {
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true);
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
  applyOutcomeConsent('u1', true);
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
  applyOutcomeConsent('u1', true);
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
  applyOutcomeConsent('u1', true);
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
  applyOutcomeConsent('u1', true);
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
