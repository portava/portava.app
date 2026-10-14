/**
 * playbackAuthorization — census-telegraph T62 (node:test), against the REAL
 * signed-URL client (`lib/batchSignMedia.ts`) with only `fetch` stood in for
 * the server.
 *
 * The point it pins: the answer comes from the SERVER, now. The client keeps a
 * signed URL for up to 55 minutes; a re-check that read that cache would keep
 * a revoked viewer's video playing — and let a re-open after revocation play —
 * for most of an hour.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetBatchSignCache,
  _setTestSignTokenProvider,
  batchSignUrls,
} from '../../../../lib/batchSignMedia.ts';
import { forgetPlaybackSignature, recheckPlaybackAuthorization } from '../playbackAuthorization.ts';

const REF = 'post-media/u-2/clip.mp4';
let origFetch: typeof globalThis.fetch;
let server: 'allow' | 'deny' | 'down' = 'allow';
let requests = 0;

beforeEach(() => {
  origFetch = globalThis.fetch;
  _resetBatchSignCache();
  _setTestSignTokenProvider(async () => 'token');
  server = 'allow';
  requests = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    requests += 1;
    if (server === 'down') throw new TypeError('Network request failed');
    const { urls } = JSON.parse(init?.body ?? '{}') as { urls: string[] };
    const signed = Object.fromEntries(urls.map((u) => [u, server === 'allow' ? `https://signed.example/${u}?t=${requests}` : null]));
    return { ok: true, status: 200, json: async () => ({ signed, ttlSeconds: 3600 }) } as unknown as Response;
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  _setTestSignTokenProvider(null);
  _resetBatchSignCache();
});

test('a server that signs: allowed', async () => {
  assert.equal(await recheckPlaybackAuthorization(REF), 'allowed');
  assert.equal(requests, 1);
});

test('a revocation AFTER the reference was signed and cached is seen at once — the cache is bypassed', async () => {
  // The player signed it at open; the cache now holds a URL valid for ~55 min.
  await batchSignUrls([REF]);
  assert.equal(requests, 1);
  // A plain sign would now be served from that cache, saying nothing about now…
  await batchSignUrls([REF]);
  assert.equal(requests, 1, 'precondition: an ordinary sign is a cache hit');
  // …the server revokes (block, removal), and the re-check asks it.
  server = 'deny';
  assert.equal(await recheckPlaybackAuthorization(REF), 'refused');
  assert.equal(requests, 2);
});

test('every re-check reaches the server, never a cached answer', async () => {
  await recheckPlaybackAuthorization(REF);
  await recheckPlaybackAuthorization(REF);
  await recheckPlaybackAuthorization(REF);
  assert.equal(requests, 3);
});

test('a server that cannot be reached is unknown, not a refusal', async () => {
  server = 'down';
  assert.equal(await recheckPlaybackAuthorization(REF), 'unknown');
});

test('forgetting a signature makes the next ordinary sign ask the server again', async () => {
  await batchSignUrls([REF]);
  forgetPlaybackSignature(REF);
  await batchSignUrls([REF]);
  assert.equal(requests, 2);
});

test('an empty reference is refused without a request', async () => {
  assert.equal(await recheckPlaybackAuthorization(''), 'refused');
  assert.equal(requests, 0);
});
