/**
 * commentSubmitGuard tests — node:test + node:assert only (no RNTL / React).
 *
 * Verifies that the in-flight guard prevents a second network request from
 * being dispatched when handleSubmit is double-tapped before the first call
 * resolves.
 *
 * Run:
 *   node --import tsx/esm --test src/lib/commentSubmitGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitGuard } from './commentSubmitGuard.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns a doSubmit stub that resolves only when resolve() is called. */
function makeDeferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── 1. Basic acceptance ───────────────────────────────────────────────────────

test('1. non-empty text calls doSubmit and returns ok', async () => {
  const guard = createSubmitGuard();
  let calls = 0;
  const result = await guard.trySubmit('hello', async () => { calls++; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('2. text with only whitespace is rejected as empty', async () => {
  const guard = createSubmitGuard();
  let calls = 0;
  const result = await guard.trySubmit('   ', async () => { calls++; });
  assert.equal(result, 'empty');
  assert.equal(calls, 0);
});

test('3. empty string is rejected as empty', async () => {
  const guard = createSubmitGuard();
  let calls = 0;
  const result = await guard.trySubmit('', async () => { calls++; });
  assert.equal(result, 'empty');
  assert.equal(calls, 0);
});

test('4. doSubmit receives the trimmed text, not the raw text', async () => {
  const guard = createSubmitGuard();
  let received = '';
  await guard.trySubmit('  hello world  ', async (t) => { received = t; });
  assert.equal(received, 'hello world');
});

// ── 2. In-flight guard (the core double-tap scenario) ────────────────────────

test('5. second call while first is in-flight returns in_flight without calling doSubmit again', async () => {
  const guard = createSubmitGuard();
  const deferred = makeDeferred();
  let calls = 0;

  // First call — deliberately kept in-flight (deferred.promise not yet resolved)
  const first = guard.trySubmit('hello', async () => {
    calls++;
    await deferred.promise;
  });

  // Second call arrives immediately while first is still pending
  const secondResult = await guard.trySubmit('hello', async () => { calls++; });

  assert.equal(secondResult, 'in_flight', 'second tap must be blocked');
  assert.equal(calls, 1, 'doSubmit must only have been called once');

  // Clean up — resolve first so the test can finish
  deferred.resolve();
  await first;
});

test('6. isSubmitting() is true while a call is in-flight', async () => {
  const guard = createSubmitGuard();
  const deferred = makeDeferred();

  assert.equal(guard.isSubmitting(), false, 'starts idle');

  const pending = guard.trySubmit('hello', async () => {
    await deferred.promise;
  });

  assert.equal(guard.isSubmitting(), true, 'true while awaiting');

  deferred.resolve();
  await pending;

  assert.equal(guard.isSubmitting(), false, 'false after resolved');
});

test('7. rapid double-tap dispatches exactly one network request', async () => {
  const guard = createSubmitGuard();
  const deferred = makeDeferred();
  const requestLog: string[] = [];

  // Fire both "taps" without awaiting the first
  const tap1 = guard.trySubmit('my comment', async (text) => {
    requestLog.push(text);
    await deferred.promise;
  });
  // tap2 fires immediately (tap1 is still in-flight)
  const tap2 = guard.trySubmit('my comment', async (text) => {
    requestLog.push(text);
  });

  // tap2 resolves instantly (blocked); await it first to confirm the result
  const r2 = await tap2;

  // Now unblock tap1 and await its resolution
  deferred.resolve();
  const r1 = await tap1;

  assert.equal(r1, 'ok', 'first tap succeeds');
  assert.equal(r2, 'in_flight', 'second tap is blocked');
  assert.equal(requestLog.length, 1, 'only one network request was made');
  assert.equal(requestLog[0], 'my comment');
});

// ── 3. Recovery after a completed call ───────────────────────────────────────

test('8. after first call completes a new call is accepted', async () => {
  const guard = createSubmitGuard();
  let calls = 0;

  await guard.trySubmit('first', async () => { calls++; });
  const result = await guard.trySubmit('second', async () => { calls++; });

  assert.equal(result, 'ok', 'second call succeeds after first finished');
  assert.equal(calls, 2);
});

test('9. guard resets after an error so the next call is accepted', async () => {
  const guard = createSubmitGuard();
  let calls = 0;

  const errorResult = await guard.trySubmit('oops', async () => {
    calls++;
    throw new Error('network failure');
  });
  assert.equal(errorResult, 'error');
  assert.equal(guard.isSubmitting(), false, 'guard must reset even on error');

  const retryResult = await guard.trySubmit('retry', async () => { calls++; });
  assert.equal(retryResult, 'ok');
  assert.equal(calls, 2);
});

// ── 4. Multiple guard instances are independent ───────────────────────────────

test('10. two separate guards do not interfere with each other', async () => {
  const guardA = createSubmitGuard();
  const guardB = createSubmitGuard();
  const deferredA = makeDeferred();
  let callsA = 0;
  let callsB = 0;

  // Guard A is in-flight
  const pendingA = guardA.trySubmit('from A', async () => {
    callsA++;
    await deferredA.promise;
  });

  // Guard B should still accept calls independently
  const resultB = await guardB.trySubmit('from B', async () => { callsB++; });

  assert.equal(resultB, 'ok', 'guard B must not be blocked by guard A');
  assert.equal(callsB, 1);

  // A second call on guard A should still be blocked
  const blockedA = await guardA.trySubmit('from A again', async () => { callsA++; });
  assert.equal(blockedA, 'in_flight');
  assert.equal(callsA, 1, 'guard A still has only one in-flight call');

  deferredA.resolve();
  await pendingA;
});
