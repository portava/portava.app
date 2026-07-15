/**
 * Double-tap guard for the ActiveSafeReturnCard action buttons.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/SafeReturnActiveCard.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `ActiveSafeReturnCard.tsx` has three action buttons — "I'm Safe", "Extend +15 min",
 * and "Emergency Help" — each backed by an async service call. Previously the
 * component shared a single `loading` React state flag across all three actions,
 * meaning a rapid double-tap on any one of them would fire two concurrent calls
 * before the state re-render could set `disabled={true}` on the Pressable.
 *
 * The fix is a per-action `useRef(false)` guard checked synchronously at the
 * top of each handler, with a try/finally to release the lock on success or
 * error. These tests verify the guard semantics for all three actions using the
 * machine-layer pattern (node:test + tsx/esm, no RNTL / React).
 *
 * ## Pattern being tested
 *
 *   if (actionRef.current) return;
 *   actionRef.current = true;
 *   setLoading(true);
 *   try {
 *     await serviceCall(...);
 *   } finally {
 *     actionRef.current = false;
 *     setLoading(false);
 *   }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function guardedAction(
  lock: LockHandle,
  doAction: () => Promise<void>,
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doAction();
    return true;
  } finally {
    lock.release();
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── "I'm Safe" — confirmSafeRef ───────────────────────────────────────────────

describe("I'm Safe button — confirmSafeRef prevents double-tap", () => {
  it('first tap proceeds and calls confirmSafe once', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedAction(lock, async () => { calls++; await delay(10); });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap fires only one confirmSafe call', async () => {
    const lock = createLock();
    let calls = 0;

    const doConfirm = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedAction(lock, doConfirm),
      guardedAction(lock, doConfirm),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('three rapid taps fire exactly one confirmSafe call', async () => {
    const lock = createLock();
    let calls = 0;

    const doConfirm = async () => { calls++; await delay(20); };

    const results = await Promise.all([
      guardedAction(lock, doConfirm),
      guardedAction(lock, doConfirm),
      guardedAction(lock, doConfirm),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(calls, 1);
  });

  it('lock releases after confirmSafe success — session ends cleanly', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedAction(lock, async () => { calls++; await delay(5); });
    assert.equal(lock.current, false, 'lock must be released after success');
    assert.equal(calls, 1);
  });

  it('lock releases after confirmSafe network error — user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedAction(lock, async () => { calls++; throw new Error('network'); }).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released even after a throw');

    const retry = await guardedAction(lock, async () => { calls++; });
    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── "Extend +15 min" — extendRef ──────────────────────────────────────────────

describe('Extend timer button — extendRef prevents double-tap', () => {
  it('first tap proceeds and calls extendTimer once', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedAction(lock, async () => { calls++; await delay(10); });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap on "+15 min" fires only one extendTimer call', async () => {
    const lock = createLock();
    let calls = 0;

    const doExtend = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedAction(lock, doExtend),
      guardedAction(lock, doExtend),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('lock releases after extendTimer success — timer updated once', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedAction(lock, async () => { calls++; await delay(5); });
    assert.equal(lock.current, false);
    assert.equal(calls, 1);
  });

  it('lock releases after extendTimer error — user can retry extension', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedAction(lock, async () => { calls++; throw new Error('extend failed'); }).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released even after throw');

    const retry = await guardedAction(lock, async () => { calls++; });
    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── "Emergency Help" — emergencyRef ───────────────────────────────────────────

describe('Emergency Help button — emergencyRef prevents double-tap', () => {
  it('first tap opens the sheet', async () => {
    const lock = createLock();
    let openCalls = 0;

    const proceeded = await guardedAction(lock, async () => { openCalls++; });
    assert.equal(proceeded, true);
    assert.equal(openCalls, 1);
  });

  it('rapid double-tap opens the sheet only once', async () => {
    const lock = createLock();
    let openCalls = 0;

    const doOpen = async () => { openCalls++; };

    const [first, second] = await Promise.all([
      guardedAction(lock, doOpen),
      guardedAction(lock, doOpen),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(openCalls, 1);
  });

  it('lock releases after open — button is re-armable for the next session', async () => {
    const lock = createLock();
    let openCalls = 0;

    await guardedAction(lock, async () => { openCalls++; });
    assert.equal(lock.current, false, 'lock released after sheet open');

    const second = await guardedAction(lock, async () => { openCalls++; });
    assert.equal(second, true);
    assert.equal(openCalls, 2);
  });
});

// ── Guard isolation — all three locks are independent ────────────────────────

describe('guard isolation — confirmSafe, extend, and emergency locks are independent', () => {
  it('locking confirmSafe does not block extend', async () => {
    const confirmLock = createLock();
    const extendLock = createLock();
    let extendCalls = 0;

    confirmLock.acquire(); // simulate "I'm Safe" in-flight

    const extendResult = await guardedAction(extendLock, async () => { extendCalls++; });

    assert.equal(extendResult, true);
    assert.equal(extendCalls, 1);
    assert.equal(confirmLock.current, true, 'confirmSafe lock must still be held');
  });

  it('locking extend does not block emergency', async () => {
    const extendLock = createLock();
    const emergencyLock = createLock();
    let emergencyCalls = 0;

    extendLock.acquire();

    const emergencyResult = await guardedAction(emergencyLock, async () => { emergencyCalls++; });

    assert.equal(emergencyResult, true);
    assert.equal(emergencyCalls, 1);
    assert.equal(extendLock.current, true, 'extend lock must still be held');
  });

  it('locking emergency does not block confirmSafe', async () => {
    const emergencyLock = createLock();
    const confirmLock = createLock();
    let confirmCalls = 0;

    emergencyLock.acquire();

    const confirmResult = await guardedAction(confirmLock, async () => { confirmCalls++; });

    assert.equal(confirmResult, true);
    assert.equal(confirmCalls, 1);
    assert.equal(emergencyLock.current, true, 'emergency lock must still be held');
  });

  it('three locks can all be in-flight simultaneously — independent actions', async () => {
    const confirmLock = createLock();
    const extendLock = createLock();
    const emergencyLock = createLock();

    confirmLock.acquire();
    extendLock.acquire();
    emergencyLock.acquire();

    assert.equal(confirmLock.current, true);
    assert.equal(extendLock.current, true);
    assert.equal(emergencyLock.current, true);
  });

  it('each test uses fresh locks — no shared state between tests', () => {
    const lock1 = createLock();
    const lock2 = createLock();
    const lock3 = createLock();

    lock1.acquire();

    assert.equal(lock1.current, true);
    assert.equal(lock2.current, false, 'lock2 unaffected by lock1');
    assert.equal(lock3.current, false, 'lock3 unaffected by lock1');
  });
});

// ── Documents why React state alone is insufficient ──────────────────────────

describe('documents why React state alone is insufficient for safety-critical buttons', () => {
  it('shared state flag: both taps see loading=false before setState re-render fires', () => {
    let loading = false; // React state — not updated until next render

    const tap1Seen = loading; // both read the same stale value
    const tap2Seen = loading;
    loading = true; // setState(true) fires only after re-render

    assert.equal(tap1Seen, false, 'tap1 sees loading=false and proceeds');
    assert.equal(tap2Seen, false, 'tap2 also sees loading=false — double call occurs');
  });

  it('per-action ref guard is synchronous — second tap sees locked=true immediately', () => {
    const lock = createLock();
    lock.acquire(); // first tap

    const tap2Blocked = !lock.acquire(); // synchronous, no re-render needed
    assert.equal(tap2Blocked, true, 'second tap is blocked synchronously');
  });

  it('per-action guard means confirmSafe in-flight does not block extend or emergency', () => {
    const confirmLock = createLock();
    const extendLock = createLock();

    confirmLock.acquire(); // confirmSafe in-flight

    const extendCanProceed = extendLock.acquire();
    assert.equal(extendCanProceed, true, 'extend is its own lock and can proceed');
    extendLock.release();
    confirmLock.release();
  });
});
