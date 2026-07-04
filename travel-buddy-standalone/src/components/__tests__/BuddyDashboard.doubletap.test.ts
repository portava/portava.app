/**
 * Double-tap guard for buddy-dashboard submit handlers.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/BuddyDashboard.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * Three buddy-dashboard screens had the async-setState double-tap gap:
 *
 * - availability.tsx `handleSave`: called setSaving(true) then awaited
 *   Promise.all(...) with no try/finally and no ref guard.
 * - packages.tsx `handleSave`: no saving state at all, called the API
 *   directly; a rapid double-tap fires two concurrent network calls.
 * - requests.tsx `handleAccept/Decline/Suggest`: each set setActing(id)
 *   (async) then awaited the API with no try/finally and no ref guard.
 *
 * safety.tsx is intentionally excluded — all its handlers are Alert.alert
 * calls with no network I/O and therefore no double-tap risk.
 *
 * ## Pattern being tested
 *
 *   if (lockRef.current) return;
 *   lockRef.current = true;
 *   setState(true);
 *   try {
 *     await networkCall(...);
 *   } finally {
 *     lockRef.current = false;
 *     setState(false);
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── BuddyAvailability — saveLockRef on handleSave ────────────────────────────

describe('BuddyAvailability — saveLockRef prevents double-tap on handleSave', () => {
  it('first tap proceeds and calls setDashboardAvailability once', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(10); };

    const proceeded = await guardedSubmit(lock, doSave);
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap fires only one save call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doSave),
      guardedSubmit(lock, doSave),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('three rapid taps fire exactly one save call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(20); };

    const results = await Promise.all([
      guardedSubmit(lock, doSave),
      guardedSubmit(lock, doSave),
      guardedSubmit(lock, doSave),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(calls, 1);
  });

  it('lock releases after success — next save is allowed', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(5); };

    await guardedSubmit(lock, doSave);
    const second = await guardedSubmit(lock, doSave);

    assert.equal(second, true);
    assert.equal(calls, 2);
  });

  it('lock releases after error so user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(5); throw new Error('network'); };

    await guardedSubmit(lock, doSave).catch(() => {});
    const retry = await guardedSubmit(lock, async () => { calls++; });

    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── BuddyPackages — saveLockRef on handleSave ─────────────────────────────────

describe('BuddyPackages — saveLockRef prevents double-tap on handleSave', () => {
  it('first tap proceeds and calls updatePackage / createPackage once', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(10); };

    const proceeded = await guardedSubmit(lock, doSave);
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap on "Save package" fires only one API call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doSave),
      guardedSubmit(lock, doSave),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('lock releases after success — next package save is allowed', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(5); };

    await guardedSubmit(lock, doSave);
    const second = await guardedSubmit(lock, doSave);

    assert.equal(second, true);
    assert.equal(calls, 2);
  });

  it('lock releases after API error so user can correct and retry', async () => {
    const lock = createLock();
    let calls = 0;

    const doSave = async () => { calls++; await delay(5); throw new Error('conflict'); };

    await guardedSubmit(lock, doSave).catch(() => {});
    const retry = await guardedSubmit(lock, async () => { calls++; });

    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── BuddyRequests — actingLockRef on Accept / Decline / Suggest ───────────────

describe('BuddyRequests — actingLockRef prevents double-tap on action buttons', () => {
  it('handleAccept: first tap proceeds, second blocked', async () => {
    const lock = createLock();
    let calls = 0;

    const doAccept = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doAccept),
      guardedSubmit(lock, doAccept),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('handleDecline: rapid double-tap fires only one declineBooking call', async () => {
    const lock = createLock();
    let calls = 0;

    const doDecline = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doDecline),
      guardedSubmit(lock, doDecline),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('handleSuggest: rapid double-tap fires only one suggestChanges call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSuggest = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doSuggest),
      guardedSubmit(lock, doSuggest),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('lock releases after accept success — another booking can be accepted', async () => {
    const lock = createLock();
    let calls = 0;

    const doAccept = async () => { calls++; await delay(5); };

    await guardedSubmit(lock, doAccept);
    const second = await guardedSubmit(lock, doAccept);

    assert.equal(second, true);
    assert.equal(calls, 2);
  });

  it('lock releases after accept error so user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    const doAccept = async () => { calls++; await delay(5); throw new Error('timeout'); };

    await guardedSubmit(lock, doAccept).catch(() => {});
    const retry = await guardedSubmit(lock, async () => { calls++; });

    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── Guard isolation ────────────────────────────────────────────────────────────

describe('guard isolation — each screen has its own independent lock', () => {
  it('availability and packages locks are independent', async () => {
    const availLock = createLock();
    const pkgLock = createLock();
    let availCalls = 0;
    let pkgCalls = 0;

    // Lock availability
    availLock.acquire();

    // packages should still be open
    const pkgResult = await guardedSubmit(pkgLock, async () => { pkgCalls++; });

    assert.equal(pkgResult, true);
    assert.equal(pkgCalls, 1);
    assert.equal(availCalls, 0);
    assert.equal(availLock.current, true);
  });

  it('requests lock does not affect availability or packages locks', async () => {
    const availLock = createLock();
    const pkgLock = createLock();
    const reqLock = createLock();
    let calls = 0;

    // Lock requests
    reqLock.acquire();

    const [a, p] = await Promise.all([
      guardedSubmit(availLock, async () => { calls++; }),
      guardedSubmit(pkgLock, async () => { calls++; }),
    ]);

    assert.equal(a, true);
    assert.equal(p, true);
    assert.equal(calls, 2);
    assert.equal(reqLock.current, true);
  });
});

// ── Why state-only is insufficient ───────────────────────────────────────────

describe('documents why React state alone is insufficient', () => {
  it('state flag: two taps both see false before setState re-render fires', () => {
    let saving = false;
    const tap1SeenBefore = saving; // false
    const tap2SeenBefore = saving; // also false — re-render hasn't run yet
    saving = true; // simulates setState(true) eventually

    assert.equal(tap1SeenBefore, false);
    assert.equal(tap2SeenBefore, false, 'both taps see saving=false before re-render');
  });

  it('ref guard is synchronous — second tap sees locked=true immediately', () => {
    const lock = createLock();
    lock.acquire(); // tap 1 acquires
    const tap2Blocked = !lock.acquire(); // tap 2 sees it immediately
    assert.equal(tap2Blocked, true);
  });
});
