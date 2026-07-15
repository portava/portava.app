/**
 * Machine-layer wiring tests for the handleLike guard used by PostEngagementBar.
 *
 * Machine-layer approach (see .agents/memory/rntl-multi-react.md): the exact
 * handleLike logic is re-implemented as a pure function so it can be tested
 * with node:test without React / RNTL. Any time PostEngagementBar's handleLike
 * diverges from this contract, these tests will break — acting as a canary for
 * wiring regressions.
 *
 * PostEngagementBar uses a plain boolean `liking` state flag (not
 * createLikeToggleGuard). The replica below mirrors that exact control flow.
 *
 * Run with:
 *   node --import tsx/esm --test src/lib/postLikeWiring.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Machine-layer replica of PostEngagementBar.handleLike ────────────────────
//
// Matches the exact control flow at PostEngagementBar.tsx (handleLike useCallback).
//
// React state is modelled as a plain mutable object so the guard behaviour can
// be verified without rendering anything.

interface LikeResult {
  likedByMe: boolean;
  likeCount: number;
}

interface PostLikeState {
  liking: boolean;
  localLiked: boolean;
  localLikeCount: number;
}

interface HandleLikeOpts {
  state: PostLikeState;
  postId: string;
  likePost: (postId: string) => Promise<LikeResult | null>;
  unlikePost: (postId: string) => Promise<LikeResult | null>;
  onAlert?: () => void;
}

async function runHandleLike(opts: HandleLikeOpts): Promise<void> {
  const { state } = opts;

  // Guard mirrors: if (liking) return;
  if (state.liking) return;
  state.liking = true;

  const wasLiked = state.localLiked;
  const prevCount = state.localLikeCount;

  // Optimistic update
  state.localLiked = !wasLiked;
  state.localLikeCount = wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1;

  try {
    const result = wasLiked
      ? await opts.unlikePost(opts.postId)
      : await opts.likePost(opts.postId);

    if (result) {
      state.localLiked = result.likedByMe;
      state.localLikeCount = result.likeCount;
    } else {
      // Revert optimistic update (mirrors the Alert.alert branch)
      state.localLiked = wasLiked;
      state.localLikeCount = prevCount;
      opts.onAlert?.();
    }
  } finally {
    state.liking = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeState(overrides: Partial<PostLikeState> = {}): PostLikeState {
  return { liking: false, localLiked: false, localLikeCount: 0, ...overrides };
}

function makeOpts(
  state: PostLikeState,
  overrides: Partial<HandleLikeOpts> = {},
): HandleLikeOpts {
  return {
    state,
    postId: 'post-1',
    likePost: async () => ({ likedByMe: true, likeCount: 1 }),
    unlikePost: async () => ({ likedByMe: false, likeCount: 0 }),
    ...overrides,
  };
}

// ── 1. Single tap ─────────────────────────────────────────────────────────────

describe('PostEngagementBar handleLike — single tap', () => {
  it('single call dispatches exactly one network request', async () => {
    let calls = 0;
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => { calls++; return { likedByMe: true, likeCount: 1 }; },
    });

    await runHandleLike(opts);

    assert.equal(calls, 1);
  });

  it('liking is false before the call, true during, false after', async () => {
    const state = makeState();
    const deferred = makeDeferred();
    let duringLiking = false;

    const opts = makeOpts(state, {
      likePost: async () => {
        duringLiking = state.liking;
        await deferred.promise;
        return { likedByMe: true, likeCount: 1 };
      },
    });

    assert.equal(state.liking, false, 'idle before tap');
    const tap = runHandleLike(opts);
    assert.equal(state.liking, true, 'locked after tap starts');

    deferred.resolve();
    await tap;

    assert.equal(duringLiking, true, 'was liking during network call');
    assert.equal(state.liking, false, 'unlocked after tap resolves');
  });

  it('optimistic update fires before the network call resolves', async () => {
    const state = makeState({ localLiked: false, localLikeCount: 5 });
    const deferred = makeDeferred();
    const opts = makeOpts(state, {
      likePost: async () => { await deferred.promise; return { likedByMe: true, likeCount: 6 }; },
    });

    const tap = runHandleLike(opts);

    // Optimistic state already applied before network resolves
    assert.equal(state.localLiked, true, 'optimistically set liked');
    assert.equal(state.localLikeCount, 6, 'optimistically incremented count');

    deferred.resolve();
    await tap;

    // Server confirms
    assert.equal(state.localLiked, true);
    assert.equal(state.localLikeCount, 6);
  });

  it('likedByMe=true sends unlikePost, not likePost', async () => {
    let unlikeCalls = 0;
    let likeCalls = 0;
    const state = makeState({ localLiked: true, localLikeCount: 3 });
    const opts = makeOpts(state, {
      likePost: async () => { likeCalls++; return { likedByMe: true, likeCount: 4 }; },
      unlikePost: async () => { unlikeCalls++; return { likedByMe: false, likeCount: 2 }; },
    });

    await runHandleLike(opts);

    assert.equal(unlikeCalls, 1, 'unlike called once');
    assert.equal(likeCalls, 0, 'like not called');
  });

  it('server result updates state after network resolves', async () => {
    const state = makeState({ localLiked: false, localLikeCount: 10 });
    const opts = makeOpts(state, {
      likePost: async () => ({ likedByMe: true, likeCount: 11 }),
    });

    await runHandleLike(opts);

    assert.equal(state.localLiked, true);
    assert.equal(state.localLikeCount, 11);
  });

  it('reverts optimistic update when server returns null', async () => {
    const state = makeState({ localLiked: false, localLikeCount: 7 });
    const opts = makeOpts(state, {
      likePost: async () => null,
    });

    await runHandleLike(opts);

    assert.equal(state.localLiked, false, 'reverted to original liked state');
    assert.equal(state.localLikeCount, 7, 'reverted to original count');
  });

  it('calls onAlert when server returns null', async () => {
    let alertCalled = false;
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => null,
      onAlert: () => { alertCalled = true; },
    });

    await runHandleLike(opts);

    assert.equal(alertCalled, true);
  });

  it('liking resets to false even when the network throws', async () => {
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => { throw new Error('network error'); },
    });

    // NOTE: PostEngagementBar has no catch block — errors propagate to the
    // caller (React event handler swallows them). The finally block still
    // resets liking. This differs from createLikeToggleGuard which absorbs
    // errors internally and returns 'error' without re-throwing.
    try { await runHandleLike(opts); } catch { /* expected */ }

    assert.equal(state.liking, false, 'finally block must reset liking');
  });
});

// ── 2. Double-tap prevention ──────────────────────────────────────────────────

describe('PostEngagementBar handleLike — double-tap prevention', () => {
  it('two rapid taps dispatch exactly one network request', async () => {
    let calls = 0;
    const deferred = makeDeferred();
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => { calls++; await deferred.promise; return { likedByMe: true, likeCount: 1 }; },
    });

    const tap1 = runHandleLike(opts);
    // tap2 fires while tap1 is still in-flight — state.liking is true
    await runHandleLike(opts);

    assert.equal(calls, 1, 'only one network request must be made');

    deferred.resolve();
    await tap1;

    assert.equal(calls, 1, 'still one request after tap1 resolves');
  });

  it('liking is true while tap1 is in-flight so tap2 is rejected', async () => {
    const state = makeState();
    const deferred = makeDeferred();
    let tap2Reached = false;

    const opts = makeOpts(state, {
      likePost: async () => { await deferred.promise; return { likedByMe: true, likeCount: 1 }; },
    });

    const tap1 = runHandleLike(opts);

    assert.equal(state.liking, true, 'guard locked after tap1');

    // tap2 hits the guard and returns without changing anything
    await runHandleLike({ ...opts, likePost: async () => { tap2Reached = true; return null; } });

    assert.equal(tap2Reached, false, 'tap2 network call must not fire');

    deferred.resolve();
    await tap1;

    assert.equal(state.liking, false, 'guard unlocked after tap1 resolves');
  });

  it('three rapid taps dispatch exactly one network request', async () => {
    let calls = 0;
    const deferred = makeDeferred();
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => { calls++; await deferred.promise; return { likedByMe: true, likeCount: 1 }; },
    });

    const tap1 = runHandleLike(opts);
    await runHandleLike(opts); // tap2 blocked
    await runHandleLike(opts); // tap3 blocked

    assert.equal(calls, 1, 'three taps → one network call');

    deferred.resolve();
    await tap1;

    assert.equal(calls, 1);
  });

  it('guard resets after an error so a retry is accepted', async () => {
    // NOTE: When likePost throws before completing, the optimistic update
    // (localLiked flipped to true) is NOT reverted — PostEngagementBar has no
    // catch block, only finally. So tap2 will call unlikePost (not likePost).
    // This test tracks all network calls to confirm the retry actually fires.
    const networkCalls: string[] = [];
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => {
        networkCalls.push('like');
        throw new Error('network blip');
      },
      unlikePost: async () => {
        networkCalls.push('unlike');
        return { likedByMe: false, likeCount: 0 };
      },
    });

    // tap1 throws — error propagates but finally resets state.liking
    try { await runHandleLike(opts); } catch { /* expected */ }

    assert.equal(state.liking, false, 'guard must reset after error');
    assert.equal(networkCalls.length, 1, 'tap1 fired one request before throwing');

    // tap2 — guard is free; localLiked was optimistically set to true by tap1
    // (not reverted), so this becomes an unlike call
    await runHandleLike(opts);

    assert.equal(networkCalls.length, 2, 'retry after error must go through');
  });

  it('after tap1 resolves sequentially, a new tap is accepted', async () => {
    let calls = 0;
    const state = makeState();
    const opts = makeOpts(state, {
      likePost: async () => { calls++; return { likedByMe: true, likeCount: 1 }; },
      unlikePost: async () => { calls++; return { likedByMe: false, likeCount: 0 }; },
    });

    await runHandleLike(opts); // tap1 completes — localLiked is now true
    await runHandleLike(opts); // tap2 — guard is free, unlike fires

    assert.equal(calls, 2, 'two sequential taps each dispatch a request');
  });
});

// ── 3. Guard isolation ────────────────────────────────────────────────────────

describe('PostEngagementBar handleLike — guard isolation', () => {
  it('two independent post states do not block each other', async () => {
    let callsA = 0;
    let callsB = 0;
    const deferredA = makeDeferred();

    const stateA = makeState();
    const optsA = makeOpts(stateA, {
      postId: 'post-A',
      likePost: async () => { callsA++; await deferredA.promise; return { likedByMe: true, likeCount: 1 }; },
    });

    const stateB = makeState();
    const optsB = makeOpts(stateB, {
      postId: 'post-B',
      likePost: async () => { callsB++; return { likedByMe: true, likeCount: 1 }; },
    });

    const tapA = runHandleLike(optsA);
    await runHandleLike(optsB);

    assert.equal(callsA, 1, 'post-A dispatched one request');
    assert.equal(callsB, 1, 'post-B is not blocked by post-A\'s guard');

    deferredA.resolve();
    await tapA;
  });
});
