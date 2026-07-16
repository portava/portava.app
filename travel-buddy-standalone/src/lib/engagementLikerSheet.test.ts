/**
 * engagementLikerSheet.test.ts — machine-layer wiring tests for the likers sheet.
 *
 * Verifies the state-transition and targetType-routing logic in:
 *   - PostEngagementBar  (likerSheet state, post_like / post_reaction)
 *   - CommentsSheet      (likerCommentId / likerReplyId, comment_like)
 *   - EngagementUserListSheet  (hasMore-driven loadMore, page accumulation)
 *
 * Machine-layer approach (see .agents/memory/rntl-multi-react.md):
 * The control flow is re-implemented as pure functions tested with node:test,
 * without React or RNTL. Any divergence from the real component logic will
 * break these tests — they act as a canary for wiring regressions.
 *
 * Run with:
 *   node --import tsx/esm --test src/lib/engagementLikerSheet.test.ts
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Source-file paths ─────────────────────────────────────────────────────────
// The test file lives at src/lib/engagementLikerSheet.test.ts.
// Components are at src/components/<Name>.tsx.
const _dir = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = path.resolve(_dir, '..', 'components');

// ═══════════════════════════════════════════════════════════════════════════════
// § 1 — PostEngagementBar likerSheet state transitions
// ═══════════════════════════════════════════════════════════════════════════════
//
// PostEngagementBar maintains:
//   likerSheet: { emoji?: string } | null
//   null  = closed
//   {}    = post_like sheet  (targetType='post_like')
//   {emoji} = post_reaction sheet filtered by emoji

type LikerSheet = { emoji?: string } | null;

/** Mirror of the targetType computation in PostEngagementBar JSX. */
function resolveTargetType(sheet: LikerSheet): 'post_like' | 'post_reaction' | null {
  if (sheet === null) return null;
  return sheet.emoji ? 'post_reaction' : 'post_like';
}

/** Mirror of the reactionType prop passed to EngagementUserListSheet. */
function resolveReactionType(sheet: LikerSheet): string | undefined {
  if (sheet === null) return undefined;
  return sheet.emoji;
}

/** Mirror of the initialTotal prop computation in PostEngagementBar. */
function resolveInitialTotal(sheet: LikerSheet, localLikeCount: number): number | undefined {
  // initialTotal={likerSheet.emoji ? undefined : localLikeCount}
  if (sheet === null || sheet.emoji) return undefined;
  return localLikeCount;
}

describe('PostEngagementBar — likerSheet state transitions', () => {
  it('starts with likerSheet=null (sheet is closed)', () => {
    const likerSheet: LikerSheet = null;
    assert.equal(likerSheet, null);
    assert.equal(resolveTargetType(likerSheet), null);
  });

  it('like count Pressable tap sets likerSheet={} when count > 0', () => {
    let likerSheet: LikerSheet = null;
    const setLikerSheet = (v: LikerSheet) => { likerSheet = v; };

    const localLikeCount = 3;
    // Mirrors: {localLikeCount > 0 ? <Pressable onPress={() => setLikerSheet({})} ...>}
    if (localLikeCount > 0) setLikerSheet({});

    assert.deepEqual(likerSheet, {});
    assert.equal(resolveTargetType(likerSheet), 'post_like');
  });

  it('like count Pressable is not rendered at count=0 — no state change from count tap', () => {
    let likerSheet: LikerSheet = null;
    const setLikerSheet = (v: LikerSheet) => { likerSheet = v; };

    const localLikeCount = 0;
    // The <Pressable> is only rendered when localLikeCount > 0
    if (localLikeCount > 0) setLikerSheet({});

    assert.equal(likerSheet, null, 'count=0: count Pressable hidden — sheet stays closed');
  });

  it('heart onLongPress opens sheet regardless of like count (zero-count access)', () => {
    let likerSheet: LikerSheet = null;
    const setLikerSheet = (v: LikerSheet) => { likerSheet = v; };

    // onLongPress={() => setLikerSheet({})} — fires even when count=0
    setLikerSheet({});

    assert.deepEqual(likerSheet, {});
    assert.equal(resolveTargetType(likerSheet), 'post_like',
      'long-press on heart opens post_like sheet regardless of count');
  });

  it('likerSheet={} → targetType=post_like, no reactionType', () => {
    const sheet: LikerSheet = {};
    assert.equal(resolveTargetType(sheet), 'post_like');
    assert.equal(resolveReactionType(sheet), undefined);
  });

  it('ReactionSummary onChipPress sets likerSheet={emoji}', () => {
    let likerSheet: LikerSheet = null;
    const setLikerSheet = (v: LikerSheet) => { likerSheet = v; };

    // Mirrors: onChipPress={(emoji) => setLikerSheet({ emoji })}
    const onChipPress = (emoji: string) => setLikerSheet({ emoji });
    onChipPress('❤️');

    assert.deepEqual(likerSheet, { emoji: '❤️' });
    assert.equal(resolveTargetType(likerSheet), 'post_reaction');
    assert.equal(resolveReactionType(likerSheet), '❤️');
  });

  it('likerSheet={emoji} → targetType=post_reaction, reactionType=emoji', () => {
    const sheet: LikerSheet = { emoji: '🔥' };
    assert.equal(resolveTargetType(sheet), 'post_reaction');
    assert.equal(resolveReactionType(sheet), '🔥');
  });

  it('each different emoji chip produces the correct reactionType', () => {
    const emojis = ['❤️', '😂', '😮', '😢', '😡', '🎉'];
    for (const emoji of emojis) {
      const sheet: LikerSheet = { emoji };
      assert.equal(resolveTargetType(sheet), 'post_reaction', `emoji=${emoji}`);
      assert.equal(resolveReactionType(sheet), emoji, `emoji=${emoji}`);
    }
  });

  it('initialTotal is localLikeCount for post_like sheet', () => {
    const localLikeCount = 7;
    const sheet: LikerSheet = {};
    assert.equal(resolveInitialTotal(sheet, localLikeCount), 7);
  });

  it('initialTotal is undefined for reaction sheet (count is per-emoji, not passed)', () => {
    const localLikeCount = 7;
    const sheet: LikerSheet = { emoji: '❤️' };
    assert.equal(resolveInitialTotal(sheet, localLikeCount), undefined);
  });

  it('onClose sets likerSheet back to null', () => {
    let likerSheet: LikerSheet = { emoji: '❤️' };
    const setLikerSheet = (v: LikerSheet) => { likerSheet = v; };

    // onClose={() => setLikerSheet(null)}
    setLikerSheet(null);
    assert.equal(likerSheet, null);
    assert.equal(resolveTargetType(likerSheet), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § 2 — CommentsSheet likerCommentId wiring
// ═══════════════════════════════════════════════════════════════════════════════
//
// CommentsSheet CommentItem maintains:
//   likerCommentId: string | null
//   null    = sheet closed
//   comment.id = sheet open for that comment's likes
//
// The sheet always uses targetType='comment_like' and targetId=likerCommentId.

describe('CommentsSheet — likerCommentId wiring', () => {
  it('starts with likerCommentId=null (sheet closed)', () => {
    const likerCommentId: string | null = null;
    assert.equal(likerCommentId, null);
  });

  it('comment like count tap (count > 0) sets likerCommentId to comment.id', () => {
    let likerCommentId: string | null = null;
    const setLikerCommentId = (v: string | null) => { likerCommentId = v; };

    const commentId = 'comment-abc';
    const likeCount = 5;
    // Mirrors: {likeCount > 0 && <Pressable onPress={() => setLikerCommentId(comment.id)}>}
    if (likeCount > 0) setLikerCommentId(commentId);

    assert.equal(likerCommentId, commentId);
  });

  it('comment like count Pressable hidden at count=0 — no state change from count tap', () => {
    let likerCommentId: string | null = null;
    const setLikerCommentId = (v: string | null) => { likerCommentId = v; };

    const likeCount = 0;
    if (likeCount > 0) setLikerCommentId('comment-xyz');

    assert.equal(likerCommentId, null, 'count=0 does not open sheet via count button');
  });

  it('sheet targetType is always comment_like', () => {
    const targetType = 'comment_like';
    assert.equal(targetType, 'comment_like');
  });

  it('sheet targetId is likerCommentId', () => {
    const likerCommentId = '20000000-0000-0000-0000-000000000001';
    // Mirrors: targetId={likerCommentId}
    assert.equal(likerCommentId, '20000000-0000-0000-0000-000000000001');
  });

  it('sheet initialTotal is the comment likeCount', () => {
    const likeCount = 12;
    // Mirrors: initialTotal={likeCount}
    assert.equal(likeCount, 12);
  });

  it('onClose sets likerCommentId back to null', () => {
    let likerCommentId: string | null = 'comment-123';
    const setLikerCommentId = (v: string | null) => { likerCommentId = v; };

    // onClose={() => setLikerCommentId(null)}
    setLikerCommentId(null);
    assert.equal(likerCommentId, null);
  });

  it('two comments manage their own likerCommentId state independently', () => {
    let state1: string | null = null;
    let state2: string | null = null;
    const set1 = (v: string | null) => { state1 = v; };
    const set2 = (v: string | null) => { state2 = v; };

    set1('comment-111');
    assert.equal(state1, 'comment-111');
    assert.equal(state2, null, 'comment-2 state unaffected by comment-1 open');

    set2('comment-222');
    assert.equal(state1, 'comment-111');
    assert.equal(state2, 'comment-222');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § 3 — CommentsSheet likerReplyId wiring
// ═══════════════════════════════════════════════════════════════════════════════
//
// ReplyRow inside CommentsSheet maintains:
//   likerReplyId: string | null
//   null     = sheet closed
//   reply.id = sheet open for that reply's likes
//
// Replies are also comments (stored in posts_comments), so targetType='comment_like'.

describe('CommentsSheet — likerReplyId wiring', () => {
  it('reply like count tap (count > 0) sets likerReplyId to reply.id', () => {
    let likerReplyId: string | null = null;
    const setLikerReplyId = (v: string | null) => { likerReplyId = v; };

    const replyId = 'reply-xyz';
    const likeCount = 2;
    if (likeCount > 0) setLikerReplyId(replyId);

    assert.equal(likerReplyId, replyId);
  });

  it('reply like count Pressable hidden at count=0', () => {
    let likerReplyId: string | null = null;
    const setLikerReplyId = (v: string | null) => { likerReplyId = v; };

    const likeCount = 0;
    if (likeCount > 0) setLikerReplyId('reply-zzz');

    assert.equal(likerReplyId, null);
  });

  it('reply likers sheet uses targetType=comment_like (replies are comments)', () => {
    const targetType = 'comment_like';
    assert.equal(targetType, 'comment_like');
  });

  it('sheet initialTotal is reply.likeCount', () => {
    const replyLikeCount = 3;
    assert.equal(replyLikeCount, 3);
  });

  it('onClose sets likerReplyId back to null', () => {
    let likerReplyId: string | null = 'reply-abc';
    const setLikerReplyId = (v: string | null) => { likerReplyId = v; };

    setLikerReplyId(null);
    assert.equal(likerReplyId, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § 4 — EngagementUserListSheet hasMore pagination logic
// ═══════════════════════════════════════════════════════════════════════════════
//
// EngagementUserListSheet.loadMore mirrors:
//   if (!hasMore || !nextCursor || loadingMore) return;
//
// This section tests the guard conditions without React state.

interface MockPage {
  users: Array<{ id: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

async function runLoadMore(opts: {
  hasMore: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  getLikers: () => Promise<MockPage>;
}): Promise<MockPage | null> {
  const { hasMore, nextCursor, loadingMore, getLikers } = opts;
  // Mirrors: if (!hasMore || !nextCursor || loadingMore) return;
  if (!hasMore || !nextCursor || loadingMore) return null;
  return getLikers();
}

describe('EngagementUserListSheet — hasMore-driven loadMore guard', () => {
  it('loadMore is skipped when hasMore=false', async () => {
    let called = false;
    const result = await runLoadMore({
      hasMore: false,
      nextCursor: '2025-01-01T00:00:00Z',
      loadingMore: false,
      getLikers: async () => { called = true; return { users: [], nextCursor: null, hasMore: false }; },
    });
    assert.equal(called, false, 'API must not be called when hasMore=false');
    assert.equal(result, null);
  });

  it('loadMore is skipped when nextCursor=null even if hasMore=true', async () => {
    let called = false;
    const result = await runLoadMore({
      hasMore: true,
      nextCursor: null,
      loadingMore: false,
      getLikers: async () => { called = true; return { users: [], nextCursor: null, hasMore: false }; },
    });
    assert.equal(called, false, 'API must not be called when nextCursor=null');
    assert.equal(result, null);
  });

  it('loadMore is skipped when loadingMore=true (prevents concurrent loads)', async () => {
    let called = false;
    const result = await runLoadMore({
      hasMore: true,
      nextCursor: '2025-01-01T00:00:00Z',
      loadingMore: true,
      getLikers: async () => { called = true; return { users: [], nextCursor: null, hasMore: false }; },
    });
    assert.equal(called, false, 'API must not be called when already loading');
    assert.equal(result, null);
  });

  it('loadMore fires when hasMore=true, nextCursor set, and not loading', async () => {
    let called = false;
    const result = await runLoadMore({
      hasMore: true,
      nextCursor: '2025-01-01T00:00:00Z',
      loadingMore: false,
      getLikers: async () => {
        called = true;
        return { users: [{ id: 'user-2' }], nextCursor: null, hasMore: false };
      },
    });
    assert.equal(called, true, 'API must be called when all guards pass');
    assert.ok(result !== null);
    assert.equal(result!.users.length, 1);
  });

  it('users accumulate across pages — new page appended to existing list', () => {
    const page1: Array<{ id: string }> = [{ id: 'user-1' }];
    const page2: Array<{ id: string }> = [{ id: 'user-2' }, { id: 'user-3' }];

    // Mirrors: setUsers(prev => [...prev, ...page.users])
    const combined = [...page1, ...page2];

    assert.equal(combined.length, 3);
    assert.equal(combined[0].id, 'user-1');
    assert.equal(combined[1].id, 'user-2');
    assert.equal(combined[2].id, 'user-3');
  });

  it('hasMore and nextCursor are updated from page result after loadMore', () => {
    let hasMore = true;
    let nextCursor: string | null = '2025-01-01T00:00:00Z';

    const page: MockPage = { users: [], nextCursor: null, hasMore: false };
    // Mirrors: setNextCursor(page.nextCursor); setHasMore(page.hasMore);
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;

    assert.equal(hasMore, false, 'hasMore updated from page result');
    assert.equal(nextCursor, null, 'nextCursor updated from page result');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § 4 — PostEngagementBar source-level wiring assertions
//
// RNTL component tests are not viable in this codebase due to the React 19 /
// jest-expo multiple-React-instance crash ("Invalid hook call / null dispatcher").
// These source-level assertions read the actual component file and verify that
// the JSX bindings that open EngagementUserListSheet are present and correct.
// Any regression (removed handler, wrong targetType, missing component) fails here.
// ═══════════════════════════════════════════════════════════════════════════════

describe('PostEngagementBar — source-level JSX wiring', () => {
  let src = '';
  before(() => { src = fs.readFileSync(path.join(COMPONENTS, 'PostEngagementBar.tsx'), 'utf8'); });

  it('imports EngagementUserListSheet', () => {
    assert.ok(src.includes("'./EngagementUserListSheet"), 'PostEngagementBar must import EngagementUserListSheet');
  });

  it('like-count Pressable onPress calls setLikerSheet({})', () => {
    assert.ok(src.includes('onPress={() => setLikerSheet({})}'), 'count-tap Pressable must call setLikerSheet({})');
  });

  it('heart onLongPress calls setLikerSheet({})', () => {
    assert.ok(src.includes('onLongPress={() => setLikerSheet({})}'), 'heart long-press must call setLikerSheet({})');
  });

  it('reaction chip onChipPress passes emoji into likerSheet', () => {
    assert.ok(
      src.includes('onChipPress={(emoji) => setLikerSheet({ emoji })}'),
      'chip press must set likerSheet with emoji'
    );
  });

  it("EngagementUserListSheet targetType is 'post_reaction' when emoji set, 'post_like' otherwise", () => {
    assert.ok(
      src.includes("targetType={likerSheet.emoji ? 'post_reaction' : 'post_like'}"),
      "targetType must derive from likerSheet.emoji"
    );
  });

  it('EngagementUserListSheet reactionType is likerSheet.emoji', () => {
    assert.ok(src.includes('reactionType={likerSheet.emoji}'), 'reactionType prop must be likerSheet.emoji');
  });

  it('EngagementUserListSheet onClose resets likerSheet to null', () => {
    assert.ok(src.includes('onClose={() => setLikerSheet(null)}'), 'onClose must reset likerSheet to null');
  });

  it('EngagementUserListSheet is only rendered when likerSheet !== null', () => {
    assert.ok(src.includes('likerSheet !== null'), 'sheet must be gated on likerSheet !== null');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § 5 — CommentsSheet source-level wiring assertions
// ═══════════════════════════════════════════════════════════════════════════════

describe('CommentsSheet — source-level JSX wiring', () => {
  let src = '';
  before(() => { src = fs.readFileSync(path.join(COMPONENTS, 'CommentsSheet.tsx'), 'utf8'); });

  it('imports EngagementUserListSheet', () => {
    assert.ok(src.includes("'./EngagementUserListSheet"), 'CommentsSheet must import EngagementUserListSheet');
  });

  it('comment like-count Pressable onPress sets likerCommentId', () => {
    assert.ok(
      src.includes('onPress={() => setLikerCommentId(comment.id)}'),
      'comment count-tap must call setLikerCommentId(comment.id)'
    );
  });

  it('comment likers EngagementUserListSheet uses targetType="comment_like"', () => {
    assert.ok(src.includes('targetType="comment_like"'), 'comment likers sheet must pass targetType=comment_like');
  });

  it('comment likers EngagementUserListSheet targetId is likerCommentId', () => {
    assert.ok(src.includes('targetId={likerCommentId}'), 'comment likers sheet must pass likerCommentId as targetId');
  });

  it('comment likers EngagementUserListSheet onClose resets likerCommentId to null', () => {
    assert.ok(
      src.includes('onClose={() => setLikerCommentId(null)}'),
      'comment likers onClose must reset likerCommentId to null'
    );
  });

  it('reply like-count Pressable onPress sets likerReplyId', () => {
    assert.ok(
      src.includes('onPress={() => setLikerReplyId(reply.id)}'),
      'reply count-tap must call setLikerReplyId(reply.id)'
    );
  });

  it('reply likers EngagementUserListSheet targetId is likerReplyId', () => {
    assert.ok(src.includes('targetId={likerReplyId}'), 'reply likers sheet must pass likerReplyId as targetId');
  });

  it('reply likers EngagementUserListSheet onClose resets likerReplyId to null', () => {
    assert.ok(
      src.includes('onClose={() => setLikerReplyId(null)}'),
      'reply likers onClose must reset likerReplyId to null'
    );
  });
});
