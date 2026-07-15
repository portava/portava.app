/**
 * Double-tap guard for the Safe Return session start button.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/SafeReturn.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `SafeReturnSetupSheet.tsx` previously relied solely on the `saving` React
 * state flag to prevent double-submission. `setSaving(true)` is an async state
 * update — it does not take effect until the next render. A rapid double-tap on
 * "Start Safe Return" therefore lands before the Pressable's `disabled` prop is
 * updated, and both taps call `createSession` + `startSession` concurrently,
 * potentially starting two overlapping safety sessions — a serious issue in a
 * safety-critical flow.
 *
 * The fix is a synchronous `startLock` ref (useRef(false)) checked at the very
 * top of `handleStart` before any async work. These tests verify the guard
 * semantics using the machine-layer pattern (node:test + tsx/esm, no RNTL /
 * React).
 *
 * ## Pattern being tested
 *
 *   if (startLock.current) return;
 *   startLock.current = true;
 *   setSaving(true);
 *   try {
 *     await createSession(...);
 *     await startSession(...);
 *   } finally {
 *     startLock.current = false;
 *     setSaving(false);
 *   }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers — model the startLock ref + guarded handleStart ──────────────────

/**
 * Creates a plain start-lock that mirrors the `startLock` useRef in
 * SafeReturnSetupSheet. Each call returns an independent lock so tests are
 * isolated.
 */
function createStartLock() {
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

type StartLock = ReturnType<typeof createStartLock>;

/**
 * Simulates the guarded session-start flow from handleStart():
 *
 *   if (startLock.current) return false;
 *   startLock.current = true;
 *   try { await doStart(); }
 *   finally { startLock.current = false; }
 *
 * Returns true if the handler proceeded (lock acquired), false if it bailed out.
 * Re-throws if doStart throws — the finally block still releases the lock,
 * mirroring the real screen where Alert.alert surfaces the error but the user
 * must be able to retry.
 */
async function guardedStart(lock: StartLock, doStart: () => Promise<void>): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doStart();
    return true;
  } finally {
    lock.release();
  }
}

// ── Core guard behaviour ──────────────────────────────────────────────────────

describe('Safe Return start — startLock prevents double-tap', () => {
  it('first tap proceeds — lock is acquired and session start is called', async () => {
    const lock = createStartLock();
    let calls = 0;
    const proceeded = await guardedStart(lock, async () => { calls++; });
    assert.equal(proceeded, true, 'first tap must proceed');
    assert.equal(calls, 1, 'session start must be called exactly once');
  });

  it('second tap while first is in flight is rejected — only one session starts', async () => {
    const lock = createStartLock();
    let calls = 0;

    const tap1Acquired = lock.acquire();
    assert.equal(tap1Acquired, true, 'first tap acquires the lock');

    const tap2Acquired = lock.acquire();
    assert.equal(tap2Acquired, false, 'second tap is blocked while first holds the lock');

    calls++;
    lock.release();

    assert.equal(calls, 1, 'only one session start must fire');
  });

  it('concurrent double-tap — only one createSession + startSession pair fires', async () => {
    const lock = createStartLock();
    let calls = 0;

    const startSession = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      calls++;
    };

    const [r1, r2] = await Promise.all([
      guardedStart(lock, startSession),
      guardedStart(lock, startSession),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'exactly one of the two concurrent taps must proceed');
    assert.equal(calls, 1, 'createSession must be called exactly once despite concurrent taps');
  });

  it('lock is released in finally after success — user can start a new session later', async () => {
    const lock = createStartLock();
    let calls = 0;

    await guardedStart(lock, async () => { calls++; });
    assert.equal(calls, 1, 'first tap must have fired');
    assert.equal(lock.current, false, 'lock must be released after success');

    const secondProceeded = await guardedStart(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'a later tap must proceed after the lock is released');
    assert.equal(calls, 2);
  });

  it('lock is released after a network error — user can retry', async () => {
    const lock = createStartLock();
    let calls = 0;

    try {
      await guardedStart(lock, async () => {
        calls++;
        throw new Error('createSession network error');
      });
    } catch {
      // expected — Alert.alert would surface this in the real screen
    }

    assert.equal(lock.current, false, 'lock must be released even when the start throws');

    const retryProceeded = await guardedStart(lock, async () => { calls++; });
    assert.equal(retryProceeded, true, 'user must be able to retry after an error');
    assert.equal(calls, 2);
  });

  it('multiple rapid taps — only the first reaches createSession', async () => {
    const lock = createStartLock();
    const networkCalls: string[] = [];
    let firstResolve!: () => void;
    const firstAwaiter = new Promise<void>((r) => { firstResolve = r; });

    const tap1 = guardedStart(lock, async () => {
      networkCalls.push('tap1');
      await firstAwaiter;
    });

    const tap2 = guardedStart(lock, async () => { networkCalls.push('tap2'); });
    const tap3 = guardedStart(lock, async () => { networkCalls.push('tap3'); });

    const [r2, r3] = await Promise.all([tap2, tap3]);
    assert.equal(r2, false, 'tap2 must be blocked');
    assert.equal(r3, false, 'tap3 must be blocked');
    assert.equal(networkCalls.length, 1, 'only tap1 must reach createSession');

    firstResolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });
});

// ── Two-phase call guard (createSession then startSession) ───────────────────
//
// handleStart calls createSession first, then startSession. The lock must cover
// both calls so a mid-flight tap cannot start a second session between the two
// awaits.

describe('Safe Return start — lock covers both createSession and startSession', () => {
  it('lock is still held between createSession and startSession calls', async () => {
    const lock = createStartLock();
    let createCalls = 0;
    let startCalls = 0;
    let tapDuringStartSession = false;

    await guardedStart(lock, async () => {
      createCalls++;
      // Simulate the gap between createSession resolving and startSession being called
      await new Promise<void>((r) => setTimeout(r, 0));
      // A tap arriving here must be blocked
      tapDuringStartSession = !lock.acquire(); // acquire fails → true means blocked
      startCalls++;
    });

    assert.equal(createCalls, 1, 'createSession called once');
    assert.equal(startCalls, 1, 'startSession called once');
    assert.equal(tapDuringStartSession, true, 'tap between the two awaits must be blocked');
  });

  it('a rejected second session leaves state clean — first session completes normally', async () => {
    const lock = createStartLock();
    const events: string[] = [];

    const tap1 = guardedStart(lock, async () => {
      events.push('create');
      await new Promise<void>((r) => setTimeout(r, 0));
      events.push('start');
    });

    const tap2 = guardedStart(lock, async () => {
      events.push('create-second'); // must not happen
    });

    const [, r2] = await Promise.all([tap1, tap2]);
    assert.equal(r2, false, 'second tap must be rejected');
    assert.deepEqual(events, ['create', 'start'], 'only the first session\'s two phases must execute');
  });
});

// ── Lock isolation ────────────────────────────────────────────────────────────

describe('Safe Return — each sheet instance has an independent lock', () => {
  it('two sheet instances have separate locks — one running does not block the other', () => {
    const sheet1Lock = createStartLock();
    const sheet2Lock = createStartLock();

    sheet1Lock.acquire();
    assert.equal(sheet2Lock.acquire(), true, 'sheet2 lock is unaffected by sheet1 lock');
    sheet1Lock.release();
    sheet2Lock.release();
  });

  it('each createStartLock() returns a fresh lock — tests are fully isolated', () => {
    const lockA = createStartLock();
    const lockB = createStartLock();
    lockA.acquire();
    assert.equal(lockB.acquire(), true, 'lockB must start unlocked');
    assert.equal(lockA.current, true);
    lockA.release();
    lockB.release();
  });
});

// ── Why React state alone is insufficient ────────────────────────────────────
//
// Documents the gap that the ref guard closes.

describe('Safe Return — documents why React state alone is insufficient', () => {
  it('two synchronous reads of a state flag both see false before setState fires', () => {
    let saving = false; // React state — not yet updated by setSaving(true)

    // Tap 1: reads saving=false → proceeds
    const tap1CanStart = !saving;
    assert.equal(tap1CanStart, true, 'tap1 sees saving=false and proceeds');

    // setSaving(true) is queued but deferred until next render — NOT yet applied

    // Tap 2: also reads saving=false → also proceeds (the bug)
    const tap2CanStart = !saving;
    assert.equal(tap2CanStart, true,
      'tap2 also sees saving=false — state guard is bypassed before re-render');
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
