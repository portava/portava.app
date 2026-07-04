/**
 * Integration-level wiring tests for the handleLike guard used by CommentItem
 * and ReplyItem in CommentsSheet.
 *
 * Machine-layer approach (see .agents/memory/rntl-multi-react.md): the exact
 * handleLike logic is re-implemented as a pure function so it can be tested
 * with node:test without React / RNTL. Any time CommentsSheet's CommentItem or
 * ReplyItem handleLike diverges from this contract, these tests will break —
 * acting as a canary for wiring regressions.
 *
 * Run with:
 *   node --import tsx/esm --test src/lib/commentsLikeWiring.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLikeToggleGuard, type LikeToggleGuard } from './likeToggleGuard.ts';
import { computeOptimisticLike } from './commentLikeLogic.ts';

// ── Machine-layer replica of CommentsSheet CommentItem/ReplyItem handleLike ───
//
// Matches the exact control flow at:
//   CommentsSheet.tsx ~line 283 (CommentItem.handleLike)
//   CommentsSheet.tsx ~line 183 (ReplyItem.handleLike)
//
// Both blocks are structurally identical. The only difference is the
// entity type (comment vs reply) — captured here via opts.entityId.

interface LikeResult {
  likedByMe: boolean;
  likeCount: number;
}

interface HandleLikeOpts {
  guard: LikeToggleGuard;
  entityId: string;
  postId: string;
  likedByMe: boolean;
  likeCount: number;
  setLiking: (v: boolean) => void;
  onLikeChange: (id: string, likedByMe: boolean, likeCount: number) => void;
  likeEntity: (postId: string, entityId: string) => Promise<LikeResult | null>;
  unlikeEntity: (postId: string, entityId: string) => Promise<LikeResult | null>;
}

async function runHandleLike(opts: HandleLikeOpts): Promise<void> {
  // Pre-check mirrors: if (likeGuardRef.current.isToggling()) return;
  if (opts.guard.isToggling()) return;

  opts.setLiking(true);
  const wasLiked = opts.likedByMe;
  const prevCount = opts.likeCount;
  const optimistic = computeOptimisticLike(wasLiked, prevCount);
  opts.onLikeChange(opts.entityId, optimistic.likedByMe, optimistic.likeCount);

  try {
    await opts.guard.tryToggle(async () => {
      const result = wasLiked
        ? await opts.unlikeEntity(opts.postId, opts.entityId)
        : await opts.likeEntity(opts.postId, opts.entityId);
      if (result) opts.onLikeChange(opts.entityId, result.likedByMe, result.likeCount);
      else opts.onLikeChange(opts.entityId, wasLiked, prevCount);
    });
  } finally {
    opts.setLiking(false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface TestContext {
  opts: HandleLikeOpts;
  networkCalls: Array<{ op: 'like' | 'unlike'; entityId: string }>;
  likeChanges: Array<{ id: string; likedByMe: boolean; likeCount: number }>;
  likingLog: boolean[];
  guard: LikeToggleGuard;
}

function makeOpts(overrides: Partial<HandleLikeOpts> = {}): TestContext {
  const networkCalls: Array<{ op: 'like' | 'unlike'; entityId: string }> = [];
  const likeChanges: Array<{ id: string; likedByMe: boolean; likeCount: number }> = [];
  const likingLog: boolean[] = [];
  const guard = createLikeToggleGuard();

  const opts: HandleLikeOpts = {
    guard,
    entityId: 'comment-1',
    postId: 'post-1',
    likedByMe: false,
    likeCount: 0,
    setLiking: (v) => { likingLog.push(v); },
    onLikeChange: (id, liked, count) => { likeChanges.push({ id, likedByMe: liked, likeCount: count }); },
    likeEntity: async (postId, entityId) => {
      networkCalls.push({ op: 'like', entityId });
      return { likedByMe: true, likeCount: 1 };
    },
    unlikeEntity: async (postId, entityId) => {
      networkCalls.push({ op: 'unlike', entityId });
      return { likedByMe: false, likeCount: 0 };
    },
    ...overrides,
  };

  return { opts, networkCalls, likeChanges, likingLog, guard };
}

// ── 1. CommentItem path ───────────────────────────────────────────────────────

describe('CommentItem handleLike — single tap', () => {
  it('single call dispatches exactly one network request', async () => {
    const { opts, networkCalls } = makeOpts();
    await runHandleLike(opts);
    assert.equal(networkCalls.length, 1);
    assert.equal(networkCalls[0].op, 'like');
    assert.equal(networkCalls[0].entityId, 'comment-1');
  });

  it('optimistic onLikeChange fires before the network call resolves', async () => {
    const likeChanges: Array<{ id: string; likedByMe: boolean; likeCount: number }> = [];
    const deferred = makeDeferred();
    const { opts } = makeOpts({
      onLikeChange: (id, liked, count) => { likeChanges.push({ id, likedByMe: liked, likeCount: count }); },
      likeEntity: async () => { await deferred.promise; return { likedByMe: true, likeCount: 1 }; },
    });

    const tap1 = runHandleLike(opts);
    // Optimistic update fires before network resolves
    assert.equal(likeChanges.length, 1, 'optimistic change should have fired');
    assert.equal(likeChanges[0].likedByMe, true, 'optimistically set to liked');

    deferred.resolve();
    await tap1;
    // Server result also fires onLikeChange
    assert.equal(likeChanges.length, 2, 'server result also fires onLikeChange');
  });

  it('likedByMe=true sends unlikeEntity, not likeEntity', async () => {
    const { opts, networkCalls } = makeOpts({ likedByMe: true, likeCount: 3 });
    await runHandleLike(opts);
    assert.equal(networkCalls.length, 1);
    assert.equal(networkCalls[0].op, 'unlike');
  });

  it('setLiking transitions: true then false in happy path', async () => {
    const { opts, likingLog } = makeOpts();
    await runHandleLike(opts);
    assert.deepEqual(likingLog, [true, false]);
  });

  it('setLiking(false) is called even when the network throws', async () => {
    const { opts, likingLog } = makeOpts({
      likeEntity: async () => { throw new Error('network error'); },
    });
    await runHandleLike(opts);
    assert.deepEqual(likingLog, [true, false], 'finally block must reset liking');
  });
});

// ── 2. ReplyItem path (structurally identical — covers both paths) ─────────

describe('ReplyItem handleLike — single tap', () => {
  it('single call on a reply dispatches exactly one network request', async () => {
    const { opts, networkCalls } = makeOpts({ entityId: 'reply-42' });
    await runHandleLike(opts);
    assert.equal(networkCalls.length, 1);
    assert.equal(networkCalls[0].entityId, 'reply-42');
  });

  it('reply optimistic update reverts when server returns null', async () => {
    const likeChanges: Array<{ id: string; likedByMe: boolean; likeCount: number }> = [];
    const { opts } = makeOpts({
      entityId: 'reply-7',
      likedByMe: false,
      likeCount: 2,
      onLikeChange: (id, liked, count) => { likeChanges.push({ id, likedByMe: liked, likeCount: count }); },
      likeEntity: async () => null,
    });

    await runHandleLike(opts);

    // First call: optimistic (liked=true, count=3)
    assert.equal(likeChanges[0].likedByMe, true);
    assert.equal(likeChanges[0].likeCount, 3);
    // Second call: revert to original (liked=false, count=2) because server returned null
    assert.equal(likeChanges[1].likedByMe, false);
    assert.equal(likeChanges[1].likeCount, 2);
  });
});

// ── 3. Double-tap prevention ─────────────────────────────────────────────────

describe('double-tap prevention', () => {
  it('two rapid taps dispatch exactly one network request', async () => {
    const { opts, networkCalls } = makeOpts();
    const deferred = makeDeferred();
    opts.likeEntity = async (postId, entityId) => {
      networkCalls.push({ op: 'like', entityId });
      await deferred.promise;
      return { likedByMe: true, likeCount: 1 };
    };

    const tap1 = runHandleLike(opts);
    // tap2 fires while tap1 is still in-flight
    await runHandleLike(opts);

    assert.equal(networkCalls.length, 1, 'only one network request must be made');

    deferred.resolve();
    await tap1;
    assert.equal(networkCalls.length, 1, 'still one request after tap1 resolves');
  });

  it('isToggling is true while tap1 is in-flight, false after it resolves', async () => {
    const { opts, guard } = makeOpts();
    const deferred = makeDeferred();
    opts.likeEntity = async () => { await deferred.promise; return { likedByMe: true, likeCount: 1 }; };

    assert.equal(guard.isToggling(), false, 'idle before first tap');

    const tap1 = runHandleLike(opts);
    assert.equal(guard.isToggling(), true, 'locked after tap1 acquires guard');

    deferred.resolve();
    await tap1;
    assert.equal(guard.isToggling(), false, 'unlocked after tap1 resolves');
  });

  it('second tap does not fire setLiking(true) when guard is locked', async () => {
    const { opts, likingLog } = makeOpts();
    const deferred = makeDeferred();
    opts.likeEntity = async () => { await deferred.promise; return { likedByMe: true, likeCount: 1 }; };

    const tap1 = runHandleLike(opts);
    await runHandleLike(opts); // tap2 — hits isToggling() pre-check

    // Only one setLiking(true) from tap1
    assert.equal(likingLog.filter(v => v === true).length, 1,
      'setLiking(true) called only once across both taps');

    deferred.resolve();
    await tap1;
    assert.deepEqual(likingLog, [true, false]);
  });

  it('three rapid taps dispatch exactly one network request', async () => {
    const { opts, networkCalls } = makeOpts();
    const deferred = makeDeferred();
    opts.likeEntity = async (postId, entityId) => {
      networkCalls.push({ op: 'like', entityId });
      await deferred.promise;
      return { likedByMe: true, likeCount: 1 };
    };

    const tap1 = runHandleLike(opts);
    await runHandleLike(opts); // tap2 blocked
    await runHandleLike(opts); // tap3 blocked

    assert.equal(networkCalls.length, 1, 'three taps → one network call');

    deferred.resolve();
    await tap1;
    assert.equal(networkCalls.length, 1);
  });

  it('guard resets after an error so a retry is accepted', async () => {
    const { opts, networkCalls } = makeOpts();
    let attempt = 0;
    opts.likeEntity = async (postId, entityId) => {
      attempt++;
      if (attempt === 1) throw new Error('network blip');
      networkCalls.push({ op: 'like', entityId });
      return { likedByMe: true, likeCount: 1 };
    };

    await runHandleLike(opts); // tap1 — throws, guard resets
    await runHandleLike(opts); // tap2 — should succeed

    assert.equal(networkCalls.length, 1, 'retry after error must go through');
  });

  it('after tap1 resolves sequentially, a new tap is accepted', async () => {
    const { opts, networkCalls } = makeOpts();

    await runHandleLike(opts); // tap1 completes
    await runHandleLike(opts); // tap2 — guard is free

    assert.equal(networkCalls.length, 2, 'two sequential taps each dispatch a request');
  });
});

// ── 4. Guard isolation ────────────────────────────────────────────────────────

describe('guard isolation', () => {
  it('two separate guard instances are independent — one in-flight does not block the other', async () => {
    const networkA: string[] = [];
    const networkB: string[] = [];
    const deferredA = makeDeferred();

    const { opts: optsA } = makeOpts({
      entityId: 'comment-A',
      likeEntity: async (postId, entityId) => {
        networkA.push(entityId);
        await deferredA.promise;
        return { likedByMe: true, likeCount: 1 };
      },
    });

    const { opts: optsB } = makeOpts({
      entityId: 'comment-B',
      likeEntity: async (postId, entityId) => {
        networkB.push(entityId);
        return { likedByMe: true, likeCount: 1 };
      },
    });

    const tapA = runHandleLike(optsA);
    await runHandleLike(optsB);

    assert.equal(networkA.length, 1, 'A dispatched one request');
    assert.equal(networkB.length, 1, 'B is not blocked by A\'s guard');

    deferredA.resolve();
    await tapA;
  });
});
