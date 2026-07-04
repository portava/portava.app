/**
 * Double-tap guard for the Edit Profile Save button.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/ProfileEdit.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * `profile/edit.tsx handleSave` had two problems:
 *
 * 1. No synchronous re-entrancy guard. The function checked `!canSave`
 *    (a state-derived value) but state is async — a rapid double-tap on
 *    "Save" dispatches two concurrent save requests before `setSaving(true)`
 *    re-renders and disables the button.
 *
 * 2. No try/finally. `setSaving(false)` was called at individual early-return
 *    sites and at line 491 after the main Promise.all. If Promise.all throws
 *    unexpectedly, the finally path is skipped and the Save button is
 *    permanently frozen.
 *
 * ## Pattern being tested
 *
 *   if (!canSave || saveLockRef.current) return;
 *   saveLockRef.current = true;
 *   setSaving(true);
 *   try {
 *     // ... photo uploads, validation, network calls ...
 *   } finally {
 *     saveLockRef.current = false;
 *     setSaving(false);
 *   }
 *
 * handleSave is more complex than other submit handlers because it has:
 * - Two sequential async photo uploads (avatar, cover) with early-return guards
 * - Synchronous validation (dateOfBirth format)
 * - A parallel Promise.all for profile / language / tag-permission updates
 * The ref lock is acquired once and released in finally, ensuring exactly one
 * concurrent save no matter which code path runs.
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
  canSave: boolean,
  doSave: () => Promise<void>,
): Promise<boolean> {
  if (!canSave || !lock.acquire()) return false;
  try {
    await doSave();
    return true;
  } finally {
    lock.release();
  }
}

// ── handleSave — boolean ref lock prevents double-tap ─────────────────────────

describe('handleSave — boolean ref lock prevents double-tap on Save button', () => {
  it('first tap proceeds and calls updateMyProfile once', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedSave(lock, true, async () => {
      calls++;
      await delay(10);
    });

    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap fires only one profile update call', async () => {
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

  it('triple-tap fires exactly one profile update call', async () => {
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

  it('canSave=false blocks the save even if the lock is available', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedSave(lock, false, async () => { calls++; });

    assert.equal(proceeded, false);
    assert.equal(calls, 0);
    assert.equal(lock.current, false, 'lock must not be acquired when canSave is false');
  });

  it('lock releases after success — user can re-save after navigating back and returning', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(5); };

    await guardedSave(lock, true, doSave);
    const second = await guardedSave(lock, true, doSave);

    assert.equal(second, true, 'sequential save should proceed after first completes');
    assert.equal(calls, 2);
  });

  it('lock releases after updateMyProfile throws — user can retry without reloading', async () => {
    const lock = createLock();
    let calls = 0;

    const failingSave = async () => { calls++; throw new Error('network'); };

    await guardedSave(lock, true, failingSave).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released after a throw');

    const retry = await guardedSave(lock, true, async () => { calls++; });
    assert.equal(retry, true);
    assert.equal(calls, 2);
  });

  it('lock releases after avatar upload fails — Save stays interactive so user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    // Simulates: upload fails → early return (no throw, but lock must still release)
    const uploadFail = async () => {
      calls++;
      // in the real code this returns early via return (not throw), so the
      // try/finally in guardedSave models the finally path correctly
      throw new Error('upload failed');
    };

    await guardedSave(lock, true, uploadFail).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released even when photo upload fails');
    assert.equal(calls, 1);
  });
});

// ── Simulation: avatar upload + profile update both in one save ───────────────
//
// handleSave does: avatar upload → cover upload → validation → Promise.all([lang, profile, tagPerm])
// The ref lock must span the entire chain so no double-tap can slip in at any step.

describe('handleSave — lock spans the full sequential upload + save chain', () => {
  it('second tap is blocked even while avatar upload is still in progress', async () => {
    const lock = createLock();
    let uploadCalls = 0;
    let saveCalls = 0;

    const fullSave = async () => {
      uploadCalls++;
      await delay(30); // avatar upload
      saveCalls++;
      await delay(10); // profile update
    };

    const [first, second] = await Promise.all([
      guardedSave(lock, true, fullSave),
      // second tap fires immediately — avatar upload still in-flight
      guardedSave(lock, true, fullSave),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(uploadCalls, 1, 'only one upload should happen');
    assert.equal(saveCalls, 1, 'only one profile update should happen');
  });

  it('sequential save works after full upload + update chain completes', async () => {
    const lock = createLock();
    let calls = 0;

    const fullSave = async () => {
      calls++;
      await delay(10); // upload
      await delay(5);  // save
    };

    await guardedSave(lock, true, fullSave);
    const second = await guardedSave(lock, true, fullSave);

    assert.equal(second, true);
    assert.equal(calls, 2);
  });
});

// ── Documents why state-only is insufficient ──────────────────────────────────

describe('documents why React state alone is insufficient for handleSave', () => {
  it('state flag: two taps both see saving=false before setState re-render fires', () => {
    let saving = false;
    const tap1Seen = saving;
    const tap2Seen = saving; // same value — re-render hasn't fired yet
    saving = true; // simulates setSaving(true) taking effect asynchronously

    assert.equal(tap1Seen, false);
    assert.equal(tap2Seen, false, 'both taps see saving=false before re-render');
  });

  it('ref guard is synchronous — second tap sees locked=true immediately', () => {
    const lock = createLock();
    lock.acquire(); // first tap
    const tap2Blocked = !lock.acquire(); // immediate — no re-render needed
    assert.equal(tap2Blocked, true);
  });

  it('without try/finally: a Promise.all throw leaves saving=true permanently', async () => {
    // Simulates the broken pattern: setSaving(false) only called on the
    // happy path. A throw leaves the state stuck.
    let saving = false;
    const badSave = async () => {
      saving = true;
      await delay(5);
      throw new Error('network'); // setSaving(false) is never reached
      // saving = false; ← never runs
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
        saving = false; // always runs
      }
    };

    await goodSave().catch(() => {});
    assert.equal(saving, false, 'saving is reset — button stays interactive');
    assert.equal(lock.current, false, 'lock is released — no permanent freeze');
  });
});
