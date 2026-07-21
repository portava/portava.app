/**
 * Verifies every time-aware Compass call sends the device's real UTC offset
 * (tzOffsetMinutes) — feed, feed sections, ask, recommendations (all
 * surfaces), and telegraph — matching /compass/home, so evening styling
 * follows the traveler's clock even without a saved timezone.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/compass.tzOffsetSurfaces.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

let compass: typeof import('../compass.ts');

let calls: Array<{ url: string; body?: string }> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
  return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
}) as typeof fetch;

after(() => { globalThis.fetch = realFetch; });

// +0 normalizes -0 (UTC devices) so strict equality doesn't trip on sign.
const expected = -new Date().getTimezoneOffset() + 0;

function assertQueryOffset(url: string) {
  const raw = new URL(url).searchParams.get('tzOffsetMinutes');
  assert.notEqual(raw, null);
  assert.equal(Number(raw) + 0, expected);
}

describe('Compass surfaces send tzOffsetMinutes', () => {
  before(async () => {
    compass = await import('../compass.ts');
  });

  beforeEach(() => {
    calls = [];
    compass._setTestAuthToken('test-token');
  });

  it('feed appends tzOffsetMinutes', async () => {
    await compass.fetchCompassFeed({ city: 'Lisbon' });
    assert.equal(calls.length, 1);
    assertQueryOffset(calls[0].url);
  });

  it('feed section appends tzOffsetMinutes', async () => {
    await compass.fetchCompassSection('tonight', {});
    assert.equal(calls.length, 1);
    assertQueryOffset(calls[0].url);
  });

  it('ask includes tzOffsetMinutes in the body', async () => {
    await compass.postCompassAsk('what should I do tonight?');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body ?? '{}');
    assert.equal(Number(body.tzOffsetMinutes) + 0, expected);
  });

  it('recommendations appends tzOffsetMinutes', async () => {
    await compass.fetchCompassRecommendations({ surface: 'explore' });
    assert.equal(calls.length, 1);
    assertQueryOffset(calls[0].url);
  });

  it('buddy matches appends tzOffsetMinutes', async () => {
    await compass.fetchCompassBuddyMatches({});
    assert.equal(calls.length, 1);
    assertQueryOffset(calls[0].url);
  });

  it('traveler matches appends tzOffsetMinutes', async () => {
    await compass.fetchCompassTravelerMatches({});
    assert.equal(calls.length, 1);
    assertQueryOffset(calls[0].url);
  });

  it('telegraph appends tzOffsetMinutes', async () => {
    await compass.fetchCompassTelegraphCards('thread-1');
    assert.equal(calls.length, 1);
    assertQueryOffset(calls[0].url);
  });
});
