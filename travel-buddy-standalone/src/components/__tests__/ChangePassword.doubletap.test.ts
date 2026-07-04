/**
 * Double-tap guard for the Change Password Save button.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/ChangePassword.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `profile/change-password.tsx handleSave` uses a `useRef(false)` guard checked
 * synchronously before the async `changePassword()` call. Without it a rapid
 * double-tap would dispatch two concurrent `supabase.auth.updateUser` calls,
 * which could set the password to an inconsistent state or produce duplicate
 * API errors.
 *
 * ## Pattern being tested
 *
 *   if (!isValid || saveLockRef.current) return;
 *   saveLockRef.current = true;
 *   setSaving(true);
 *   try {
 *     // ... validation + changePassword() ...
 *   } finally {
 *     saveLockRef.current = false;
 *     setSaving(false);
 *   }
 *
 * The machine layer below models the lock without importing React or Expo so the
 * test runs in plain Node.js with no native module requirements.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createLock() {
  let locked = false;
  return {
    acquire(): boolean { if (locked) return false; locked = true; return true; },
    release(): void { locked = false; },
    get current(): boolean { return locked; },
  };
}

type LockHandle = ReturnType<typeof createLock>;

async function guardedSave(
  lock: LockHandle,
  isValid: boolean,
  doSave: () => Promise<void>,
): Promise<boolean> {
  if (!isValid || !lock.acquire()) return false;
  try {
    await doSave();
    return true;
  } finally {
    lock.release();
  }
}

// ── handleSave — boolean ref lock prevents double-tap ─────────────────────────

describe('handleSave — boolean ref lock prevents double-tap on Change Password Save button', () => {
  it('first tap proceeds and calls changePassword once', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedSave(lock, true, async () => {
      calls++;
      await delay(10);
    });

    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap fires only one changePassword call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(25); };

    const [first, second] = await Promise.all([
      guardedSave(lock, true, doSave),
      guardedSave(lock, true, doSave),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('triple-tap fires exactly one changePassword call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(20); };

    const results = await Promise.all([
      guardedSave(lock, true, doSave),
      guardedSave(lock, true, doSave),
      guardedSave(lock, true, doSave),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(calls, 1);
  });

  it('isValid=false blocks the save even if the lock is available', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedSave(lock, false, async () => { calls++; });

    assert.equal(proceeded, false);
    assert.equal(calls, 0);
    assert.equal(lock.current, false, 'lock must not be acquired when isValid is false');
  });

  it('lock releases after success — user can change password again after navigating back', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(5); };

    await guardedSave(lock, true, doSave);
    const second = await guardedSave(lock, true, doSave);

    assert.equal(second, true, 'sequential save should proceed after first completes');
    assert.equal(calls, 2);
  });

  it('lock releases after changePassword throws — user can retry without reloading', async () => {
    const lock = createLock();
    let calls = 0;

    const failingSave = async () => { calls++; throw new Error('network'); };

    await guardedSave(lock, true, failingSave).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released after a throw');

    const retry = await guardedSave(lock, true, async () => { calls++; });
    assert.equal(retry, true);
    assert.equal(calls, 2);
  });

  it('lock releases when changePassword returns an error — Save stays interactive for retry', async () => {
    const lock = createLock();
    let calls = 0;

    const errorSave = async () => {
      calls++;
      // Simulates: changePassword returns { error: 'Auth session missing!' }
      // The handler shows an Alert and returns early — the finally still runs
      throw new Error('Auth session missing!');
    };

    await guardedSave(lock, true, errorSave).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released even when API returns an error');
    assert.equal(calls, 1);
  });
});

// ── Documents why React state alone is insufficient ───────────────────────────

describe('documents why React state alone is insufficient for handleSave', () => {
  it('state flag: two taps both see saving=false before setState re-render fires', () => {
    let saving = false;
    const tap1Seen = saving;
    const tap2Seen = saving;
    saving = true;

    assert.equal(tap1Seen, false);
    assert.equal(tap2Seen, false, 'both taps see saving=false before re-render');
  });

  it('ref guard is synchronous — second tap sees locked=true immediately', () => {
    const lock = createLock();
    lock.acquire();
    const tap2Blocked = !lock.acquire();
    assert.equal(tap2Blocked, true);
  });

  it('without try/finally: a throw leaves saving=true permanently (button frozen)', async () => {
    let saving = false;
    const badSave = async () => {
      saving = true;
      await delay(5);
      throw new Error('network');
    };

    await badSave().catch(() => {});
    assert.equal(saving, true, 'saving is stuck — button permanently frozen without try/finally');
  });

  it('with try/finally: saving is always reset even after a throw', async () => {
    let saving = false;
    const lock = createLock();

    const goodSave = async () => {
      if (!lock.acquire()) return;
      saving = true;
      try {
        await delay(5);
        throw new Error('network');
      } finally {
        lock.release();
        saving = false;
      }
    };

    await goodSave().catch(() => {});
    assert.equal(saving, false, 'saving is reset — button stays interactive');
    assert.equal(lock.current, false, 'lock is released — no permanent freeze');
  });
});
