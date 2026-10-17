import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDiscoveryTokenSourceForTests, postSearchSignal } from '../discovery.ts';
import { _resetDiscoveryViewerScopeForTests, currentDiscoveryScope, setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';

const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let calls: Array<{ url: string; init?: RequestInit }>;

function tokenFor(account: string, version = 1): string {
  return `header.${Buffer.from(JSON.stringify({ sub: account, version })).toString('base64url')}.signature`;
}

function pendingToken() {
  let resolve!: (token: string | null) => void;
  const promise = new Promise<string | null>((complete) => { resolve = complete; });
  _setDiscoveryTokenSourceForTests(() => promise);
  return { resolve };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession('account-a');
  calls = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  _setDiscoveryTokenSourceForTests(null);
  mock.restoreAll();
  _resetDiscoveryViewerScopeForTests();
  if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
});

for (const nextAccount of ['account-b', 'account-a']) {
  test(`an old search is not posted after logout and login as ${nextAccount} during token lookup`, async () => {
    const pending = pendingToken();
    assert.equal(postSearchSignal('private search', { city: 'Old city', category: 'food' }), undefined);
    setDiscoveryViewerFromSession(null);
    setDiscoveryViewerFromSession(nextAccount);
    const scope = currentDiscoveryScope();
    pending.resolve(tokenFor(nextAccount));
    await flush();
    assert.equal(calls.length, 0);
    assert.deepEqual(currentDiscoveryScope(), scope);
  });
}

test('a direct account switch while the token is pending drops the old search', async () => {
  const pending = pendingToken();
  postSearchSignal('private search');
  setDiscoveryViewerFromSession('account-b');
  pending.resolve(tokenFor('account-b'));
  await flush();
  assert.equal(calls.length, 0);
});

test('logout prevents a late old-account token from sending a search', async () => {
  const pending = pendingToken();
  postSearchSignal('private search');
  setDiscoveryViewerFromSession(null);
  pending.resolve(tokenFor('account-a'));
  await flush();
  assert.equal(calls.length, 0);
});

test('a mismatched token cannot silently change the signal owner or global viewer', async () => {
  const pending = pendingToken();
  const scope = currentDiscoveryScope();
  postSearchSignal('private search');
  pending.resolve(tokenFor('account-b'));
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(currentDiscoveryScope(), scope);
});

for (const knownSignedOut of [false, true]) {
  test(`no search owner is inferred from a late token (known signed out: ${knownSignedOut})`, async () => {
    _resetDiscoveryViewerScopeForTests();
    if (knownSignedOut) setDiscoveryViewerFromSession(null);
    const pending = pendingToken();
    const scope = currentDiscoveryScope();
    postSearchSignal('private search');
    pending.resolve(tokenFor('account-a'));
    await flush();
    assert.equal(calls.length, 0);
    assert.deepEqual(currentDiscoveryScope(), scope);
  });
}

test('a same-account refresh posts once with the refreshed token and original payload', async () => {
  const pending = pendingToken();
  const scope = currentDiscoveryScope();
  postSearchSignal('museum', { city: 'Lisbon', category: 'places' });
  setDiscoveryViewerFromSession('account-a');
  const refreshed = tokenFor('account-a', 2);
  pending.resolve(refreshed);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9/api/compass/signals/search');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${refreshed}` });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { query: 'museum', city: 'Lisbon', category: 'places' });
  assert.deepEqual(currentDiscoveryScope(), scope);
});

test('a healthy signed-in request preserves null defaults', async () => {
  _setDiscoveryTokenSourceForTests(async () => tokenFor('account-a'));
  postSearchSignal('museum');
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { query: 'museum', city: null, category: null });
});

test('a missing token sends nothing', async () => {
  _setDiscoveryTokenSourceForTests(async () => null);
  postSearchSignal('museum');
  await flush();
  assert.equal(calls.length, 0);
});

test('token lookup failure remains fire-and-forget', async () => {
  _setDiscoveryTokenSourceForTests(async () => { throw new Error('token unavailable'); });
  assert.equal(postSearchSignal('museum'), undefined);
  await flush();
  assert.equal(calls.length, 0);
});

test('network failure remains fire-and-forget', async () => {
  _setDiscoveryTokenSourceForTests(async () => tokenFor('account-a'));
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal(postSearchSignal('museum'), undefined);
  await flush();
  assert.equal(fetch.mock.callCount(), 1);
});

test('an unconfigured API does not even start token lookup', async () => {
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
  const source = mock.fn(async () => tokenFor('account-a'));
  _setDiscoveryTokenSourceForTests(source);
  postSearchSignal('museum');
  await flush();
  assert.equal(source.mock.callCount(), 0);
  assert.equal(calls.length, 0);
});
