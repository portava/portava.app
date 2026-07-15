/**
 * Double-tap guard for the memory creation Publish button.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/CreateMemory.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `memory/create.tsx` previously relied solely on the `uploading` React state
 * flag to prevent double-submission. `setUploading(true)` is an async state
 * update — it does not take effect until the next render. A rapid double-tap
 * therefore lands before the Pressable's `disabled` prop is updated, and both
 * taps call `createMemory` (the network call).
 *
 * The fix is a synchronous `publishLock` ref that is checked before any async
 * work. These tests verify the guard semantics without mounting the component,
 * using the same machine-layer pattern as PulseCreate.submit.test.ts.
 *
 * ## Testing strategy
 *
 * The core guard is a plain boolean ref (not a React state). We model it as a
 * boolean flag and verify:
 *
 *   1. First tap proceeds and the lock is held.
 *   2. Second tap arriving while the first is in flight is rejected — only one
 *      network call fires.
 *   3. After the first tap completes (finally block), the lock is released and
 *      the next tap can proceed.
 *
 * This mirrors the exact guard pattern added to handlePublish():
 *
 *   if (publishLock.current) return;
 *   publishLock.current = true;
 *   try { ... } finally { publishLock.current = false; }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers — model the publishLock ref + handlePublish guard ────────────────

/**
 * Creates a plain publish-lock object that mirrors the `publishLock` useRef in
 * CreateMemoryScreen. Each call returns an independent lock so tests are
 * isolated.
 */
function createPublishLock() {
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
 * Simulates the guarded publish flow from handlePublish():
 *
 *   if (publishLock.current) return;
 *   publishLock.current = true;
 *   try { await doPublish(); }
 *   finally { publishLock.current = false; }
 *
 * Returns true if the handler proceeded (lock acquired), false if it bailed out.
 */
async function guardedPublish(
  lock: ReturnType<typeof createPublishLock>,
  doPublish: () => Promise<void>,
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doPublish();
    return true;
  } finally {
    lock.release();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('memory create — publish lock prevents double-tap', () => {
  it('first tap proceeds — lock is acquired and doPublish is called', async () => {
    const lock = createPublishLock();
    let calls = 0;
    const proceeded = await guardedPublish(lock, async () => { calls++; });
    assert.equal(proceeded, true, 'first tap must proceed');
    assert.equal(calls, 1, 'doPublish must be called exactly once');
  });

  it('second tap while first is in flight is rejected — only one network call fires', async () => {
    const lock = createPublishLock();
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

  it('concurrent double-tap — both use guardedPublish — only one doPublish runs', async () => {
    const lock = createPublishLock();
    let calls = 0;

    // Simulate both taps being initiated before either resolves
    const publish = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      calls++;
    };

    const [result1, result2] = await Promise.all([
      guardedPublish(lock, publish),
      guardedPublish(lock, publish),
    ]);

    // One must have been blocked
    const proceeded = [result1, result2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'only one of two concurrent taps must proceed');
    assert.equal(calls, 1, 'doPublish must be called exactly once despite concurrent taps');
  });

  it('lock is released in finally after success — next tap proceeds normally', async () => {
    const lock = createPublishLock();
    let calls = 0;

    // First tap completes
    await guardedPublish(lock, async () => { calls++; });
    assert.equal(calls, 1, 'first tap must have fired');
    assert.equal(lock.current, false, 'lock must be released after first tap completes');

    // Second tap after first finishes — must succeed
    const secondProceeded = await guardedPublish(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'second tap must proceed after first has completed');
    assert.equal(calls, 2, 'second tap must fire its own network call');
  });

  it('lock is released in finally after an error — next tap is not permanently blocked', async () => {
    const lock = createPublishLock();
    let calls = 0;

    // First tap throws
    try {
      await guardedPublish(lock, async () => {
        calls++;
        throw new Error('network error');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock must be released even when doPublish throws');

    // Next tap can proceed
    const secondProceeded = await guardedPublish(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'next tap must not be permanently blocked after an error');
    assert.equal(calls, 2);
  });

  it('each createPublishLock() returns an independent lock — tests are isolated', () => {
    const lockA = createPublishLock();
    const lockB = createPublishLock();
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
// and bypasses the `disabled` prop, calling doPublish a second time.
//
// These tests confirm this is a real problem without the ref guard, and that the
// ref guard (above) solves it.

describe('memory create — state-only guard is insufficient (documents the gap)', () => {
  it('two synchronous flag reads both see false before setState takes effect', () => {
    // Simulate the React state flag: starts false, setUploading(true) is deferred
    let uploading = false;

    // First tap: reads false → proceeds
    const canPublish1 = !uploading;
    assert.equal(canPublish1, true, 'first tap sees canPublish=true');

    // setUploading(true) is queued but has NOT run yet (next render)
    // uploading = true;  ← this happens asynchronously, not yet

    // Second tap: also reads false → also proceeds (the bug)
    const canPublish2 = !uploading;
    assert.equal(canPublish2, true,
      'second tap also sees canPublish=true — both taps bypass the state guard before the re-render');
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
