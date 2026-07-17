/**
 * Double-tap guard for the Edit Memory Save button.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/MemoryEdit.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `app/memory/edit.tsx handleSave` guards against rapid double-taps using a
 * synchronous boolean ref (`saveLock`), following the same pattern as the
 * composer's publishLock and the profile/trip editor saveLock guards.
 *
 * The guard pattern:
 *
 *   if (!id || saveLock.current) return;
 *   saveLock.current = true;
 *   setSaving(true);
 *   try {
 *     await updateMemory(id, { ... });
 *   } finally {
 *     setSaving(false);
 *     saveLock.current = false;
 *   }
 *
 * React state (`saving`) is async — `setSaving(true)` does not take effect
 * until the next render. A second tap arriving before that re-render sees
 * `saving=false` and would fire a second PATCH. The synchronous ref prevents
 * this: `saveLock.current` is updated immediately, so the second tap is
 * rejected without a second network call.
 *
 * ## What is tested
 *
 * - Two rapid presses before the first updateMemory resolves → updateMemory
 *   called exactly once, not twice.
 * - Lock releases after success so the user can save again later.
 * - Lock releases after updateMemory throws so the Save button stays
 *   interactive and the user can retry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers — model the saveLock ref + handleSave guard ──────────────────────

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
 * Simulates the guarded save flow from handleSave in app/memory/edit.tsx:
 *
 *   if (!id || saveLock.current) return;
 *   saveLock.current = true;
 *   try { await updateMemory(...); }
 *   finally { saveLock.current = false; }
 *
 * Returns true if the handler proceeded (lock acquired), false if it bailed.
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

// ── Core guard: double-tap fires updateMemory exactly once ────────────────────

describe('memory edit — saveLock prevents double-tap on Save', () => {
  it('single tap proceeds — updateMemory is called once', async () => {
    const lock = createSaveLock();
    let calls = 0;

    const proceeded = await guardedSave(lock, async () => { calls++; });

    assert.equal(proceeded, true, 'first tap must proceed');
    assert.equal(calls, 1, 'updateMemory must be called exactly once');
  });

  it('rapid double-tap before first updateMemory resolves — called exactly once, not twice', async () => {
    const lock = createSaveLock();
    let calls = 0;

    // Simulate an in-flight PATCH that hasn't resolved yet.
    const slowUpdate = async () => {
      calls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    };

    // Both taps fire concurrently — second arrives while first is still awaiting.
    const [first, second] = await Promise.all([
      guardedSave(lock, slowUpdate),
      guardedSave(lock, slowUpdate),
    ]);

    assert.equal(first, true, 'first tap must proceed');
    assert.equal(second, false, 'second tap must be rejected while first is in flight');
    assert.equal(calls, 1, 'updateMemory must not be called a second time');
  });

  it('triple-tap — updateMemory still fires exactly once', async () => {
    const lock = createSaveLock();
    let calls = 0;

    const slowUpdate = async () => {
      calls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    };

    const results = await Promise.all([
      guardedSave(lock, slowUpdate),
      guardedSave(lock, slowUpdate),
      guardedSave(lock, slowUpdate),
    ]);

    const proceeded = results.filter(Boolean).length;
    assert.equal(proceeded, 1, 'only one of three taps must proceed');
    assert.equal(calls, 1, 'updateMemory must be called exactly once');
  });

  it('second tap is blocked while first is explicitly in-flight via direct lock check', () => {
    const lock = createSaveLock();

    // First tap acquires the lock (saveLock.current = true)
    const firstAcquired = lock.acquire();
    assert.equal(firstAcquired, true, 'first tap must acquire the lock');

    // Second tap arrives immediately — lock is still held
    const secondAcquired = lock.acquire();
    assert.equal(secondAcquired, false, 'second tap must be blocked — lock is still held');
    assert.equal(lock.current, true, 'lock must still be held after rejected second tap');

    lock.release();
  });
});

// ── Lock lifecycle: release after success and after failure ───────────────────

describe('memory edit — saveLock is always released in finally', () => {
  it('lock releases after success — sequential save works normally', async () => {
    const lock = createSaveLock();
    let calls = 0;

    await guardedSave(lock, async () => { calls++; });

    assert.equal(lock.current, false, 'lock must be released after successful save');

    const secondProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'next save must proceed after first completes');
    assert.equal(calls, 2, 'both saves must have fired');
  });

  it('lock releases after updateMemory throws — Save stays interactive for retry', async () => {
    const lock = createSaveLock();
    let calls = 0;

    await guardedSave(lock, async () => {
      calls++;
      throw new Error('network error');
    }).catch(() => {});

    assert.equal(lock.current, false, 'lock must be released even when updateMemory throws');
    assert.equal(calls, 1);

    const retryProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(retryProceeded, true, 'user must be able to retry after an error');
    assert.equal(calls, 2);
  });

  it('lock releases after updateMemory returns ok:false (early return path)', async () => {
    // In edit.tsx, result.ok === false causes early return (no throw).
    // The finally block still runs and must release the lock.
    const lock = createSaveLock();
    let calls = 0;

    // Simulate the early-return path: no throw, just returns without navigating.
    const failingSave = async () => {
      calls++;
      // result.ok === false — guard returns without router.back(), lock released in finally.
    };

    await guardedSave(lock, failingSave);
    assert.equal(lock.current, false, 'lock must be released after ok:false early return');
    assert.equal(calls, 1);
  });
});

// ── Why React state alone is insufficient ─────────────────────────────────────

describe('memory edit — documents why saving state alone cannot prevent double-tap', () => {
  it('two taps both see saving=false before setSaving(true) re-render fires', () => {
    let saving = false;

    // First tap reads saving — proceeds
    const tap1Blocked = saving;
    assert.equal(tap1Blocked, false, 'first tap sees saving=false — proceeds');

    // setSaving(true) is queued but not yet applied (next render hasn't happened)

    // Second tap reads the same saving value — also proceeds (the bug without the ref)
    const tap2Blocked = saving;
    assert.equal(tap2Blocked, false,
      'second tap also sees saving=false before re-render — would also proceed without the ref guard');
  });

  it('saveLock ref is synchronous — second tap sees locked=true immediately', () => {
    const lock = createSaveLock();

    lock.acquire(); // first tap — synchronous
    const tap2Blocked = !lock.acquire(); // immediate — no re-render needed
    assert.equal(tap2Blocked, true, 'ref update is synchronous — second tap is blocked immediately');
  });

  it('without try/finally: a throw leaves saving=true permanently (Save button frozen)', async () => {
    let saving = false;

    const badSave = async () => {
      saving = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      throw new Error('network');
      // saving = false; ← never runs — button is permanently frozen
    };

    await badSave().catch(() => {});
    assert.equal(saving, true,
      'saving is stuck at true — Save button permanently frozen without try/finally');
  });

  it('with try/finally: saving is always reset even after a throw', async () => {
    let saving = false;
    const lock = createSaveLock();

    const goodSave = async () => {
      if (!lock.acquire()) return;
      saving = true;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        throw new Error('network');
      } finally {
        lock.release();
        saving = false; // always runs
      }
    };

    await goodSave().catch(() => {});
    assert.equal(saving, false, 'saving is reset — Save button stays interactive');
    assert.equal(lock.current, false, 'lock is released — no permanent freeze');
  });
});
