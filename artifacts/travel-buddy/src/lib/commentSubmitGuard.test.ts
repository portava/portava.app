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

// ── 4. Reply path — addReply is the network call (replyingTo context) ────────
//
// These tests mirror CommentsSheet.handleSubmit's reply branch exactly:
//   if (replyingTo) { await addReply(postId, replyingTo.id, trimmed); }
// The guard is the same createSubmitGuard instance; we just confirm it wires
// correctly when the doSubmit callback delegates to addReply instead of
// addComment.

/** Minimal stand-in for the addReply network call. */
function makeAddReplyStub() {
  const calls: Array<{ postId: string; parentId: string; text: string }> = [];
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  let promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });

  const reset = () => {
    promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  };

  const stub = async (postId: string, parentId: string, text: string) => {
    calls.push({ postId, parentId, text });
    await promise;
  };

  return { stub, calls, resolve: () => resolve(), reject: (e: unknown) => reject(e), reset };
}

test('11. reply path — doSubmit calling addReply resolves to ok', async () => {
  const guard = createSubmitGuard();
  const replyStub = makeAddReplyStub();
  const postId = 'post-1';
  const replyingTo = { id: 'comment-42', authorName: 'Alice' };

  // Simulate the handleSubmit reply branch
  const pending = guard.trySubmit('Nice shot!', async (trimmed) => {
    await replyStub.stub(postId, replyingTo.id, trimmed);
  });

  replyStub.resolve();
  const result = await pending;

  assert.equal(result, 'ok');
  assert.equal(replyStub.calls.length, 1);
  assert.deepEqual(replyStub.calls[0], {
    postId: 'post-1',
    parentId: 'comment-42',
    text: 'Nice shot!',
  });
});

test('12. reply path — double-tap blocks second addReply call (core duplicate prevention)', async () => {
  const guard = createSubmitGuard();
  const postId = 'post-1';
  const replyingTo = { id: 'comment-42', authorName: 'Alice' };

  const replyLog: string[] = [];
  let firstResolve!: () => void;
  const firstAwaiter = new Promise<void>((res) => { firstResolve = res; });

  // Tap 1 — in-flight (addReply not yet resolved)
  const tap1 = guard.trySubmit('Great photo!', async (trimmed) => {
    replyLog.push(`addReply:${replyingTo.id}:${trimmed}`);
    await firstAwaiter;
  });

  // Tap 2 — arrives while tap 1 is still awaiting addReply
  const tap2 = guard.trySubmit('Great photo!', async (trimmed) => {
    replyLog.push(`addReply:${replyingTo.id}:${trimmed}`);
  });

  const r2 = await tap2;
  assert.equal(r2, 'in_flight', 'second tap on reply must be blocked');
  assert.equal(replyLog.length, 1, 'addReply must be called only once');

  firstResolve();
  const r1 = await tap1;
  assert.equal(r1, 'ok');
});

test('13. reply path — isSubmitting is true while addReply is pending', async () => {
  const guard = createSubmitGuard();
  const replyStub = makeAddReplyStub();
  const replyingTo = { id: 'comment-7', authorName: 'Bob' };

  assert.equal(guard.isSubmitting(), false);

  const pending = guard.trySubmit('See you there!', async (t) => {
    await replyStub.stub('post-2', replyingTo.id, t);
  });

  assert.equal(guard.isSubmitting(), true, 'should be submitting while addReply awaits');

  replyStub.resolve();
  await pending;

  assert.equal(guard.isSubmitting(), false, 'should reset after addReply resolves');
});

test('14. reply path — guard resets after addReply error, allowing retry', async () => {
  const guard = createSubmitGuard();
  const replyingTo = { id: 'comment-99', authorName: 'Carol' };
  let attempts = 0;

  const errorResult = await guard.trySubmit('Hello!', async () => {
    attempts++;
    throw new Error('network timeout');
  });
  assert.equal(errorResult, 'error');
  assert.equal(guard.isSubmitting(), false);

  const retryResult = await guard.trySubmit('Hello!', async (t) => {
    attempts++;
    // second attempt succeeds — simulates a successful addReply
    void replyingTo.id; // confirm replyingTo context is accessible in closure
    void t;
  });
  assert.equal(retryResult, 'ok');
  assert.equal(attempts, 2, 'addReply should be called on retry after error');
});

test('15. reply path — trimmed text is passed to addReply (not raw with whitespace)', async () => {
  const guard = createSubmitGuard();
  const replyingTo = { id: 'comment-5', authorName: 'Dan' };
  let capturedText = '';

  await guard.trySubmit('  awesome!  ', async (trimmed) => {
    capturedText = trimmed; // this is what addReply would receive
    void replyingTo.id;
  });

  assert.equal(capturedText, 'awesome!', 'addReply must receive trimmed text');
});

// ── 5. Multiple guard instances are independent ───────────────────────────────

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
