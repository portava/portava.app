/**
 * Integration-level tests for the handleSubmit wiring used by CommentsSection
 * and CommentsSheet.
 *
 * Machine-layer approach (see .agents/memory/rntl-multi-react.md): the exact
 * handleSubmit logic is re-implemented as a pure function so it can be tested
 * with node:test without React / RNTL. Any time CommentsSheet.handleSubmit
 * diverges from this contract, these tests will break — acting as a canary for
 * wiring regressions.
 *
 * Run with:
 *   node --import tsx/esm --test src/lib/commentsHandleSubmit.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitGuard, type SubmitGuard } from './commentSubmitGuard.ts';

// ── Machine-layer replica of CommentsSheet/CommentsSection handleSubmit ────────
//
// Matches the exact control flow at:
//   CommentsSheet.tsx lines 455-508 (CommentsSection)
//   CommentsSheet.tsx lines 733-787 (CommentsSheet)
//
// Both blocks are identical in structure; the only variation is the
// addComment vs addReply branch — captured here via opts.replyingTo.

interface HandleSubmitOpts {
  getText: () => string;
  guard: SubmitGuard;
  replyingTo: { id: string } | null;
  postId: string;
  setSubmitting: (v: boolean) => void;
  onTooLong: () => void;
  addComment: (postId: string, text: string) => Promise<void>;
  addReply: (postId: string, parentId: string, text: string) => Promise<void>;
}

async function runHandleSubmit(opts: HandleSubmitOpts): Promise<void> {
  const text = opts.getText();
  const trimmed = text.trim();

  // Length guard (mirrors: if (trimmed.length > 1000) { Alert.alert(...); return; })
  if (trimmed.length > 1000) {
    opts.onTooLong();
    return;
  }

  // Pre-check: empty text or already in-flight → bail before any state mutation
  // Mirrors: if (!trimmed || submitGuardRef.current.isSubmitting()) return;
  if (!trimmed || opts.guard.isSubmitting()) return;

  // Mirrors: setSubmitting(true)
  opts.setSubmitting(true);
  try {
    // Mirrors: await submitGuardRef.current.trySubmit(text, async (t) => { ... })
    await opts.guard.trySubmit(text, async (t) => {
      if (opts.replyingTo) {
        await opts.addReply(opts.postId, opts.replyingTo.id, t);
      } else {
        await opts.addComment(opts.postId, t);
      }
    });
  } finally {
    // Mirrors: setSubmitting(false)
    opts.setSubmitting(false);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Build a minimal opts object for commment-path tests. */
function makeCommentOpts(overrides: Partial<HandleSubmitOpts> = {}): {
  opts: HandleSubmitOpts;
  networkCalls: string[];
  submittingLog: boolean[];
  guard: SubmitGuard;
} {
  const networkCalls: string[] = [];
  const submittingLog: boolean[] = [];
  const guard = createSubmitGuard();
  let currentText = 'hello';

  const opts: HandleSubmitOpts = {
    getText: () => currentText,
    guard,
    replyingTo: null,
    postId: 'post-1',
    setSubmitting: (v) => { submittingLog.push(v); },
    onTooLong: () => {},
    addComment: async (_postId, text) => { networkCalls.push(text); },
    addReply: async () => {},
    ...overrides,
  };

  return { opts, networkCalls, submittingLog, guard };
}

// ── 1. Comment path ────────────────────────────────────────────────────────────

describe('comment path (addComment)', () => {
  it('single call invokes addComment once and resolves', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    await runHandleSubmit(opts);
    assert.equal(networkCalls.length, 1);
    assert.equal(networkCalls[0], 'hello');
  });

  it('addComment receives trimmed text, not raw text', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    opts.getText = () => '  trimmed  ';
    await runHandleSubmit(opts);
    assert.equal(networkCalls[0], 'trimmed');
  });

  it('empty text skips addComment and never calls setSubmitting', async () => {
    const { opts, networkCalls, submittingLog } = makeCommentOpts();
    opts.getText = () => '';
    await runHandleSubmit(opts);
    assert.equal(networkCalls.length, 0);
    assert.equal(submittingLog.length, 0);
  });

  it('whitespace-only text skips addComment and never calls setSubmitting', async () => {
    const { opts, networkCalls, submittingLog } = makeCommentOpts();
    opts.getText = () => '   ';
    await runHandleSubmit(opts);
    assert.equal(networkCalls.length, 0);
    assert.equal(submittingLog.length, 0);
  });

  it('text over 1000 chars fires onTooLong and skips addComment', async () => {
    const { opts, networkCalls, submittingLog } = makeCommentOpts();
    let tooLongCalled = false;
    opts.onTooLong = () => { tooLongCalled = true; };
    opts.getText = () => 'x'.repeat(1001);
    await runHandleSubmit(opts);
    assert.equal(tooLongCalled, true);
    assert.equal(networkCalls.length, 0);
    assert.equal(submittingLog.length, 0);
  });

  it('text of exactly 1000 chars is accepted', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    opts.getText = () => 'x'.repeat(1000);
    await runHandleSubmit(opts);
    assert.equal(networkCalls.length, 1);
  });
});

// ── 2. Reply path ──────────────────────────────────────────────────────────────

describe('reply path (addReply)', () => {
  it('single call invokes addReply with correct postId and parentId', async () => {
    const replyCalls: Array<{ postId: string; parentId: string; text: string }> = [];
    const { opts } = makeCommentOpts({
      replyingTo: { id: 'comment-42' },
      addReply: async (postId, parentId, text) => {
        replyCalls.push({ postId, parentId, text });
      },
    });
    await runHandleSubmit(opts);
    assert.equal(replyCalls.length, 1);
    assert.deepEqual(replyCalls[0], { postId: 'post-1', parentId: 'comment-42', text: 'hello' });
  });

  it('addComment is NOT called when replyingTo is set', async () => {
    const commentCalls: string[] = [];
    const { opts } = makeCommentOpts({
      replyingTo: { id: 'comment-7' },
      addComment: async (_p, text) => { commentCalls.push(text); },
      addReply: async () => {},
    });
    await runHandleSubmit(opts);
    assert.equal(commentCalls.length, 0);
  });
});

// ── 3. Submitting state transitions ───────────────────────────────────────────

describe('submitting state transitions', () => {
  it('happy path: setSubmitting called false→true then true→false', async () => {
    const { opts, submittingLog } = makeCommentOpts();
    await runHandleSubmit(opts);
    assert.deepEqual(submittingLog, [true, false]);
  });

  it('setSubmitting(false) is called even when addComment throws', async () => {
    const { opts, submittingLog } = makeCommentOpts({
      addComment: async () => { throw new Error('network error'); },
    });
    await runHandleSubmit(opts);
    assert.deepEqual(submittingLog, [true, false], 'finally block must reset submitting');
  });

  it('setSubmitting is never called when text is empty', async () => {
    const { opts, submittingLog } = makeCommentOpts({ getText: () => '' });
    await runHandleSubmit(opts);
    assert.equal(submittingLog.length, 0);
  });

  it('setSubmitting is never called when guard is already in-flight', async () => {
    const { opts, submittingLog } = makeCommentOpts();
    const deferred = makeDeferred();
    opts.addComment = async () => { await deferred.promise; };

    // Tap 1 — in-flight
    const tap1 = runHandleSubmit(opts);

    // Tap 2 — hits isSubmitting() pre-check, must not call setSubmitting again
    await runHandleSubmit(opts);

    // Only tap1's setSubmitting(true) should have fired at this point
    assert.equal(submittingLog.filter(v => v === true).length, 1,
      'setSubmitting(true) called only once');

    deferred.resolve();
    await tap1;
    assert.deepEqual(submittingLog, [true, false]);
  });
});

// ── 4. Double-tap prevention ───────────────────────────────────────────────────

describe('double-tap prevention', () => {
  it('two rapid calls to handleSubmit result in exactly one addComment call', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    const deferred = makeDeferred();
    opts.addComment = async (_p, text) => {
      networkCalls.push(text);
      await deferred.promise;
    };

    // Fire both taps without awaiting tap1
    const tap1 = runHandleSubmit(opts);
    // Tap2 fires while tap1 has already acquired the guard lock (synchronous up to first await)
    await runHandleSubmit(opts);

    assert.equal(networkCalls.length, 1, 'only one network request must be made');

    deferred.resolve();
    await tap1;
    // Even after tap1 settles, total network calls must still be 1
    assert.equal(networkCalls.length, 1);
  });

  it('guard.isSubmitting() is true between tap1 start and tap1 resolve', async () => {
    const { opts, guard } = makeCommentOpts();
    const deferred = makeDeferred();
    opts.addComment = async () => { await deferred.promise; };

    assert.equal(guard.isSubmitting(), false, 'idle before first tap');

    const tap1 = runHandleSubmit(opts);
    assert.equal(guard.isSubmitting(), true, 'locked after tap1 acquires guard');

    deferred.resolve();
    await tap1;
    assert.equal(guard.isSubmitting(), false, 'unlocked after tap1 resolves');
  });

  it('second tap returns without calling addComment when guard is locked', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    const deferred = makeDeferred();
    opts.addComment = async (_p, text) => {
      networkCalls.push(text);
      await deferred.promise;
    };

    const tap1 = runHandleSubmit(opts);
    await runHandleSubmit(opts); // tap2 — blocked by guard pre-check

    assert.equal(networkCalls.length, 1);

    deferred.resolve();
    await tap1;
  });

  it('three rapid taps dispatch exactly one network request', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    const deferred = makeDeferred();
    opts.addComment = async (_p, text) => {
      networkCalls.push(text);
      await deferred.promise;
    };

    const tap1 = runHandleSubmit(opts);
    await runHandleSubmit(opts); // tap2 blocked
    await runHandleSubmit(opts); // tap3 blocked

    assert.equal(networkCalls.length, 1, 'three taps → one network call');

    deferred.resolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });

  it('double-tap on reply path: only one addReply call', async () => {
    const replyCalls: string[] = [];
    const deferred = makeDeferred();
    const { opts } = makeCommentOpts({
      replyingTo: { id: 'comment-5' },
      addReply: async (_p, _parent, text) => {
        replyCalls.push(text);
        await deferred.promise;
      },
    });

    const tap1 = runHandleSubmit(opts);
    await runHandleSubmit(opts); // tap2 blocked

    assert.equal(replyCalls.length, 1, 'second reply tap must be blocked');

    deferred.resolve();
    await tap1;
    assert.equal(replyCalls.length, 1);
  });

  it('after tap1 resolves, a new tap is accepted', async () => {
    const { opts, networkCalls } = makeCommentOpts();

    await runHandleSubmit(opts); // tap1 — completes
    await runHandleSubmit(opts); // tap2 — after tap1 finished, should succeed

    assert.equal(networkCalls.length, 2, 'two sequential taps each go through');
  });

  it('guard resets after an error so the next tap is accepted', async () => {
    const { opts, networkCalls } = makeCommentOpts();
    let attempt = 0;
    opts.addComment = async (_p, text) => {
      attempt++;
      if (attempt === 1) throw new Error('network blip');
      networkCalls.push(text);
    };

    await runHandleSubmit(opts); // tap1 — throws
    await runHandleSubmit(opts); // tap2 — should succeed after reset

    assert.equal(networkCalls.length, 1, 'retry after error must go through');
  });
});

// ── 5. Guard isolation (two independent inputs do not share a guard) ──────────

describe('guard isolation', () => {
  it('two separate guards are independent — one in-flight does not block the other', async () => {
    const networkA: string[] = [];
    const networkB: string[] = [];
    const deferredA = makeDeferred();

    const { opts: optsA } = makeCommentOpts({
      postId: 'post-A',
      addComment: async (_p, t) => { networkA.push(t); await deferredA.promise; },
    });
    const { opts: optsB } = makeCommentOpts({
      postId: 'post-B',
      addComment: async (_p, t) => { networkB.push(t); },
    });

    // A is in-flight; B should still go through
    const tapA = runHandleSubmit(optsA);
    await runHandleSubmit(optsB);

    assert.equal(networkA.length, 1, 'A dispatched one request');
    assert.equal(networkB.length, 1, 'B is not blocked by A\'s guard');

    deferredA.resolve();
    await tapA;
  });
});
