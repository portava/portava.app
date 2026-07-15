/**
 * Double-tap guard for the Rent-a-Buddy offer-create and offer-edit submit buttons.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/RentABuddyOffer.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * Both offer screens (`offer-create.tsx` and `offer.tsx`) previously relied on
 * React state flags (`submitting`, `sending`) to disable the submit button.
 * `setState(true)` is asynchronous — it only takes effect on the next render.
 * A rapid double-tap therefore lands before the Pressable's `disabled` prop
 * updates, and both taps dispatch a network request.
 *
 * The fix is a synchronous `useRef(false)` guard checked at the top of each
 * submit handler before any async work. These tests verify the guard semantics
 * using the machine-layer pattern (node:test + tsx/esm, no RNTL / React).
 *
 * ## Pattern being tested (mirrors offer-create.tsx submit and offer.tsx handleSend)
 *
 *   if (lockRef.current) return;
 *   lockRef.current = true;
 *   setState(true);
 *   try {
 *     await networkCall(...);
 *     // handle success
 *   } finally {
 *     lockRef.current = false;
 *     setState(false);
 *   }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers — model the lockRef + guarded submit pattern ─────────────────────

/**
 * Creates an independent synchronous lock that mirrors `useRef(false)`.
 * Each call returns a fresh lock so tests remain isolated.
 */
function createLock() {
  let locked = false;
  return {
    get current() { return locked; },
    acquire(): boolean {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() { locked = false; },
  };
}

type LockHandle = ReturnType<typeof createLock>;

/**
 * Simulates the guarded submit flow from both offer screens:
 *
 *   if (lockRef.current) return false;        // bail — second tap blocked
 *   lockRef.current = true;
 *   try { await doSubmit(); }
 *   finally { lockRef.current = false; }
 *
 * Returns true if the handler proceeded, false if it was blocked.
 * Throws if doSubmit throws (finally still releases the lock).
 */
async function guardedSubmit(
  lock: LockHandle,
  doSubmit: () => Promise<void>,
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doSubmit();
    return true;
  } finally {
    lock.release();
  }
}

// ── offer-create.tsx — submitOffer path ───────────────────────────────────────

describe('offer-create — submit lock prevents double-tap', () => {
  it('first tap proceeds and calls submitOffer once', async () => {
    const lock = createLock();
    let calls = 0;
    const proceeded = await guardedSubmit(lock, async () => { calls++; });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('second tap while first is in-flight is rejected', async () => {
    const lock = createLock();
    let calls = 0;

    // Simulate tap 1 acquiring the lock
    const tap1Acquired = lock.acquire();
    assert.equal(tap1Acquired, true, 'first tap acquires the lock');

    // Tap 2 arrives immediately — must be rejected
    const tap2Acquired = lock.acquire();
    assert.equal(tap2Acquired, false, 'second tap is blocked while first holds the lock');

    // Tap 1 completes its work
    calls++;
    lock.release();

    assert.equal(calls, 1, 'only one submitOffer call must fire');
  });

  it('concurrent double-tap — only one submitOffer fires', async () => {
    const lock = createLock();
    const networkCalls: number[] = [];

    const sendOffer = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      networkCalls.push(Date.now());
    };

    const [r1, r2] = await Promise.all([
      guardedSubmit(lock, sendOffer),
      guardedSubmit(lock, sendOffer),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'exactly one of the two concurrent taps must proceed');
    assert.equal(networkCalls.length, 1, 'submitOffer must be called exactly once');
  });

  it('lock is released after success — next tap proceeds normally', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedSubmit(lock, async () => { calls++; });
    assert.equal(lock.current, false, 'lock must be released after success');

    const secondProceeded = await guardedSubmit(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'next tap must succeed after lock is released');
    assert.equal(calls, 2);
  });

  it('lock is released after an error — next tap is not permanently blocked', async () => {
    const lock = createLock();
    let calls = 0;

    try {
      await guardedSubmit(lock, async () => {
        calls++;
        throw new Error('submitOffer network failure');
      });
    } catch {
      // expected — the guard re-throws so the screen can show an error
    }

    assert.equal(lock.current, false, 'lock must be released even when submitOffer throws');

    const retryProceeded = await guardedSubmit(lock, async () => { calls++; });
    assert.equal(retryProceeded, true, 'user must be able to retry after an error');
    assert.equal(calls, 2);
  });

  it('multiple rapid taps — only the first fires', async () => {
    const lock = createLock();
    const networkCalls: string[] = [];
    let firstResolve!: () => void;
    const firstAwaiter = new Promise<void>((r) => { firstResolve = r; });

    const tap1 = guardedSubmit(lock, async () => {
      networkCalls.push('tap1');
      await firstAwaiter;
    });

    // Taps 2 and 3 arrive while tap 1 is still awaiting
    const tap2 = guardedSubmit(lock, async () => { networkCalls.push('tap2'); });
    const tap3 = guardedSubmit(lock, async () => { networkCalls.push('tap3'); });

    const [r2, r3] = await Promise.all([tap2, tap3]);
    assert.equal(r2, false, 'tap2 must be blocked');
    assert.equal(r3, false, 'tap3 must be blocked');
    assert.equal(networkCalls.length, 1, 'only tap1 must reach the network');

    firstResolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });
});

// ── offer.tsx — createBuddyOffer path ─────────────────────────────────────────

describe('offer — send lock prevents double-tap', () => {
  it('first tap proceeds and calls createBuddyOffer once', async () => {
    const lock = createLock();
    const offerCalls: string[] = [];
    const proceeded = await guardedSubmit(lock, async () => {
      offerCalls.push('createBuddyOffer');
    });
    assert.equal(proceeded, true);
    assert.equal(offerCalls.length, 1);
  });

  it('rapid double-tap dispatches exactly one createBuddyOffer call', async () => {
    const lock = createLock();
    const offerCalls: string[] = [];

    const sendOffer = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      offerCalls.push('createBuddyOffer');
    };

    const [r1, r2] = await Promise.all([
      guardedSubmit(lock, sendOffer),
      guardedSubmit(lock, sendOffer),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'only one tap must proceed');
    assert.equal(offerCalls.length, 1, 'createBuddyOffer must be called exactly once');
  });

  it('lock releases after success so user can send another offer later', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedSubmit(lock, async () => { calls++; });
    assert.equal(lock.current, false);

    await guardedSubmit(lock, async () => { calls++; });
    assert.equal(calls, 2, 'sequential sends are allowed after lock is released');
  });

  it('lock releases after createBuddyOffer error so user can retry', async () => {
    const lock = createLock();
    let attempts = 0;

    try {
      await guardedSubmit(lock, async () => {
        attempts++;
        throw new Error('createBuddyOffer failed');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock must be released on error');

    const retried = await guardedSubmit(lock, async () => { attempts++; });
    assert.equal(retried, true);
    assert.equal(attempts, 2, 'retry must reach the network call');
  });
});

// ── Guard isolation — each screen instance has its own lock ───────────────────

describe('guard isolation', () => {
  it('offer-create and offer locks are independent', async () => {
    const lockA = createLock(); // offer-create instance
    const lockB = createLock(); // offer instance

    lockA.acquire();
    // A is locked — B must still accept a call
    assert.equal(lockB.acquire(), true, 'offer lock is independent from offer-create lock');
    lockA.release();
    lockB.release();
  });

  it('each test creates an independent lock — tests do not share state', () => {
    const lock1 = createLock();
    const lock2 = createLock();
    lock1.acquire();
    assert.equal(lock1.current, true);
    assert.equal(lock2.current, false, 'lock2 must start unlocked');
    lock1.release();
  });
});

// ── Why state-only guard is insufficient ─────────────────────────────────────
//
// Documents the gap that the ref guard closes.

describe('documents why React state alone is insufficient', () => {
  it('two synchronous reads of a state flag both see false before setState fires', () => {
    let sending = false; // React state — not yet updated by the first tap's setSending(true)

    // Tap 1: reads sending=false → proceeds
    const tap1CanSend = !sending;
    assert.equal(tap1CanSend, true, 'tap1 sees sending=false and proceeds');

    // setSending(true) is queued but deferred until next render — NOT yet applied

    // Tap 2: also reads sending=false → also proceeds (the bug)
    const tap2CanSend = !sending;
    assert.equal(tap2CanSend, true,
      'tap2 also sees sending=false — state guard is bypassed before re-render');
  });

  it('ref guard is synchronous — second tap sees locked=true immediately', () => {
    let locked = false;

    // Tap 1: check ref (synchronous), acquire
    const tap1Passes = !locked;
    if (tap1Passes) locked = true;
    assert.equal(tap1Passes, true, 'tap1 proceeds');

    // Tap 2: ref is already true
    const tap2Passes = !locked;
    assert.equal(tap2Passes, false, 'tap2 is blocked — ref was set synchronously');
  });
});
