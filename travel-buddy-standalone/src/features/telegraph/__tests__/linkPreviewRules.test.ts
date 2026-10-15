/**
 * census-telegraph T404 / T446 (B58 TM-2) — the client's pure rules, measured:
 *   - `telegraphMediaUri`: a media URI the message tree draws is Portava storage
 *     or null — the server's `storageImageOrNull` rule, decided by prefix so no
 *     parser's reading of the authority matters;
 *   - `messageMayHavePreview` / `bodyHasExternalLink`: when a device may ASK;
 *   - `isOpenablePreviewLink` / `isDrawablePreview`: what may be drawn and opened;
 *   - `LinkPreviewStore`: one read per render pass per thread, ids only, a miss
 *     re-asked at most once, everything forgotten when the viewer changes.
 * Pure TypeScript — no React, no native modules, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { telegraphMediaUri, mediaUriForOrigin, configuredStorageOrigin } from '../linkPreview/telegraphMediaUri.ts';
import {
  bodyHasExternalLink,
  bodyVersion,
  bodyWrittenAtMs,
  isDrawablePreview,
  isOpenablePreviewLink,
  isServerMessageId,
  messageMayHavePreview,
  type PreviewableMessage,
  type WirePreview,
} from '../linkPreview/linkPreviewRules.ts';
import { LinkPreviewStore, RECHECK_DELAY_MS, RECHECK_YOUNG_MS } from '../linkPreview/linkPreviewStore.ts';

const ORIGIN = 'https://abcd.supabase.co';
const MSG = '11111111-1111-4111-8111-111111111111';
const MSG2 = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';

// ── telegraphMediaUri ─────────────────────────────────────────────────────────

test('M1 kept: bare storage refs, and URLs on the configured storage origin under /storage/v1/ (public, signed, render)', () => {
  for (const v of [
    'post-media/u-1/a.jpg',
    'stamp-artwork/x/y.png',
    `${ORIGIN}/storage/v1/object/public/stamp-artwork/a.png`,
    `${ORIGIN}/storage/v1/object/sign/post-media/u/a.jpg?token=t`,
    `${ORIGIN}/storage/v1/render/image/sign/post-media/u/a.jpg?token=t&width=400`,
  ]) assert.equal(mediaUriForOrigin(v, ORIGIN), v, v);
  assert.equal(mediaUriForOrigin('  post-media/u/a.jpg  ', ORIGIN), 'post-media/u/a.jpg', 'trimmed');
});

test('M2 withheld: any other host, and every trick that would move the authority off the storage host', () => {
  for (const v of [
    'https://tracker.example/pixel.gif?r=recipient-1',
    'http://abcd.supabase.co/storage/v1/object/public/a/b.png',          // scheme differs
    'https://abcd.supabase.co.tracker.example/storage/v1/object/a.png',   // suffix host
    'https://abcd.supabase.co@tracker.example/storage/v1/object/a.png',   // userinfo
    'https://tracker.example/?https://abcd.supabase.co/storage/v1/',      // origin in the query
    'https://abcd.supabase.co:8443/storage/v1/object/public/a/b.png',     // another port
    'https://abcd.supabase.co\\@tracker.example/storage/v1/x.png',        // backslash
    'https://abcd.supabase.co/rest/v1/profiles',                          // not storage
    'https://abcd.supabase.co/storage/v2/x.png',
    '//tracker.example/x.png',                                            // scheme-relative
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'tracker.example/pixel.gif',                                          // a dotted "bucket" is a host, not a bucket
    'post-media/../../x',
    'post-media/u/a b.jpg',
    `${ORIGIN}/storage/v1/x\\@tracker.example/`,                     // a backslash anywhere (verifier S6b)
    `${ORIGIN}/storage/v1/a b.png`,                                   // whitespace anywhere
    `${ORIGIN}/storage/v1/../../rest/v1/profiles`,                    // a dot-segment off /storage/v1/ (S7)
    `${ORIGIN}/storage/v1/%2e%2e/%2E%2E/rest/v1/profiles`,             // the same, percent-encoded
    'post-media/u/a\n.jpg',
    '',
    '   ',
  ]) assert.equal(mediaUriForOrigin(v, ORIGIN), null, JSON.stringify(v));
  for (const v of [null, undefined, 42, {}, ['post-media/a']]) assert.equal(mediaUriForOrigin(v, ORIGIN), null);
});

test('M2b the production door takes exactly one argument: a second one cannot widen the origin', () => {
  assert.equal(telegraphMediaUri.length, 1);
  const was = process.env.EXPO_PUBLIC_SUPABASE_URL;
  try {
    process.env.EXPO_PUBLIC_SUPABASE_URL = ORIGIN;
    // @ts-expect-error — the compiler refuses a second argument; at runtime it is ignored
    assert.equal(telegraphMediaUri('https://evil.example/storage/v1/x.png', 'https://evil.example'), null);
    assert.equal(telegraphMediaUri(`${ORIGIN}/storage/v1/x.png`), `${ORIGIN}/storage/v1/x.png`);
  } finally {
    if (was === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL; else process.env.EXPO_PUBLIC_SUPABASE_URL = was;
  }
});

test('M3 no configured storage origin: absolute URLs are all withheld, bare refs still kept', () => {
  assert.equal(mediaUriForOrigin(`${ORIGIN}/storage/v1/object/public/a/b.png`, null), null);
  assert.equal(mediaUriForOrigin('post-media/u/a.jpg', null), 'post-media/u/a.jpg');
});

test('M4 configuredStorageOrigin reads EXPO_PUBLIC_SUPABASE_URL: scheme + lowercased host (+ port), nothing else', () => {
  const was = process.env.EXPO_PUBLIC_SUPABASE_URL;
  try {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://ABCD.supabase.co/';
    assert.equal(configuredStorageOrigin(), ORIGIN);
    assert.equal(telegraphMediaUri(`${ORIGIN}/storage/v1/object/public/a/b.png`), `${ORIGIN}/storage/v1/object/public/a/b.png`);
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    assert.equal(configuredStorageOrigin(), 'http://127.0.0.1:54321');
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'not a url';
    assert.equal(configuredStorageOrigin(), null);
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    assert.equal(configuredStorageOrigin(), null);
  } finally {
    if (was === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL; else process.env.EXPO_PUBLIC_SUPABASE_URL = was;
  }
});

// ── when a device may ask ─────────────────────────────────────────────────────

const text = (over: Partial<PreviewableMessage> = {}): PreviewableMessage => ({
  id: MSG, clientId: 'c-1', senderId: 'u-1', body: 'look https://example.com/a', msgType: 'text', subtype: null,
  deleted: false, createdAt: '2026-10-14T10:00:00.000Z', editedAt: null, ...over,
});

test('R1 bodyHasExternalLink: an http(s) token anywhere; never a bare word, never another scheme', () => {
  assert.equal(bodyHasExternalLink('see https://example.com'), true);
  assert.equal(bodyHasExternalLink('http://example.com first'), true);
  assert.equal(bodyHasExternalLink('(https://example.com)'), true);
  assert.equal(bodyHasExternalLink('example.com and www.example.com'), false);
  assert.equal(bodyHasExternalLink('ftp://example.com'), false);
  assert.equal(bodyHasExternalLink('xhttps://example.com'), false);
  assert.equal(bodyHasExternalLink(''), false);
  assert.equal(bodyHasExternalLink(null), false);
});

test('R2 messageMayHavePreview: only a stored, live, plain-text, unencrypted message with a link', () => {
  assert.equal(messageMayHavePreview(text()), true);
  assert.equal(messageMayHavePreview(text({ msgType: undefined })), true, 'msgType absent is text');
  assert.equal(messageMayHavePreview(text({ body: 'no link here' })), false);
  assert.equal(messageMayHavePreview(text({ body: 'translated', originalBody: 'orig https://x.example' })), true, 'the ORIGINAL body decides');
  assert.equal(messageMayHavePreview(text({ msgType: 'system', subtype: 'post_card' })), false);
  assert.equal(messageMayHavePreview(text({ msgType: 'gif' })), false);
  assert.equal(messageMayHavePreview(text({ subtype: 'anything' })), false);
  assert.equal(messageMayHavePreview(text({ deleted: true })), false);
  assert.equal(messageMayHavePreview(text({ ciphertext: 'AAAA' })), false, 'E2EE: carries ciphertext');
  assert.equal(messageMayHavePreview(text({ e2eeFailed: true })), false);
  assert.equal(messageMayHavePreview(text({ deliveryStatus: 'sending' })), false);
  assert.equal(messageMayHavePreview(text({ deliveryStatus: 'failed' })), false);
  assert.equal(messageMayHavePreview(text({ id: 'c-1', clientId: 'c-1' })), false, 'an optimistic id is not a server id');
  assert.equal(messageMayHavePreview(text({ id: MSG, clientId: MSG })), false);
  assert.equal(messageMayHavePreview(null), false);
  assert.equal(isServerMessageId('not-a-uuid'), false);
});

test('R3 bodyVersion / bodyWrittenAtMs: an edit is a new version; written-at is the later of sent and edited', () => {
  assert.equal(bodyVersion({ editedAt: null }), '');
  assert.equal(bodyVersion({ editedAt: '2026-10-14T10:05:00.000Z' }), '2026-10-14T10:05:00.000Z');
  assert.equal(bodyWrittenAtMs({ createdAt: '2026-10-14T10:00:00.000Z', editedAt: null }), Date.parse('2026-10-14T10:00:00.000Z'));
  assert.equal(bodyWrittenAtMs({ createdAt: '2026-10-14T10:00:00.000Z', editedAt: '2026-10-14T10:05:00.000Z' }), Date.parse('2026-10-14T10:05:00.000Z'));
  assert.ok(Number.isNaN(bodyWrittenAtMs({ createdAt: null, editedAt: null })));
});

// ── what may be drawn and opened ──────────────────────────────────────────────

const wire = (over: Partial<WirePreview> = {}): WirePreview => ({
  messageId: MSG, url: 'https://example.com/a', host: 'example.com', title: 'T', description: 'D', siteName: 'S', ...over,
});

test('O1 isOpenablePreviewLink: the https link to exactly the named host — decided by prefix', () => {
  assert.equal(isOpenablePreviewLink('https://example.com/a?b#c', 'example.com'), true);
  assert.equal(isOpenablePreviewLink('https://example.com', 'example.com'), true);
  assert.equal(isOpenablePreviewLink('https://xn--80ak6aa92e.com/', 'xn--80ak6aa92e.com'), true, 'punycode is shown as punycode');
  for (const [url, host] of [
    ['http://example.com/a', 'example.com'],
    ['https://example.com.evil.example/a', 'example.com'],
    ['https://example.com@evil.example/a', 'example.com'],
    ['https://example.com:8443/a', 'example.com'],
    ['https://evil.example/a', 'example.com'],
    ['https://evil.exampl/a', 'example.com'],                 // another host of the SAME length: the prefix itself must match
    ['https://evil.exampl/x?u=https://example.com', 'example.com'], // the named host appears later in the URL (verifier S6a)
    ['https://example.com\\@evil.example/', 'example.com'],
    ['https://example.com/a b', 'example.com'],
    ['javascript:alert(1)', 'example.com'],
    ['https://example.com/a', 'Example Com'],
    ['https://localhost/', 'localhost'],
  ]) assert.equal(isOpenablePreviewLink(url, host), false, `${url} / ${host}`);
});

test('O2 isDrawablePreview: every field a string and an openable link, or it is not drawn', () => {
  assert.equal(isDrawablePreview(wire()), true);
  assert.equal(isDrawablePreview(wire({ host: 'evil.example' })), false);
  assert.equal(isDrawablePreview({ ...wire(), title: null }), false);
  assert.equal(isDrawablePreview({ ...wire(), imageUrl: 'https://tracker.example/x.png' }), true, 'an extra field is ignored — nothing reads it');
  assert.equal(isDrawablePreview(null), false);
  assert.equal(isDrawablePreview('x'), false);
});

// ── the store ────────────────────────────────────────────────────────────────

function harness(answer: (threadId: string, ids: readonly string[]) => { ok: true; previews: WirePreview[] } | { ok: false } = () => ({ ok: true, previews: [] })) {
  const reads: Array<{ threadId: string; ids: string[] }> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let now = Date.parse('2026-10-14T10:00:10.000Z');
  const store = new LinkPreviewStore({
    fetchPreviews: async (threadId, ids) => { reads.push({ threadId, ids: [...ids] }); return answer(threadId, ids); },
    now: () => now,
    schedule: (fn, ms) => { timers.push({ fn, ms }); },
    batchMax: 2,
  });
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  return { store, reads, timers, settle, advance: (ms: number) => { now += ms; } };
}
const WRITTEN = Date.parse('2026-10-14T10:00:00.000Z');

test('S1 one render pass ⇒ one read per thread, chunked at batchMax, ids only', async () => {
  const h = harness();
  h.store.setViewer('viewer-1');
  h.store.want(THREAD, MSG, '', WRITTEN);
  h.store.want(THREAD, MSG2, '', WRITTEN);
  h.store.want(THREAD, '44444444-4444-4444-8444-444444444444', '', WRITTEN);
  h.store.want(THREAD, MSG, '', WRITTEN); // the same message again: no second ask
  await h.settle();
  assert.deepEqual(h.reads.map((r) => r.ids.length), [2, 1]);
  assert.deepEqual(h.reads[0], { threadId: THREAD, ids: [MSG, MSG2] });
});

test('S2 a served preview is remembered; a known entry is never read again', async () => {
  const h = harness((_t, ids) => ({ ok: true, previews: ids.includes(MSG) ? [wire()] : [] }));
  h.store.setViewer('viewer-1');
  h.store.want(THREAD, MSG, '', WRITTEN - 10 * 60_000);
  await h.settle();
  assert.equal(h.store.get(THREAD, MSG, '')?.state, 'ready');
  h.store.want(THREAD, MSG, '', WRITTEN);
  await h.settle();
  assert.equal(h.reads.length, 1);
});

test('S3 a miss on a YOUNG body is asked once more after RECHECK_DELAY_MS — and never a third time', async () => {
  let served = false;
  const h = harness(() => ({ ok: true, previews: served ? [wire()] : [] }));
  h.store.setViewer('viewer-1');
  h.store.want(THREAD, MSG, '', WRITTEN);            // written 10 s ago
  await h.settle();
  assert.equal(h.store.get(THREAD, MSG, '')?.state, 'none');
  assert.deepEqual(h.timers.map((t) => t.ms), [RECHECK_DELAY_MS]);
  served = true;
  h.timers[0].fn();
  await h.settle();
  assert.equal(h.reads.length, 2);
  assert.equal(h.store.get(THREAD, MSG, '')?.state, 'ready');

  // A young miss that stays a miss: still only two reads.
  const g = harness();
  g.store.setViewer('viewer-1');
  g.store.want(THREAD, MSG, '', WRITTEN);
  await g.settle();
  g.timers[0].fn();
  await g.settle();
  assert.equal(g.reads.length, 2);
  assert.equal(g.timers.length, 1, 'no second recheck is scheduled');
});

test('S4 a miss — or a failed read — on an OLD body is final', async () => {
  const h = harness(() => ({ ok: false }));
  h.store.setViewer('viewer-1');
  h.store.want(THREAD, MSG, '', WRITTEN - RECHECK_YOUNG_MS - 1);
  await h.settle();
  assert.equal(h.store.get(THREAD, MSG, '')?.state, 'none');
  assert.equal(h.timers.length, 0);
});

test('S5 an edit is a new version: asked about afresh', async () => {
  const h = harness();
  h.store.setViewer('viewer-1');
  h.store.want(THREAD, MSG, '', WRITTEN - RECHECK_YOUNG_MS - 1);
  await h.settle();
  h.store.want(THREAD, MSG, '2026-10-14T10:05:00.000Z', WRITTEN - RECHECK_YOUNG_MS - 1);
  await h.settle();
  assert.equal(h.reads.length, 2);
});

test('S6 the sender’s own answer is remembered without a read, and never rechecked', async () => {
  const h = harness();
  h.store.setViewer('viewer-1');
  h.store.seed(THREAD, MSG, '', wire());
  h.store.want(THREAD, MSG, '', WRITTEN);
  await h.settle();
  assert.equal(h.reads.length, 0);
  assert.equal(h.store.get(THREAD, MSG, '')?.state, 'ready');
});

test('S7 another viewer forgets everything — and an answer still on its way for the old viewer never lands for the new one', async () => {
  const releases: Array<() => void> = [];
  const answers = [{ ok: true as const, previews: [wire()] }, { ok: true as const, previews: [] }];
  const reads: string[][] = [];
  const store = new LinkPreviewStore({
    fetchPreviews: (_t, ids) => {
      const i = reads.length;
      reads.push([...ids]);
      return new Promise((resolve) => { releases.push(() => resolve(answers[i])); });
    },
    now: () => WRITTEN, schedule: () => {}, batchMax: 50,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  store.setViewer('viewer-1');
  store.want(THREAD, MSG, '', WRITTEN);
  await tick();
  store.setViewer('viewer-2');
  assert.equal(store.get(THREAD, MSG, ''), undefined, 'viewer-1’s pending entry is gone');
  store.want(THREAD, MSG, '', WRITTEN);                 // viewer-2 asks about the same message
  await tick();
  assert.equal(reads.length, 2, 'viewer-2 makes its own read');
  releases[0]();                                         // viewer-1’s answer (a preview) arrives late
  await tick();
  assert.equal(store.get(THREAD, MSG, '')?.state, 'pending', 'viewer-1’s answer did not land for viewer-2');
  releases[1]();                                         // viewer-2’s own answer: no preview
  await tick();
  assert.equal(store.get(THREAD, MSG, '')?.state, 'none');
});

test('S8 listeners hear every settled read', async () => {
  const h = harness(() => ({ ok: true, previews: [wire()] }));
  let heard = 0;
  const off = h.store.subscribe(() => { heard++; });
  h.store.setViewer('viewer-1');
  h.store.want(THREAD, MSG, '', WRITTEN);
  await h.settle();
  off();
  assert.ok(heard >= 1);
});
