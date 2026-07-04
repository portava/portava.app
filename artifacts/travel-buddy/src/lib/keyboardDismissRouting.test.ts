/**
 * Keyboard-dismiss routing tests — node:test + node:assert only (no RNTL).
 *
 * Verifies that the outer-Pressable keyboard-dismiss pattern in CommentsSection
 * correctly separates empty-area taps (→ dismiss) from inner-button taps
 * (→ action, NOT dismiss).
 *
 * Run:
 *   node --import tsx/esm --test src/lib/keyboardDismissRouting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommentAreaHandlers,
  routeCommentAreaPress,
} from './keyboardDismissRouting.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTrackers() {
  const calls = {
    dismiss: 0,
    like: 0,
    reply: 0,
    send: 0,
    mention: 0,
    hashtag: 0,
  };
  const mentionArgs: string[] = [];
  const hashtagArgs: string[] = [];
  const deps = {
    dismiss: () => { calls.dismiss++; },
    like:    () => { calls.like++; },
    reply:   () => { calls.reply++; },
    send:    () => { calls.send++; },
    mention: (handle: string) => { calls.mention++; mentionArgs.push(handle); },
    hashtag: (slug: string)   => { calls.hashtag++; hashtagArgs.push(slug); },
  };
  return { calls, mentionArgs, hashtagArgs, deps };
}

// ── 1. Empty-area tap ─────────────────────────────────────────────────────────

test('1. empty-area tap calls Keyboard.dismiss', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer', handlers);

  assert.equal(calls.dismiss, 1, 'dismiss should be called once');
});

test('2. empty-area tap does NOT call like action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer', handlers);

  assert.equal(calls.like, 0, 'like should not be called');
});

test('3. empty-area tap does NOT call reply action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer', handlers);

  assert.equal(calls.reply, 0, 'reply should not be called');
});

test('4. empty-area tap does NOT call send action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer', handlers);

  assert.equal(calls.send, 0, 'send should not be called');
});

// ── 2. Like button tap ────────────────────────────────────────────────────────

test('5. like button tap calls like action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('like', handlers);

  assert.equal(calls.like, 1, 'like should be called once');
});

test('6. like button tap does NOT call Keyboard.dismiss', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('like', handlers);

  assert.equal(calls.dismiss, 0, 'dismiss should not be called on like tap');
});

test('7. like button tap does NOT call reply or send', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('like', handlers);

  assert.equal(calls.reply, 0);
  assert.equal(calls.send, 0);
});

// ── 3. Reply button tap ───────────────────────────────────────────────────────

test('8. reply button tap calls reply action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('reply', handlers);

  assert.equal(calls.reply, 1, 'reply should be called once');
});

test('9. reply button tap does NOT call Keyboard.dismiss', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('reply', handlers);

  assert.equal(calls.dismiss, 0, 'dismiss should not be called on reply tap');
});

test('10. reply button tap does NOT call like or send', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('reply', handlers);

  assert.equal(calls.like, 0);
  assert.equal(calls.send, 0);
});

// ── 4. Send button tap ────────────────────────────────────────────────────────

test('11. send button tap calls send action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('send', handlers);

  assert.equal(calls.send, 1, 'send should be called once');
});

test('12. send button tap does NOT call Keyboard.dismiss', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('send', handlers);

  assert.equal(calls.dismiss, 0, 'dismiss should not be called on send tap');
});

test('13. send button tap does NOT call like or reply', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('send', handlers);

  assert.equal(calls.like, 0);
  assert.equal(calls.reply, 0);
});

// ── 5. Handler isolation (multiple taps) ─────────────────────────────────────

test('14. each handler fires exactly once per routeCommentAreaPress call', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer', handlers);
  routeCommentAreaPress('like', handlers);
  routeCommentAreaPress('reply', handlers);
  routeCommentAreaPress('send', handlers);

  assert.equal(calls.dismiss, 1, 'dismiss called exactly once (outer tap)');
  assert.equal(calls.like, 1, 'like called exactly once');
  assert.equal(calls.reply, 1, 'reply called exactly once');
  assert.equal(calls.send, 1, 'send called exactly once');
});

test('15. repeated outer taps accumulate dismiss calls, never inner action calls', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer', handlers);
  routeCommentAreaPress('outer', handlers);
  routeCommentAreaPress('outer', handlers);

  assert.equal(calls.dismiss, 3);
  assert.equal(calls.like, 0);
  assert.equal(calls.reply, 0);
  assert.equal(calls.send, 0);
});

// ── 6. Handler identity — each button gets its own closure ───────────────────

test('16. like and reply handlers are distinct function references', () => {
  const { deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  assert.notEqual(
    handlers.onLikePress,
    handlers.onReplyPress,
    'like and reply must be separate handlers',
  );
});

test('17. outer dismiss handler and inner handlers are distinct function references', () => {
  const { deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  assert.notEqual(handlers.onOuterPress, handlers.onLikePress);
  assert.notEqual(handlers.onOuterPress, handlers.onReplyPress);
  assert.notEqual(handlers.onOuterPress, handlers.onSendPress);
});

// ── 7. Mention tap — does NOT dismiss keyboard ────────────────────────────────

test('18. mention tap calls mention action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('mention', handlers, 'alice');

  assert.equal(calls.mention, 1, 'mention should be called once');
});

test('19. mention tap does NOT call Keyboard.dismiss', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('mention', handlers, 'alice');

  assert.equal(calls.dismiss, 0, 'dismiss must not fire when a mention is tapped');
});

test('20. mention tap does NOT call like, reply, or send', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('mention', handlers, 'alice');

  assert.equal(calls.like,   0, 'like must not fire on mention tap');
  assert.equal(calls.reply,  0, 'reply must not fire on mention tap');
  assert.equal(calls.send,   0, 'send must not fire on mention tap');
});

test('21. mention tap forwards the handle string to the handler', () => {
  const { mentionArgs, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('mention', handlers, 'bob');

  assert.deepEqual(mentionArgs, ['bob'], 'handle must be forwarded unchanged');
});

// ── 8. Hashtag tap — does NOT dismiss keyboard ────────────────────────────────

test('22. hashtag tap calls hashtag action', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('hashtag', handlers, 'wanderlust');

  assert.equal(calls.hashtag, 1, 'hashtag should be called once');
});

test('23. hashtag tap does NOT call Keyboard.dismiss', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('hashtag', handlers, 'wanderlust');

  assert.equal(calls.dismiss, 0, 'dismiss must not fire when a hashtag is tapped');
});

test('24. hashtag tap does NOT call like, reply, or send', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('hashtag', handlers, 'wanderlust');

  assert.equal(calls.like,   0, 'like must not fire on hashtag tap');
  assert.equal(calls.reply,  0, 'reply must not fire on hashtag tap');
  assert.equal(calls.send,   0, 'send must not fire on hashtag tap');
});

test('25. hashtag tap forwards the slug string to the handler', () => {
  const { hashtagArgs, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('hashtag', handlers, 'travel');

  assert.deepEqual(hashtagArgs, ['travel'], 'slug must be forwarded unchanged');
});

// ── 9. Mention / hashtag handler identity ─────────────────────────────────────

test('26. mention handler is a distinct closure from the outer dismiss handler', () => {
  const { deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  assert.notEqual(
    handlers.onMentionPress,
    handlers.onOuterPress,
    'onMentionPress must not be the same function as onOuterPress',
  );
});

test('27. hashtag handler is a distinct closure from the outer dismiss handler', () => {
  const { deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  assert.notEqual(
    handlers.onHashtagPress,
    handlers.onOuterPress,
    'onHashtagPress must not be the same function as onOuterPress',
  );
});

test('28. mention and hashtag handlers are distinct closures from each other', () => {
  const { deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  assert.notEqual(
    handlers.onMentionPress,
    handlers.onHashtagPress,
    'mention and hashtag handlers must be separate closures',
  );
});

// ── 10. Mixed-tap sequence — mention/hashtag never accumulate dismiss ─────────

test('29. outer then mention: dismiss fires once, mention fires once, no cross-firing', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('outer',   handlers);
  routeCommentAreaPress('mention', handlers, 'carol');

  assert.equal(calls.dismiss, 1, 'dismiss fires once for the outer tap');
  assert.equal(calls.mention, 1, 'mention fires once for the mention tap');
  assert.equal(calls.like,   0);
  assert.equal(calls.reply,  0);
  assert.equal(calls.send,   0);
  assert.equal(calls.hashtag, 0);
});

test('30. mention then hashtag: each fires once, dismiss never fires', () => {
  const { calls, deps } = makeTrackers();
  const handlers = buildCommentAreaHandlers(deps);

  routeCommentAreaPress('mention', handlers, 'dave');
  routeCommentAreaPress('hashtag', handlers, 'adventure');

  assert.equal(calls.mention, 1);
  assert.equal(calls.hashtag, 1);
  assert.equal(calls.dismiss, 0, 'dismiss must never fire for inner rich-text taps');
});
