/**
 * compactPlaybackStore — Telegraph §6.3, census-telegraph T62 (node:test).
 *
 * The session model under the compact player: what binds a session, what a
 * minimize/expand keeps, and every fail-closed stop (owner question Q-PB1's
 * default: the opening conversation only).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetCompactPlaybackForTests,
  expandPlayback,
  getCompactPlayback,
  isPlayableVideoMessage,
  isSourceBound,
  lastPlaybackStopReason,
  minimizePlayback,
  openMessageVideo,
  reconcilePlaybackContext,
  registerMessageSource,
  reportMessageSource,
  routeKeyOf,
  stopPlayback,
  stopReasonForBlocks,
  stopReasonForEvent,
  subscribeCompactPlayback,
  unregisterMessageSource,
  type PlaybackSourceMessage,
} from '../compactPlaybackStore.ts';

const REF = 'post-media/u-2/clip.mp4';
const VIDEO = (id: string, over: Partial<PlaybackSourceMessage> = {}): PlaybackSourceMessage => ({
  id, senderId: 'u-2', deleted: false, msgType: 'media', mediaType: 'video', mediaUrl: REF, ...over,
});
const TEXT = (id: string): PlaybackSourceMessage => ({ id, senderId: 'u-2', deleted: false, msgType: 'text', mediaUrl: null });

function threadWith(messages: PlaybackSourceMessage[], threadId = 't-1', live = true): number {
  const id = registerMessageSource();
  reportMessageSource(id, { threadId, live, messages });
  return id;
}

/** Open REF from a thread holding it, stamped in /messages/t-1 for me-1. */
function openInThread(messages: PlaybackSourceMessage[] = [TEXT('m-0'), VIDEO('m-1')]): { source: number; key: number } {
  const source = threadWith(messages);
  assert.equal(openMessageVideo({ mediaRef: REF, posterRef: 'post-media/u-2/clip.jpg' }), true);
  const s = getCompactPlayback();
  assert.ok(s);
  reconcilePlaybackContext(routeKeyOf('/messages/t-1', {}), 'me-1');
  return { source, key: s.key };
}

beforeEach(() => _resetCompactPlaybackForTests());

// ── Binding ─────────────────────────────────────────────────────────────────

test('opening binds to the thread that holds the video and starts full screen', () => {
  const { source } = openInThread();
  const s = getCompactPlayback();
  assert.ok(s);
  assert.equal(s.presentation, 'expanded');
  assert.equal(s.mediaRef, REF);
  assert.equal(s.posterRef, 'post-media/u-2/clip.jpg');
  assert.deepEqual(s.bindings, [{ sourceId: source, threadId: 't-1', messageIds: ['m-1'] }]);
  assert.deepEqual(s.senderIds, ['u-2']);
});

test('a video no open conversation holds is refused — nothing plays', () => {
  threadWith([TEXT('m-0')]);
  assert.equal(openMessageVideo({ mediaRef: REF }), false);
  assert.equal(getCompactPlayback(), null);
  assert.equal(openMessageVideo({ mediaRef: '' }), false);
  assert.equal(openMessageVideo({ mediaRef: null }), false);
});

test('a source that cannot vouch for its messages (not live) binds nothing', () => {
  threadWith([VIDEO('m-1')], 't-1', false);
  assert.equal(openMessageVideo({ mediaRef: REF }), false);
});

test('deleted, non-video and other-media messages never bind', () => {
  assert.equal(isPlayableVideoMessage(VIDEO('a', { deleted: true }), REF), false);
  assert.equal(isPlayableVideoMessage(VIDEO('a', { mediaType: 'image' }), REF), false);
  assert.equal(isPlayableVideoMessage(VIDEO('a', { msgType: 'text' }), REF), false);
  assert.equal(isPlayableVideoMessage(VIDEO('a', { mediaUrl: null }), REF), false);
  assert.equal(isPlayableVideoMessage(VIDEO('a', { mediaUrl: 'post-media/u-2/other.mp4' }), REF), false);
  assert.equal(isPlayableVideoMessage(VIDEO('a'), REF), true);
});

// ── One playback across presentations ───────────────────────────────────────

test('minimize and expand keep the SAME session (same key): nothing restarts', () => {
  const { key } = openInThread();
  minimizePlayback(key);
  assert.equal(getCompactPlayback()?.presentation, 'compact');
  assert.equal(getCompactPlayback()?.key, key);
  expandPlayback(key);
  assert.equal(getCompactPlayback()?.presentation, 'expanded');
  assert.equal(getCompactPlayback()?.key, key);
});

test('tapping the docked video\'s thumbnail again brings it back, it does not restart it', () => {
  const { key } = openInThread();
  minimizePlayback(key);
  assert.equal(openMessageVideo({ mediaRef: REF }), true);
  assert.equal(getCompactPlayback()?.key, key);
  assert.equal(getCompactPlayback()?.presentation, 'expanded');
});

test('a different video replaces the session (new key)', () => {
  const { key } = openInThread([VIDEO('m-1'), VIDEO('m-2', { mediaUrl: 'post-media/u-2/b.mp4' })]);
  assert.equal(openMessageVideo({ mediaRef: 'post-media/u-2/b.mp4' }), true);
  assert.notEqual(getCompactPlayback()?.key, key);
  assert.equal(lastPlaybackStopReason(), 'replaced');
});

test('a late callback from a replaced player cannot stop or move its successor', () => {
  const { key } = openInThread([VIDEO('m-1'), VIDEO('m-2', { mediaUrl: 'post-media/u-2/b.mp4' })]);
  openMessageVideo({ mediaRef: 'post-media/u-2/b.mp4' });
  const next = getCompactPlayback();
  stopPlayback('ended', key);
  minimizePlayback(key);
  assert.equal(getCompactPlayback(), next);
});

test('listeners hear every change and a stop', () => {
  let n = 0;
  const off = subscribeCompactPlayback(() => { n++; });
  const { key } = openInThread();
  minimizePlayback(key);
  stopPlayback('user', key);
  off();
  assert.equal(n, 3);
  assert.equal(getCompactPlayback(), null);
});

// ── The message source: unsend, delete, hide, leave ─────────────────────────

test('the bound message turning into a tombstone (unsend/delete) stops playback', () => {
  const { source, key } = openInThread();
  minimizePlayback(key);
  reportMessageSource(source, { threadId: 't-1', live: true, messages: [TEXT('m-0'), VIDEO('m-1', { deleted: true, mediaUrl: null })] });
  assert.equal(getCompactPlayback(), null);
  assert.equal(lastPlaybackStopReason(), 'message_gone');
});

test('the bound message leaving the thread (hidden / removed) stops playback', () => {
  const { source } = openInThread();
  reportMessageSource(source, { threadId: 't-1', live: true, messages: [TEXT('m-0')] });
  assert.equal(getCompactPlayback(), null);
  assert.equal(lastPlaybackStopReason(), 'message_gone');
});

test('the bound message\'s media changing stops playback', () => {
  const { source } = openInThread();
  reportMessageSource(source, { threadId: 't-1', live: true, messages: [VIDEO('m-1', { mediaUrl: 'post-media/u-2/new.mp4' })] });
  assert.equal(lastPlaybackStopReason(), 'message_gone');
});

test('an unrelated change in the thread does not stop playback', () => {
  const { source } = openInThread();
  reportMessageSource(source, { threadId: 't-1', live: true, messages: [TEXT('m-0'), VIDEO('m-1'), TEXT('m-2')] });
  assert.ok(getCompactPlayback());
  // Another source changing is not this session's business either.
  const other = threadWith([TEXT('x')], 't-9');
  reportMessageSource(other, { threadId: 't-9', live: true, messages: [] });
  assert.ok(getCompactPlayback());
});

test('the source losing access (removed, left, pending) stops playback', () => {
  const { source } = openInThread();
  reportMessageSource(source, { threadId: 't-1', live: false, messages: [VIDEO('m-1')] });
  assert.equal(lastPlaybackStopReason(), 'source_closed');
});

test('the source switching thread stops playback', () => {
  const { source } = openInThread();
  reportMessageSource(source, { threadId: 't-2', live: true, messages: [VIDEO('m-1')] });
  assert.equal(lastPlaybackStopReason(), 'source_closed');
});

test('the conversation unmounting stops playback; an unbound source unmounting does not', () => {
  const { source } = openInThread();
  const other = threadWith([TEXT('x')], 't-9');
  unregisterMessageSource(other);
  assert.ok(getCompactPlayback());
  unregisterMessageSource(source);
  assert.equal(lastPlaybackStopReason(), 'source_closed');
});

test('every source that held the video is bound; ANY of them losing it stops playback', () => {
  const a = threadWith([VIDEO('m-1')]);
  const b = threadWith([VIDEO('m-7')]);
  openMessageVideo({ mediaRef: REF });
  assert.equal(getCompactPlayback()?.bindings.length, 2);
  reportMessageSource(b, { threadId: 't-1', live: true, messages: [] });
  assert.equal(getCompactPlayback(), null);
  void a;
});

// ── Route and account ───────────────────────────────────────────────────────

test('leaving the conversation\'s route stops playback', () => {
  openInThread();
  reconcilePlaybackContext(routeKeyOf('/messages/t-1', {}), 'me-1');
  assert.ok(getCompactPlayback());
  reconcilePlaybackContext(routeKeyOf('/messages', {}), 'me-1');
  assert.equal(lastPlaybackStopReason(), 'route');
});

test('the same path with other params is another conversation (/trip/chat?id=A vs B)', () => {
  threadWith([VIDEO('m-1')]);
  openMessageVideo({ mediaRef: REF });
  reconcilePlaybackContext(routeKeyOf('/trip/chat', { id: 'A' }), 'me-1');
  reconcilePlaybackContext(routeKeyOf('/trip/chat', { id: 'A' }), 'me-1');
  assert.ok(getCompactPlayback());
  reconcilePlaybackContext(routeKeyOf('/trip/chat', { id: 'B' }), 'me-1');
  assert.equal(lastPlaybackStopReason(), 'route');
});

test('signing out, or another account, stops playback', () => {
  openInThread();
  reconcilePlaybackContext(routeKeyOf('/messages/t-1', {}), null);
  assert.equal(lastPlaybackStopReason(), 'signed_out');

  openInThread();
  reconcilePlaybackContext(routeKeyOf('/messages/t-1', {}), 'someone-else');
  assert.equal(lastPlaybackStopReason(), 'signed_out');
});

test('a session nobody is signed in to is stopped at once', () => {
  threadWith([VIDEO('m-1')]);
  openMessageVideo({ mediaRef: REF });
  reconcilePlaybackContext(routeKeyOf('/messages/t-1', {}), null);
  assert.equal(getCompactPlayback(), null);
  assert.equal(lastPlaybackStopReason(), 'signed_out');
});

test('routeKeyOf is order-independent and drops undefined params', () => {
  assert.equal(routeKeyOf('/a', { x: '1', y: '2' }), routeKeyOf('/a', { y: '2', x: '1', z: undefined }));
  assert.notEqual(routeKeyOf('/a', { x: '1' }), routeKeyOf('/a', { x: '2' }));
  assert.notEqual(routeKeyOf('/a', {}), routeKeyOf('/b', {}));
  assert.equal(routeKeyOf('/a', { x: ['1', '2'] }), '/a?x=1%2C2');
});

// ── Realtime and blocks ─────────────────────────────────────────────────────

test('realtime unsend/delete naming a bound message stops; naming another message does not', () => {
  openInThread();
  const s = getCompactPlayback()!;
  assert.equal(stopReasonForEvent(s, { type: 'message.unsent', payload: { messageId: 'm-1' } }, 'me-1'), 'message_gone');
  assert.equal(stopReasonForEvent(s, { type: 'message.deleted', payload: { messageId: 'm-1' } }, 'me-1'), 'message_gone');
  assert.equal(stopReasonForEvent(s, { type: 'message.unsent', payload: { messageId: 'm-0' } }, 'me-1'), null);
  assert.equal(stopReasonForEvent(s, { type: 'message.deleted', payload: {} }, 'me-1'), null);
  assert.equal(stopReasonForEvent(s, { type: 'message.created', payload: { messageId: 'm-1' } }, 'me-1'), null);
});

test('any block on this device, and a revoked stream, stop playback', () => {
  openInThread();
  const s = getCompactPlayback()!;
  assert.equal(stopReasonForEvent(s, { type: 'user.blocked', payload: { blockedId: 'u-9' } }, 'me-1'), 'blocked');
  assert.equal(stopReasonForEvent(s, { type: 'access.revoked' }, 'me-1'), 'access_revoked');
});

test('this viewer leaving a bound thread stops; someone else leaving does not', () => {
  openInThread();
  const s = getCompactPlayback()!;
  assert.equal(stopReasonForEvent(s, { type: 'member.left', threadId: 't-1', payload: { userId: 'me-1' } }, 'me-1'), 'left');
  assert.equal(stopReasonForEvent(s, { type: 'member.left', payload: { userId: 'me-1' } }, 'me-1'), 'left');
  assert.equal(stopReasonForEvent(s, { type: 'member.left', threadId: 't-1', payload: { userId: 'u-2' } }, 'me-1'), null);
  assert.equal(stopReasonForEvent(s, { type: 'member.left', threadId: 't-9', payload: { userId: 'me-1' } }, 'me-1'), null);
  assert.equal(stopReasonForEvent(s, { type: 'member.left', threadId: 't-1', payload: { userId: 'me-1' } }, null), null);
});

test('a known block with the sender, either direction, stops playback', () => {
  openInThread();
  const s = getCompactPlayback()!;
  assert.equal(stopReasonForBlocks(s, new Set(['u-2']), new Set()), 'blocked');
  assert.equal(stopReasonForBlocks(s, new Set(), new Set(['u-2'])), 'blocked');
  assert.equal(stopReasonForBlocks(s, new Set(['u-9']), new Set(['u-8'])), null);
});

test('isSourceBound is true only for a source the CURRENT session is bound to', () => {
  const { source, key } = openInThread();
  const other = threadWith([TEXT('x')], 't-9');
  assert.equal(isSourceBound(source), true);
  assert.equal(isSourceBound(other), false);
  assert.equal(isSourceBound(null), false);
  stopPlayback('user', key);
  assert.equal(isSourceBound(source), false);
});

test('T366 §66 review: a source keeps only the six fields this module reads — never a message body', async () => {
  const store = await import('../compactPlaybackStore.ts');
  const id = store.registerMessageSource();
  const withText = { id: 'm1', senderId: 's1', deleted: false, msgType: 'media', mediaType: 'video', mediaUrl: 'videos/a.mp4', body: 'SECRET BODY', translatedBody: 'SECRET TRANSLATION', caption: 'SECRET CAPTION' };
  store.reportMessageSource(id, { threadId: 't1', live: true, messages: [withText as unknown as import('../compactPlaybackStore.ts').PlaybackSourceMessage] });
  const kept = store.retainedSourceMessagesForTest(id);
  assert.equal(kept.length, 1);
  assert.deepEqual(Object.keys(kept[0]!).sort(), ['deleted', 'id', 'mediaType', 'mediaUrl', 'msgType', 'senderId']);
  assert.ok(!JSON.stringify(kept).includes('SECRET'), 'a retained message carries no text');
  store.unregisterMessageSource(id);
});
