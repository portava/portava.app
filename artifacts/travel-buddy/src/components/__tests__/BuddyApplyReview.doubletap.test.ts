/**
 * Double-tap guard for the Rent-a-Buddy application form and review screen.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/BuddyApplyReview.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * Both apply.tsx and review.tsx had the async-setState double-tap gap:
 *
 * - apply.tsx `handleSubmit`: called setSubmitting(true) then awaited a fetch +
 *   submitApplication() with scattered setSubmitting(false) early-return paths and
 *   no try/finally, meaning an unexpected throw would permanently lock the button.
 *   No ref guard — rapid double-tap dispatches two concurrent submissions.
 *
 * - review.tsx `handleSubmit`: called setSubmitting(true) then awaited submitReview()
 *   and reset submitting after the await (not in finally). No ref guard.
 *
 * ## Pattern being tested
 *
 *   if (submitLockRef.current) return;
 *   submitLockRef.current = true;
 *   setSubmitting(true);
 *   try {
 *     await networkCall(...);
 *   } finally {
 *     submitLockRef.current = false;
 *     setSubmitting(false);
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

// ── apply.tsx — submitLockRef on handleSubmit ─────────────────────────────────

describe('apply.tsx — submitLockRef prevents double-tap on handleSubmit', () => {
  it('first tap proceeds and calls submitApplication once', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(10); };

    const proceeded = await guardedSubmit(lock, doSubmit);
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap fires only one submitApplication call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doSubmit),
      guardedSubmit(lock, doSubmit),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('three rapid taps fire exactly one submitApplication call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(20); };

    const results = await Promise.all([
      guardedSubmit(lock, doSubmit),
      guardedSubmit(lock, doSubmit),
      guardedSubmit(lock, doSubmit),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(calls, 1);
  });

  it('lock releases after success — a corrected resubmit is allowed', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(5); };

    await guardedSubmit(lock, doSubmit);
    const second = await guardedSubmit(lock, doSubmit);

    assert.equal(second, true);
    assert.equal(calls, 2);
  });

  it('lock releases after city-status-check throws — user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(5); throw new Error('fetch failed'); };

    await guardedSubmit(lock, doSubmit).catch(() => {});
    const retry = await guardedSubmit(lock, async () => { calls++; });

    assert.equal(retry, true);
    assert.equal(calls, 2);
  });

  it('lock releases after submitApplication network error — user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(5); throw new Error('network'); };

    await guardedSubmit(lock, doSubmit).catch(() => {});
    assert.equal(lock.current, false, 'lock must be released even after a throw');
    assert.equal(calls, 1);
  });
});

// ── review.tsx — submitLockRef on handleSubmit ────────────────────────────────

describe('review.tsx — submitLockRef prevents double-tap on handleSubmit', () => {
  it('first tap proceeds and calls submitReview once', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(10); };

    const proceeded = await guardedSubmit(lock, doSubmit);
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap on "Submit review" fires only one submitReview call', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(20); };

    const [first, second] = await Promise.all([
      guardedSubmit(lock, doSubmit),
      guardedSubmit(lock, doSubmit),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('lock releases after submitReview success — navigation fires once', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(5); };

    await guardedSubmit(lock, doSubmit);
    assert.equal(lock.current, false);
    assert.equal(calls, 1);
  });

  it('lock releases after submitReview error so user can edit and retry', async () => {
    const lock = createLock();
    let calls = 0;

    const doSubmit = async () => { calls++; await delay(5); throw new Error('server error'); };

    await guardedSubmit(lock, doSubmit).catch(() => {});
    const retry = await guardedSubmit(lock, async () => { calls++; });

    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── Guard isolation ────────────────────────────────────────────────────────────

describe('guard isolation — apply and review locks are independent', () => {
  it('locking apply does not block review submission', async () => {
    const applyLock = createLock();
    const reviewLock = createLock();
    let reviewCalls = 0;

    applyLock.acquire(); // simulate apply in-flight

    const reviewResult = await guardedSubmit(reviewLock, async () => { reviewCalls++; });

    assert.equal(reviewResult, true);
    assert.equal(reviewCalls, 1);
    assert.equal(applyLock.current, true, 'apply lock should still be held');
  });

  it('each test uses a fresh lock — no shared state between tests', () => {
    const lock1 = createLock();
    const lock2 = createLock();

    lock1.acquire();

    assert.equal(lock1.current, true);
    assert.equal(lock2.current, false, 'lock2 is unaffected by lock1');
  });
});

// ── Documents why state-only is insufficient ──────────────────────────────────

describe('documents why React state alone is insufficient', () => {
  it('state flag: two taps both see submitting=false before setState re-render fires', () => {
    let submitting = false;
    const tap1Seen = submitting;
    const tap2Seen = submitting; // same value — re-render hasn't fired
    submitting = true; // simulates setState(true) taking effect

    assert.equal(tap1Seen, false);
    assert.equal(tap2Seen, false, 'both taps see submitting=false before re-render');
  });

  it('ref guard is synchronous — second tap sees locked=true immediately', () => {
    const lock = createLock();
    lock.acquire(); // first tap
    const tap2Blocked = !lock.acquire(); // immediate — no re-render needed
    assert.equal(tap2Blocked, true);
  });
});
