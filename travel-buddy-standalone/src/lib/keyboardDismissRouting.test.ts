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
  };
  const deps = {
    dismiss: () => { calls.dismiss++; },
    like: () => { calls.like++; },
    reply: () => { calls.reply++; },
    send: () => { calls.send++; },
  };
  return { calls, deps };
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
