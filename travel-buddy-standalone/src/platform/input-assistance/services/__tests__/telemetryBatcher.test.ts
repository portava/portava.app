/**
 * §44 — the client transport the sink never had.
 *
 * `census-input-intelligence.md` G263 has said, through three passes, that
 * `services/inputTelemetry.ts` emits fourteen declared event names into a sink
 * that is `() => {}`: "Emission is not measurement: in production these events
 * are now produced and dropped." The blocker it names has two halves — a server
 * endpoint to post to, and something on the device that posts. The endpoint now
 * exists (`POST /api/input-assistance/telemetry`). This is the other half.
 *
 * WHAT IS TESTED HERE IS THE BATCHER, WHICH IS PURE. The RN/Supabase wiring
 * that hands it a real `fetch` and a real bearer token lives in
 * `telemetryTransport.ts` and is deliberately NOT imported here: that module
 * pulls the Supabase-backed token helper, which a node:test file must not load.
 * The split is the same one `inputAssistance.ts` already uses.
 *
 * Run: node --import tsx/esm --test src/platform/input-assistance/services/__tests__/telemetryBatcher.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTelemetryBatcher,
  newTelemetrySessionId,
  type TelemetryBatch,
} from '../telemetryBatcher.ts';
import type { InputTelemetryEvent } from '../inputTelemetry.ts';

function ev(name: string, over: Partial<InputTelemetryEvent> = {}): InputTelemetryEvent {
  return {
    name: name as InputTelemetryEvent['name'],
    fieldId: 'global_search',
    context: 'global_search',
    at: 1_700_000_000_000,
    ...over,
  } as InputTelemetryEvent;
}

function recorder() {
  const batches: TelemetryBatch[] = [];
  return {
    batches,
    post: async (b: TelemetryBatch) => {
      batches.push(b);
      return { ok: true };
    },
  };
}

test('§44: buffered events leave as ONE batch, not one request per event', async () => {
  const r = recorder();
  const b = createTelemetryBatcher({ post: r.post, sessionId: 'sess-1', schedule: () => {} });
  b.sink(ev('input_opened'));
  b.sink(ev('suggestion_rendered', { props: { count: 3, types: 'entity' } }));
  b.sink(ev('suggestion_selected', { props: { suggestionType: 'entity' } }));
  assert.equal(r.batches.length, 0, 'nothing leaves before a flush — a keystroke must not be a request');
  await b.flush();
  assert.equal(r.batches.length, 1, 'one request carries all three');
  assert.deepEqual(r.batches[0].events.map((e) => e.name), [
    'input_opened', 'suggestion_rendered', 'suggestion_selected',
  ]);
});

test('§44/§55: the batch carries the session id and each event keeps its serve requestId', async () => {
  // G355's "action/result linkage": an impression cannot be joined to the
  // selection that followed it unless both name the serve they came from.
  const r = recorder();
  const b = createTelemetryBatcher({ post: r.post, sessionId: 'sess-7', schedule: () => {} });
  b.sink(ev('suggestion_rendered', { requestId: 'req-A', props: { count: 2 } }));
  b.sink(ev('suggestion_selected', { requestId: 'req-A' }));
  await b.flush();
  assert.equal(r.batches[0].sessionId, 'sess-7');
  assert.deepEqual(r.batches[0].events.map((e) => e.requestId), ['req-A', 'req-A']);
});

test('§44: a full buffer leaves immediately rather than waiting for the timer', async () => {
  const r = recorder();
  const b = createTelemetryBatcher({ post: r.post, sessionId: 's', maxBatch: 2, schedule: () => {} });
  b.sink(ev('input_opened'));
  assert.equal(r.batches.length, 0);
  b.sink(ev('query_length_changed', { props: { length: 3 } }));
  // The send is started synchronously by the second event; let the microtask run.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(r.batches.length, 1, 'reaching maxBatch flushes without waiting');
  assert.equal(r.batches[0].events.length, 2);
});

test('§38: a refused post never throws to the caller and never retries', async () => {
  // Telemetry must not affect the input UX, and a retry loop against a 503 is
  // how an analytics client turns a server incident into a client incident.
  // The server answers `retryable: true` truthfully; DROPPING is the client's
  // decision and it is the right one for a funnel event.
  let calls = 0;
  const b = createTelemetryBatcher({
    post: async () => { calls += 1; return { ok: false, retryable: true }; },
    sessionId: 's',
    schedule: () => {},
  });
  b.sink(ev('input_opened'));
  await b.flush();
  assert.equal(calls, 1, 'posted once');
  assert.equal(b.dropped(), 1, 'the drop is COUNTED, not invisible');
  await b.flush();
  assert.equal(calls, 1, 'a refused batch is not re-sent');
});

test('§38: a post that THROWS is contained', async () => {
  const b = createTelemetryBatcher({
    post: async () => { throw new Error('network down'); },
    sessionId: 's',
    schedule: () => {},
  });
  b.sink(ev('input_opened'));
  await assert.doesNotReject(() => b.flush());
  assert.equal(b.dropped(), 1);
});

test('§33: the buffer is BOUNDED — an offline device cannot grow it without limit', async () => {
  const r = recorder();
  const b = createTelemetryBatcher({
    post: r.post, sessionId: 's', maxBatch: 1000, maxBuffer: 3, schedule: () => {},
  });
  for (let i = 0; i < 10; i += 1) b.sink(ev('query_length_changed', { props: { length: i } }));
  assert.equal(b.pending(), 3, 'the buffer is capped');
  await b.flush();
  assert.equal(r.batches[0].events.length, 3);
  // The OLDEST are dropped: a funnel wants the most recent behaviour, and the
  // drop is counted so a reader can see the buffer was overrun.
  assert.deepEqual(r.batches[0].events.map((e) => e.props?.length), [7, 8, 9]);
  assert.equal(b.dropped(), 7);
});

test('§44: the wire event is SIX NAMED FIELDS — a field hung on the event does not travel', async () => {
  // The privacy guarantee upstream of here is that a scrubbed event carries no
  // raw text. That is only worth something if the transport does not carry
  // whatever else happens to be on the object.
  //
  // THE FIRST VERSION OF THIS TEST DID NOT PROVE IT. It emitted a well-formed
  // event and compared the wire keys, so replacing the named copy with a spread
  // left it green: a well-formed event spreads to exactly the same keys. The
  // mutation only becomes visible when the event carries something extra —
  // which is the entire scenario the named copy exists for.
  const r = recorder();
  const b = createTelemetryBatcher({ post: r.post, sessionId: 's', schedule: () => {} });
  b.sink({
    ...ev('suggestion_rendered', { props: { count: 4, types: 'entity,recent' } }),
    // A future caller hangs the raw query on the event "just for debugging".
    query: 'where is the secret bar',
    label: 'Alice Nguyen',
  } as unknown as InputTelemetryEvent);
  await b.flush();
  const wire = r.batches[0].events[0];
  assert.deepEqual(Object.keys(wire).sort(), ['at', 'context', 'fieldId', 'name', 'props', 'requestId']);
  assert.deepEqual(wire.props, { count: 4, types: 'entity,recent' });
  const onTheWire = JSON.stringify(r.batches[0]);
  assert.ok(!onTheWire.includes('secret bar'), 'a field hung on the event reached the wire');
  assert.ok(!onTheWire.includes('Alice Nguyen'), 'a field hung on the event reached the wire');
});

test('§44: an empty buffer posts nothing at all', async () => {
  const r = recorder();
  const b = createTelemetryBatcher({ post: r.post, sessionId: 's', schedule: () => {} });
  await b.flush();
  assert.equal(r.batches.length, 0, 'a flush with nothing buffered must not make a request');
});

test('the session id is opaque, bounded, and stable within a run', () => {
  const a = newTelemetrySessionId();
  assert.match(a, /^[A-Za-z0-9_-]{8,64}$/, 'must satisfy the route\'s sessionId bound');
  assert.notEqual(a, newTelemetrySessionId(), 'a new id per call — the caller holds it for the app run');
});
