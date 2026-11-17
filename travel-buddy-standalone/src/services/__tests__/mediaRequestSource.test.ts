import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mediaDeliveryLocator, mediaRequestSource, resolveMediaRequestSources } from '../mediaRequestSource.ts';
import { currentDiscoveryScope, invalidateDiscoveryCaches, setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';

const OWNER = 'a1000000-0000-4000-a000-000000000002';
const OTHER = 'a1000000-0000-4000-a000-000000000003';
const API = 'https://rumazi.com';
const path = `/api/media/file/post-media/${OWNER}/image.jpg?viewer=${OWNER}`;
const token = (viewer: string) => `e30.${Buffer.from(JSON.stringify({ sub: viewer })).toString('base64url')}.c2ln`;
const previousBase = process.env.EXPO_PUBLIC_API_BASE_URL;

describe('authenticated media request sources', () => {
  before(() => { process.env.EXPO_PUBLIC_API_BASE_URL = API; });
  beforeEach(() => { setDiscoveryViewerFromSession(OWNER); });
  after(() => { setDiscoveryViewerFromSession(null); if (previousBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = previousBase; });

  it('resolves only the configured app relay and keeps credentials out of its URL', () => {
    const source = mediaRequestSource(path, token(OWNER), currentDiscoveryScope());
    assert.deepEqual(source, { uri: `${API}${path}`, headers: { Authorization: `Bearer ${token(OWNER)}` } });
    assert.doesNotMatch(source!.uri, /Bearer|c2ln|token=/);
    assert.deepEqual(mediaDeliveryLocator(`${API}${path}&width=640&quality=75`), { uri: `${API}${path}&width=640&quality=75`, viewerId: OWNER });
  });

  it('requires the source viewer, current account and token subject to agree', () => {
    const scope = currentDiscoveryScope();
    assert.equal(mediaRequestSource(path, null, scope), null);
    assert.equal(mediaRequestSource(path, token(OTHER), scope), null);
    assert.equal(mediaRequestSource(path.replace(`viewer=${OWNER}`, `viewer=${OTHER}`), token(OWNER), scope), null);
    setDiscoveryViewerFromSession(OTHER);
    assert.equal(mediaRequestSource(path, token(OWNER), scope), null);
    assert.equal(mediaRequestSource(path, token(OWNER), currentDiscoveryScope()), null);
  });

  it('rejects the previous permission epoch even when the account is unchanged', () => {
    const scope = currentDiscoveryScope(); invalidateDiscoveryCaches();
    assert.equal(mediaRequestSource(path, token(OWNER), scope), null);
    assert.equal(mediaRequestSource('https://storage.test/old-signed?token=private', token(OWNER), scope), null);
  });

  it('never sends bearer credentials to a foreign relay or URL credential authority', () => {
    for (const uri of [`https://foreign.test${path}`, `https://rumazi.com.foreign.test${path}`, `https://user:secret@rumazi.com${path}`, `https://foreign.test@rumazi.com${path}`]) {
      assert.equal(mediaDeliveryLocator(uri), null);
      assert.equal(mediaRequestSource(uri, token(OWNER), currentDiscoveryScope()), null);
    }
  });

  it('rejects credentials in query strings, unknown buckets, missing/duplicated viewers and fragments', () => {
    for (const uri of [`${API}${path}&token=credential`, `${API}${path}&access_token=credential`, `${API}${path}&viewer=${OWNER}`, `${API}${path}#fragment`, `${API}${path.replace('post-media/', 'foreign/')}`, `${API}${path.split('?')[0]}`]) {
      assert.equal(mediaDeliveryLocator(uri), null);
      assert.equal(mediaRequestSource(uri, token(OWNER), currentDiscoveryScope()), null);
    }
  });

  it('rejects traversal and malformed relay locators rather than unauthenticated fallback', () => {
    for (const uri of [`/api/media/file/post-media/a/%2f../secret?viewer=${OWNER}`, `/api/media/file/post-media/a//secret?viewer=${OWNER}`, `/api/media/file/post-media/a/%00secret?viewer=${OWNER}`, '/api/media/file/session']) {
      assert.equal(mediaDeliveryLocator(uri), null);
      assert.equal(mediaRequestSource(uri, token(OWNER), currentDiscoveryScope()), null);
    }
  });

  it('preserves local files, public images and the old signed contract without adding bearer headers', async () => {
    const values = ['file:///private/photo.jpg', 'https://public.example.test/image.jpg', 'https://storage.example.test/storage/v1/object/sign/post-media/x?token=legacy'];
    for (const uri of values) assert.deepEqual(mediaRequestSource(uri, token(OWNER), currentDiscoveryScope()), { uri });
    const resolved = Object.fromEntries(values.map((uri, i) => [`source${i}`, uri]));
    assert.deepEqual(await resolveMediaRequestSources({ ...resolved, denied: null }), { source0: { uri: values[0] }, source1: { uri: values[1] }, source2: { uri: values[2] }, denied: null });
  });

  it('requires a secure configured API origin except explicit loopback development', () => {
    for (const base of ['http://rumazi.com', 'https://rumazi.com/path', 'https://user@rumazi.com', 'https://rumazi.com?key=secret']) {
      process.env.EXPO_PUBLIC_API_BASE_URL = base;
      assert.equal(mediaDeliveryLocator(`${API}${path}`), null);
    }
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:8090';
    assert.equal(mediaDeliveryLocator(path)?.uri, `http://127.0.0.1:8090${path}`);
    process.env.EXPO_PUBLIC_API_BASE_URL = API;
  });
});
