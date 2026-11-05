/**
 * Unit tests for reportCompassViewed — the fire-and-forget "viewed" outcome
 * report sent to POST /api/compass/outcomes when a recommendation card is
 * actually opened.
 *
 * Run via:
 *   npx jest src/services/__tests__/compass.reportViewed.component.test.ts
 */
import assert from 'node:assert/strict';

// Env must be set before the service module (and its supabase import) loads,
// so the module is imported lazily in the beforeAll() hook below.
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

let reportCompassViewed: typeof import('../compass.ts')['reportCompassViewed'];
let _resetReportedOutcomes: typeof import('../compass.ts')['_resetReportedOutcomes'];
let _setTestAuthToken: typeof import('../compass.ts')['_setTestAuthToken'];

interface CapturedCall { url: string; body: Record<string, unknown>; }

let calls: CapturedCall[] = [];
let failNext = false;

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, opts: RequestInit = {}) => {
  if (failNext) { failNext = false; return Promise.reject(new Error('network down')); }
  calls.push({ url: String(url), body: JSON.parse(String(opts.body ?? '{}')) });
  return Promise.resolve(new Response(JSON.stringify({ recorded: true }), { status: 200 }));
}) as typeof fetch;

afterAll(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('reportCompassViewed', () => {
  beforeAll(async () => {
    const mod = require('../compass.ts');
    reportCompassViewed = mod.reportCompassViewed;
    _resetReportedOutcomes = mod._resetReportedOutcomes;
    _setTestAuthToken = mod._setTestAuthToken;
  });

  beforeEach(() => {
    calls = [];
    failNext = false;
    _resetReportedOutcomes();
    _setTestAuthToken('test-token');
  });

  it('posts stage "viewed" with the recommendationId', async () => {
    reportCompassViewed('rec-123', 'item-1');
    await flush();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/compass/outcomes'));
    assert.deepEqual(calls[0].body, { recommendationId: 'rec-123', stage: 'viewed' });
  });

  it('falls back to itemId when no recommendation token exists', async () => {
    reportCompassViewed(null, 'item-42');
    await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { itemId: 'item-42', stage: 'viewed' });
  });

  it('is one-shot per recommendation — duplicate opens do not re-post', async () => {
    reportCompassViewed('rec-dup', 'item-1');
    reportCompassViewed('rec-dup', 'item-1');
    await flush();
    reportCompassViewed('rec-dup', 'item-1');
    await flush();
    assert.equal(calls.length, 1);
  });

  it('dedupes itemId-only reports separately from token reports', async () => {
    reportCompassViewed(null, 'item-9');
    reportCompassViewed(null, 'item-9');
    await flush();
    assert.equal(calls.length, 1);
  });

  it('no-ops without any identifier', async () => {
    reportCompassViewed(null, null);
    reportCompassViewed(undefined, undefined);
    await flush();
    assert.equal(calls.length, 0);
  });

  it('swallows network failures silently and never throws', async () => {
    failNext = true;
    assert.doesNotThrow(() => reportCompassViewed('rec-fail', 'item-1'));
    await flush();
    assert.equal(calls.length, 0);
  });
});
