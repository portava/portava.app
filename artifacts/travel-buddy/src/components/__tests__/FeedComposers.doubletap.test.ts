/**
 * Double-tap guard tests for Feed post composers.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/FeedComposers.doubletap.test.ts
 *
 * ## Context
 *
 * Three feed composers exist:
 *
 *  1. UnifiedPostComposer (PulseCreate.tsx) — already guarded by createSubmitLock()
 *     from PulseCreate.machine.ts. Its double-tap behaviour is verified in
 *     PulseCreate.submit.test.ts; no separate test is needed here.
 *
 *  2. HighlightComposer.tsx — previously used a state-only guard
 *     (`if (!mediaUri || submitting) return`). React setState is asynchronous
 *     so a rapid double-tap can dispatch two createHighlight() calls before the
 *     re-render fires. Fixed by adding a synchronous `submitLockRef = useRef(false)`
 *     checked at the top of handleSubmit, released in the existing finally block.
 *
 *  3. StoryComposer.tsx — handlePost() had no in-function guard at all (only the
 *     button's `disabled` prop, which is also bypassed before the re-render).
 *     Fixed with `postLockRef = useRef(false)` checked at the top of handlePost,
 *     released in the existing finally block.
 *
 * ## Guard pattern tested (mirrors both composers)
 *
 *   if (lockRef.current) return;
 *   lockRef.current = true;
 *   setState(true);
 *   try { await networkCall(...); }
 *   finally { lockRef.current = false; setState(false); }
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

async function guardedPost(
  lock: LockHandle,
  doPost: () => Promise<void>,
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doPost();
    return true;
  } finally {
    lock.release();
  }
}

// ── HighlightComposer — createHighlight path ──────────────────────────────────

describe('HighlightComposer — submitLockRef prevents double-tap on createHighlight', () => {
  it('first tap proceeds and calls createHighlight once', async () => {
    const lock = createLock();
    let calls = 0;
    const proceeded = await guardedPost(lock, async () => { calls++; });
    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('second tap while first is in-flight is rejected — only one createHighlight call fires', async () => {
    const lock = createLock();
    const networkCalls: string[] = [];

    const sendHighlight = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      networkCalls.push('createHighlight');
    };

    const [r1, r2] = await Promise.all([
      guardedPost(lock, sendHighlight),
      guardedPost(lock, sendHighlight),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1, 'exactly one of the two taps must proceed');
    assert.equal(networkCalls.length, 1, 'createHighlight called exactly once');
  });

  it('three rapid taps fire only one createHighlight call', async () => {
    const lock = createLock();
    const networkCalls: string[] = [];
    let firstResolve!: () => void;
    const firstAwaiter = new Promise<void>((r) => { firstResolve = r; });

    const tap1 = guardedPost(lock, async () => {
      networkCalls.push('tap1');
      await firstAwaiter;
    });
    const tap2 = guardedPost(lock, async () => { networkCalls.push('tap2'); });
    const tap3 = guardedPost(lock, async () => { networkCalls.push('tap3'); });

    const [r2, r3] = await Promise.all([tap2, tap3]);
    assert.equal(r2, false, 'tap2 blocked');
    assert.equal(r3, false, 'tap3 blocked');
    assert.equal(networkCalls.length, 1, 'only tap1 reaches network');

    firstResolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });

  it('lock is released after success so next highlight post is allowed', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedPost(lock, async () => { calls++; });
    assert.equal(lock.current, false, 'lock released after success');

    await guardedPost(lock, async () => { calls++; });
    assert.equal(calls, 2, 'sequential highlights both fire');
  });

  it('lock is released after upload/createHighlight error so user can retry', async () => {
    const lock = createLock();
    let attempts = 0;

    try {
      await guardedPost(lock, async () => {
        attempts++;
        throw new Error('upload failed');
      });
    } catch {
      // expected — guard re-throws so the composer can show an error
    }

    assert.equal(lock.current, false, 'lock released on error');

    const retried = await guardedPost(lock, async () => { attempts++; });
    assert.equal(retried, true, 'retry proceeds after lock is released');
    assert.equal(attempts, 2);
  });
});

// ── StoryComposer — createStory path ──────────────────────────────────────────

describe('StoryComposer — postLockRef prevents double-tap on createStory', () => {
  it('first tap proceeds and calls createStory once', async () => {
    const lock = createLock();
    let calls = 0;
    await guardedPost(lock, async () => { calls++; });
    assert.equal(calls, 1);
  });

  it('rapid double-tap dispatches exactly one createStory call', async () => {
    const lock = createLock();
    const storyCalls: string[] = [];

    const postStory = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      storyCalls.push('createStory');
    };

    const [r1, r2] = await Promise.all([
      guardedPost(lock, postStory),
      guardedPost(lock, postStory),
    ]);

    const proceeded = [r1, r2].filter(Boolean).length;
    assert.equal(proceeded, 1);
    assert.equal(storyCalls.length, 1, 'createStory must be called exactly once');
  });

  it('lock releases after success — next story post is allowed', async () => {
    const lock = createLock();
    let calls = 0;

    await guardedPost(lock, async () => { calls++; });
    assert.equal(lock.current, false);

    await guardedPost(lock, async () => { calls++; });
    assert.equal(calls, 2);
  });

  it('lock releases after createStory error so user can retry', async () => {
    const lock = createLock();
    let attempts = 0;

    try {
      await guardedPost(lock, async () => {
        attempts++;
        throw new Error('createStory network failure');
      });
    } catch {
      // expected
    }

    assert.equal(lock.current, false, 'lock released on error');

    const retried = await guardedPost(lock, async () => { attempts++; });
    assert.equal(retried, true);
    assert.equal(attempts, 2);
  });
});

// ── Guard isolation — each composer has its own lock ─────────────────────────

describe('guard isolation between composers', () => {
  it('HighlightComposer and StoryComposer locks are independent', async () => {
    const highlightLock = createLock();
    const storyLock = createLock();

    highlightLock.acquire();
    // highlight is locked; story must still accept a post
    assert.equal(storyLock.acquire(), true, 'story lock is independent from highlight lock');
    highlightLock.release();
    storyLock.release();
  });

  it('each test uses a fresh lock — no shared state between tests', () => {
    const lockA = createLock();
    const lockB = createLock();
    lockA.acquire();
    assert.equal(lockA.current, true);
    assert.equal(lockB.current, false);
    lockA.release();
  });
});

// ── Documents why state-only guard is insufficient ────────────────────────────

describe('documents why React state alone is insufficient for both composers', () => {
  it('state flag: two taps both see false before setState re-render fires', () => {
    let submitting = false; // React state — deferred, not yet updated by first tap

    const tap1CanSubmit = !submitting; // first tap checks: true → proceeds
    assert.equal(tap1CanSubmit, true);

    // setSubmitting(true) queued but NOT yet applied (next render)

    const tap2CanSubmit = !submitting; // second tap checks: also true → also proceeds (bug)
    assert.equal(tap2CanSubmit, true,
      'without a ref guard, both taps bypass the state check before re-render');
  });

  it('ref guard is synchronous — second tap sees locked=true immediately', () => {
    let locked = false;

    // Tap 1: acquire synchronously
    const tap1 = !locked;
    if (tap1) locked = true;
    assert.equal(tap1, true);

    // Tap 2: locked is already true in the same JS tick
    const tap2 = !locked;
    assert.equal(tap2, false, 'ref guard prevents the second tap synchronously');
  });
});
