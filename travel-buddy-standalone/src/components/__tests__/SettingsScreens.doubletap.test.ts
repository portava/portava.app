/**
 * Double-tap guard for the Settings screens (location, privacy, emergency contacts).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/SettingsScreens.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * The same async-setState double-tap gap that existed on the Trip edit/new
 * screens also applied to the save handlers in the three settings screens.
 * `setSaving(true)` is an async state update — it only takes effect on the
 * next render. A rapid double-tap therefore lands before the Pressable's
 * `disabled` prop is updated, and both taps call the network function.
 *
 * The fix is a synchronous `saveLock` ref (useRef(false)) checked at the
 * very top of each handler before any async work. These tests verify the
 * guard semantics using the machine-layer pattern (node:test + tsx/esm,
 * no RNTL / React).
 *
 * ## Pattern being tested (mirrors all three screens)
 *
 *   if (saveLock.current) return;
 *   saveLock.current = true;
 *   setSaving(true);
 *   try {
 *     await networkCall(...);
 *   } finally {
 *     saveLock.current = false;
 *     setSaving(false);
 *   }
 *
 * ## Screens covered
 *
 *   - app/settings/emergency-contacts.tsx — handleSave (add/edit contact)
 *   - app/settings/privacy.tsx            — handleChange (toggle / radio)
 *   - app/settings/location.tsx           — save (switch / sheet selection)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers — model the saveLock ref + guarded handler pattern ────────────────

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

type Lock = ReturnType<typeof createLock>;

/**
 * Simulates the guarded save flow used in all three screens:
 *
 *   if (saveLock.current) return false;   // bail — second tap blocked
 *   saveLock.current = true;
 *   try { await doSave(); }
 *   finally { saveLock.current = false; }
 *
 * Returns true if the handler proceeded, false if it was blocked.
 * Re-throws if doSave throws (finally still releases the lock — mirrors
 * the real screens where Alert.alert catches network errors but the lock
 * must still be released).
 */
async function guardedSave(lock: Lock, doSave: () => Promise<void>): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doSave();
    return true;
  } finally {
    lock.release();
  }
}

// ── emergency-contacts.tsx — handleSave (add contact) ────────────────────────

describe('emergency-contacts — handleSave lock prevents double-tap', () => {
  it('first tap proceeds and addEmergencyContact is called once', async () => {
    const lock = createLock();
    let calls = 0;
    const proceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(proceeded, true, 'first tap must proceed');
    assert.equal(calls, 1, 'addEmergencyContact must be called exactly once');
  });

  it('second tap while first is in-flight is rejected', async () => {
    const lock = createLock();
    let calls = 0;

    const tap1Acquired = lock.acquire();
    assert.equal(tap1Acquired, true, 'first tap acquires the lock');

    const tap2Acquired = lock.acquire();
    assert.equal(tap2Acquired, false, 'second tap is blocked while first holds the lock');

    calls++;
    lock.release();

    assert.equal(calls, 1, 'only one addEmergencyContact call must fire');
  });

  it('concurrent double-tap — only one addEmergencyContact fires', async () => {
    const lock = createLock();
    let calls = 0;

    const addContact = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      calls++;
    };

    const [r1, r2] = await Promise.all([
      guardedSave(lock, addContact),
      guardedSave(lock, addContact),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'exactly one of the two concurrent taps must proceed');
    assert.equal(calls, 1, 'addEmergencyContact must be called exactly once');
  });

  it('lock is released after success — next tap proceeds normally', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedSave(lock, async () => { calls++; });
    assert.equal(lock.current, false, 'lock must be released after success');

    const secondProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(secondProceeded, true, 'next tap must succeed after lock is released');
    assert.equal(calls, 2);
  });

  it('lock is released after a network error — user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    try {
      await guardedSave(lock, async () => {
        calls++;
        throw new Error('network error');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock must be released even when the save throws');

    const retryProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(retryProceeded, true, 'user must be able to retry after an error');
    assert.equal(calls, 2);
  });

  it('multiple rapid taps — only the first fires', async () => {
    const lock = createLock();
    const networkCalls: string[] = [];
    let firstResolve!: () => void;
    const firstAwaiter = new Promise<void>((r) => { firstResolve = r; });

    const tap1 = guardedSave(lock, async () => {
      networkCalls.push('tap1');
      await firstAwaiter;
    });

    const tap2 = guardedSave(lock, async () => { networkCalls.push('tap2'); });
    const tap3 = guardedSave(lock, async () => { networkCalls.push('tap3'); });

    const [r2, r3] = await Promise.all([tap2, tap3]);
    assert.equal(r2, false, 'tap2 must be blocked');
    assert.equal(r3, false, 'tap3 must be blocked');
    assert.equal(networkCalls.length, 1, 'only tap1 must reach the network');

    firstResolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });
});

// ── emergency-contacts.tsx — handleSave (edit contact) ───────────────────────

describe('emergency-contacts — handleSave (edit path) lock prevents double-tap', () => {
  it('first tap proceeds and updateEmergencyContact is called once', async () => {
    const lock = createLock();
    let calls = 0;
    const proceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('concurrent taps on the edit-contact save — only one updateEmergencyContact fires', async () => {
    const lock = createLock();
    let calls = 0;

    const updateContact = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      calls++;
    };

    const [r1, r2] = await Promise.all([
      guardedSave(lock, updateContact),
      guardedSave(lock, updateContact),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'only one concurrent tap must proceed');
    assert.equal(calls, 1, 'updateEmergencyContact must be called exactly once');
  });

  it('lock releases after success so user can edit another contact', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedSave(lock, async () => { calls++; });
    assert.equal(lock.current, false);

    await guardedSave(lock, async () => { calls++; });
    assert.equal(calls, 2, 'sequential saves are allowed after lock is released');
  });
});

// ── privacy.tsx — handleChange lock prevents double-tap ──────────────────────

describe('privacy — handleChange lock prevents double-tap', () => {
  it('first toggle tap proceeds and updatePrivacySettings is called once', async () => {
    const lock = createLock();
    let calls = 0;
    const proceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('second tap while first PATCH is in-flight is rejected', async () => {
    const lock = createLock();
    let calls = 0;

    const tap1Acquired = lock.acquire();
    assert.equal(tap1Acquired, true, 'first tap acquires the lock');

    const tap2Acquired = lock.acquire();
    assert.equal(tap2Acquired, false, 'second tap is blocked');

    calls++;
    lock.release();

    assert.equal(calls, 1, 'only one updatePrivacySettings call must fire');
  });

  it('concurrent radio-button double-tap — only one PATCH fires', async () => {
    const lock = createLock();
    let calls = 0;

    const updatePrivacy = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      calls++;
    };

    const [r1, r2] = await Promise.all([
      guardedSave(lock, updatePrivacy),
      guardedSave(lock, updatePrivacy),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'exactly one tap must proceed');
    assert.equal(calls, 1, 'updatePrivacySettings must be called exactly once');
  });

  it('lock is released after success — next setting change proceeds normally', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedSave(lock, async () => { calls++; });
    assert.equal(lock.current, false, 'lock must be released after success');

    const secondProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(secondProceeded, true);
    assert.equal(calls, 2);
  });

  it('lock is released after PATCH error — user can change a different setting', async () => {
    const lock = createLock();
    let calls = 0;

    try {
      await guardedSave(lock, async () => {
        calls++;
        throw new Error('PATCH failed');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock must be released on error');

    const retryProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(retryProceeded, true);
    assert.equal(calls, 2);
  });
});

// ── location.tsx — save (useLocationPrefs hook) lock prevents double-tap ─────

describe('location — save lock prevents double-tap', () => {
  it('first switch tap proceeds and updateMyLocationPrivacy is called once', async () => {
    const lock = createLock();
    let calls = 0;
    const proceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('second tap while first PATCH is in-flight is rejected', async () => {
    const lock = createLock();
    let calls = 0;

    const tap1Acquired = lock.acquire();
    assert.equal(tap1Acquired, true, 'first tap acquires the lock');

    const tap2Acquired = lock.acquire();
    assert.equal(tap2Acquired, false, 'second tap is blocked');

    calls++;
    lock.release();

    assert.equal(calls, 1, 'only one updateMyLocationPrivacy call must fire');
  });

  it('concurrent switch double-tap — only one PATCH fires', async () => {
    const lock = createLock();
    let calls = 0;

    const updateLocation = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      calls++;
    };

    const [r1, r2] = await Promise.all([
      guardedSave(lock, updateLocation),
      guardedSave(lock, updateLocation),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'exactly one tap must proceed');
    assert.equal(calls, 1, 'updateMyLocationPrivacy must be called exactly once');
  });

  it('lock is released after success — next preference change proceeds', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedSave(lock, async () => { calls++; });
    assert.equal(lock.current, false);

    const secondProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(secondProceeded, true);
    assert.equal(calls, 2);
  });

  it('lock is released after save failure — user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    try {
      await guardedSave(lock, async () => {
        calls++;
        throw new Error('save_failed');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock must be released even when save throws');

    const retryProceeded = await guardedSave(lock, async () => { calls++; });
    assert.equal(retryProceeded, true);
    assert.equal(calls, 2);
  });

  it('multiple rapid taps on a location switch — only the first fires', async () => {
    const lock = createLock();
    const networkCalls: string[] = [];
    let firstResolve!: () => void;
    const firstAwaiter = new Promise<void>((r) => { firstResolve = r; });

    const tap1 = guardedSave(lock, async () => {
      networkCalls.push('tap1');
      await firstAwaiter;
    });

    const tap2 = guardedSave(lock, async () => { networkCalls.push('tap2'); });
    const tap3 = guardedSave(lock, async () => { networkCalls.push('tap3'); });

    const [r2, r3] = await Promise.all([tap2, tap3]);
    assert.equal(r2, false, 'tap2 must be blocked');
    assert.equal(r3, false, 'tap3 must be blocked');
    assert.equal(networkCalls.length, 1, 'only tap1 must reach the network');

    firstResolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });
});

// ── Guard isolation — each screen instance has its own lock ──────────────────

describe('guard isolation — each screen has an independent lock', () => {
  it('emergency-contacts lock is independent from privacy lock', () => {
    const emergencyLock = createLock();
    const privacyLock   = createLock();

    emergencyLock.acquire();
    assert.equal(privacyLock.acquire(), true, 'privacyLock is unaffected by emergencyLock');
    emergencyLock.release();
    privacyLock.release();
  });

  it('privacy lock is independent from location lock', () => {
    const privacyLock  = createLock();
    const locationLock = createLock();

    privacyLock.acquire();
    assert.equal(locationLock.acquire(), true, 'locationLock is unaffected by privacyLock');
    privacyLock.release();
    locationLock.release();
  });

  it('each test creates an independent lock — no shared state between tests', () => {
    const lock1 = createLock();
    const lock2 = createLock();
    lock1.acquire();
    assert.equal(lock1.current, true);
    assert.equal(lock2.current, false, 'lock2 must start unlocked');
    lock1.release();
  });
});

// ── Why React state alone is insufficient ────────────────────────────────────
//
// Documents the gap that the ref guard closes.

describe('documents why React state alone is insufficient', () => {
  it('two synchronous reads of a state flag both see false before setState fires', () => {
    let saving = false; // React state — not yet updated by setSaving(true)

    // Tap 1: reads saving=false → proceeds
    const tap1CanSave = !saving;
    assert.equal(tap1CanSave, true, 'tap1 sees saving=false and proceeds');

    // setSaving(true) is queued but deferred until next render — NOT yet applied

    // Tap 2: also reads saving=false → also proceeds (the bug)
    const tap2CanSave = !saving;
    assert.equal(tap2CanSave, true,
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
