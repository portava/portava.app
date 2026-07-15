/**
 * Double-tap guard for the trip New / Edit Save button.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/TripEditor.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `app/trip/new.tsx` and `app/trip/edit.tsx` previously relied solely on the
 * `busy` React state flag to prevent double-submission. `setBusy(true)` is an
 * async state update — it does not take effect until the next render. A rapid
 * double-tap therefore lands before the Pressable's `disabled` prop is updated,
 * and both taps call `createTrip` / `updateTrip` (the network calls).
 *
 * The fix is a synchronous `saveLock` ref that is checked before any async
 * work. These tests verify the guard semantics without mounting the component,
 * using the same machine-layer pattern as CreateMemory.doubletap.test.ts.
 *
 * ## Testing strategy
 *
 * The core guard is a plain boolean ref (not React state). We model it as a
 * boolean flag and verify:
 *
 *   1. First tap proceeds and the lock is held.
 *   2. Second tap arriving while the first is in flight is rejected — only one
 *      network call fires.
 *   3. After the first tap completes (finally block), the lock is released and
 *      the next tap can proceed.
 *
 * This mirrors the exact guard pattern added to save() / create():
 *
 *   if (saveLock.current) return;
 *   saveLock.current = true;
 *   try { ... } finally { saveLock.current = false; }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers — model the saveLock ref + save/create guard ─────────────────────

/**
 * Creates a plain save-lock object that mirrors the `saveLock` useRef in
 * NewTrip and EditTrip. Each call returns an independent lock so tests are
 * isolated.
 */
function createSaveLock() {
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

/**
 * Simulates the guarded save flow from save() / create():
 *
 *   if (saveLock.current) return;
 *   saveLock.current = true;
 *   try { await doSave(); }
 *   finally { saveLock.current = false; }
 *
 * Returns true if the handler proceeded (lock acquired), false if it bailed out.
 */
async function guardedSave(
  lock: ReturnType<typeof createSaveLock>,
  doSave: () => Promise<void>,
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doSave();
    return true;
  } finally {
    lock.release();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('trip editor — save lock prevents double-tap', () => {
  it('first tap proceeds — lock is acquired and doSave is called', async () => {
    const lock = createSaveLock();
    let calls = 0;
    const proceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(proceeded, true, 'first tap must proceed');
    assert.equal(calls, 1, 'doSave must be called exactly once');
  });

  it('second tap while first is in flight is rejected — only one network call fires', async () => {
    const lock = createSaveLock();
    let calls = 0;

    // First tap starts but has not finished (lock still held during the await)
    const call1Acquired = lock.acquire();
    assert.equal(call1Acquired, true, 'first tap must acquire the lock');

    // Second tap arrives before first has completed — must be rejected
    const call2Acquired = lock.acquire();
    assert.equal(call2Acquired, false, 'second tap must be rejected while first is in flight');

    // Simulate first tap completing its network call
    calls++;
    lock.release();

    assert.equal(calls, 1, 'only one network call must have fired');
  });

  it('concurrent double-tap — both use guardedSave — only one doSave runs', async () => {
    const lock = createSaveLock();
    let calls = 0;

    const save = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      calls++;
    };

    const [result1, result2] = await Promise.all([
      guardedSave(lock, save),
      guardedSave(lock, save),
    ]);

    const proceeded = [result1, result2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'only one of two concurrent taps must proceed');
    assert.equal(calls, 1, 'doSave must be called exactly once despite concurrent taps');
  });

  it('lock is released in finally after success — next tap proceeds normally', async () => {
    const lock = createSaveLock();
    let calls = 0;

    await guardedSave(lock, async () => { calls++; });
    assert.equal(calls, 1, 'first tap must have fired');
    assert.equal(lock.current, false, 'lock must be released after first tap completes');

    const secondProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'second tap must proceed after first has completed');
    assert.equal(calls, 2, 'second tap must fire its own network call');
  });

  it('lock is released in finally after an error — next tap is not permanently blocked', async () => {
    const lock = createSaveLock();
    let calls = 0;

    try {
      await guardedSave(lock, async () => {
        calls++;
        throw new Error('network error');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock must be released even when doSave throws');

    const secondProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'next tap must not be permanently blocked after an error');
    assert.equal(calls, 2);
  });

  it('each createSaveLock() returns an independent lock — tests are isolated', () => {
    const lockA = createSaveLock();
    const lockB = createSaveLock();
    lockA.acquire();
    assert.equal(lockB.acquire(), true, 'lockB must be independent from lockA');
    lockA.release();
    lockB.release();
  });
});

// ── React state flag alone is insufficient — documents the gap ───────────────
//
// This suite documents WHY the synchronous ref guard is needed.
// React setState is asynchronous: the flag is only visible in the NEXT render.
// A second tap that arrives before the re-render sees the old flag value (false)
// and bypasses the `disabled` prop, calling doSave a second time.

describe('trip editor — state-only guard is insufficient (documents the gap)', () => {
  it('two synchronous flag reads both see false before setState takes effect', () => {
    let busy = false;

    // First tap: reads false → proceeds
    const canSave1 = !busy;
    assert.equal(canSave1, true, 'first tap sees canSave=true');

    // setBusy(true) is queued but has NOT run yet (next render)

    // Second tap: also reads false → also proceeds (the bug)
    const canSave2 = !busy;
    assert.equal(canSave2, true,
      'second tap also sees canSave=true — both taps bypass the state guard before the re-render');
  });

  it('ref guard prevents both taps from proceeding — only the first wins', () => {
    let locked = false;

    // First tap: check ref (synchronous, immediate)
    const tap1 = !locked;
    if (tap1) locked = true;
    assert.equal(tap1, true, 'first tap proceeds');

    // Second tap: ref is already true
    const tap2 = !locked;
    assert.equal(tap2, false, 'second tap is rejected — ref was updated synchronously');
  });
});
