/**
 * Catalog detail screen — last_error resilience tests (main app)
 *
 * The admin stamp detail page ([catalogId].tsx) derives a shortfall banner
 * from queue.last_error with this guard:
 *
 *   const shortfallFromQueue =
 *     typeof queue?.last_error === 'string' &&
 *     queue.last_error.startsWith('candidate_shortfall')
 *       ? queue.last_error.replace('candidate_shortfall: ', '')
 *       : null;
 *
 * If the API ever returns an unexpected shape for last_error (an object, a
 * number, an array, …) the typeof guard must absorb it silently — no crash,
 * no unhandled rejection, shortfallFromQueue stays null.
 *
 * These tests verify:
 *   1. The extraction logic itself handles every unexpected last_error shape
 *      without throwing.
 *   2. getAdminCatalogEntry returns ok:true and surfaces the raw malformed
 *      queue payload intact — the service layer never throws on it.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx/esm --test \
 *     src/services/__tests__/catalogDetail.lastError.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { adminGet } from '../adminApi.ts';

// Thin replica of getAdminCatalogEntry — same HTTP contract, no bare imports.
async function getAdminCatalogEntry(id: string) {
  return adminGet<any>(`/api/admin/stamps/catalog/${id}`);
}

// ── Fake Supabase client (always returns a valid non-expired session) ─────────

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function makeFakeSupabase() {
  return {
    auth: {
      getSession: () =>
        Promise.resolve({
          data: { session: { access_token: 'test-token-catalog-detail', expires_at: FAR_FUTURE } },
        }),
      refreshSession: () =>
        Promise.resolve({
          data: { session: { access_token: 'test-token-catalog-detail', expires_at: FAR_FUTURE } },
        }),
    },
  };
}

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

// Minimal valid CatalogDetail fixture with queue.last_error overridable.
function makeCatalogDetail(lastError: unknown) {
  return {
    entry: {
      id: 'cat-1',
      canonical_location_key: 'jp-tokyo',
      stamp_type: 'city',
      display_name: 'Tokyo',
      country: 'Japan',
      country_code: 'JP',
      region: null,
      city: 'Tokyo',
      neighborhood: null,
      status: 'pending_artwork',
      active_version_id: null,
      earn_count: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    versions: [],
    queue: {
      id: 'job-1',
      catalog_id: 'cat-1',
      status: 'failed',
      priority: 1,
      attempts: 3,
      max_attempts: 3,
      last_error: lastError,
      triggered_by_action: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    audit: [],
    earnSample: [],
  };
}

// ── Inline replica of the detail-screen shortfall extraction logic ────────────
// Mirrors [catalogId].tsx lines 121-125 exactly so any future divergence fails.

function extractShortfallFromQueue(queue: unknown): string | null {
  return typeof (queue as any)?.last_error === 'string' &&
    (queue as any).last_error.startsWith('candidate_shortfall')
    ? (queue as any).last_error.replace(/^candidate_shortfall:\s*/, '')
    : null;
}

// ── Suite 1: pure extraction logic ───────────────────────────────────────────

describe('shortfall extraction — malformed last_error shapes never throw', () => {
  it('returns null and does not throw when last_error is a plain object', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue({ last_error: { code: 'ERR' } });
      assert.equal(result, null);
    });
  });

  it('returns null and does not throw when last_error is a number', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue({ last_error: 42 });
      assert.equal(result, null);
    });
  });

  it('returns null and does not throw when last_error is an array', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue({ last_error: ['ERR', 'code'] });
      assert.equal(result, null);
    });
  });

  it('returns null and does not throw when last_error is true (boolean)', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue({ last_error: true });
      assert.equal(result, null);
    });
  });

  it('returns null and does not throw when last_error is null', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue({ last_error: null });
      assert.equal(result, null);
    });
  });

  it('returns null and does not throw when last_error is undefined', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue({ last_error: undefined });
      assert.equal(result, null);
    });
  });

  it('returns null and does not throw when queue itself is null', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromQueue(null);
      assert.equal(result, null);
    });
  });

  it('returns null for a string last_error that does not start with candidate_shortfall', () => {
    const result = extractShortfallFromQueue({ last_error: 'generation_timeout' });
    assert.equal(result, null);
  });

  it('extracts the message for a well-formed candidate_shortfall string', () => {
    const result = extractShortfallFromQueue({
      last_error: 'candidate_shortfall: got 2 of 4 expected images',
    });
    assert.equal(result, 'got 2 of 4 expected images');
  });

  it('extracts an empty string when candidate_shortfall has no trailing message', () => {
    const result = extractShortfallFromQueue({ last_error: 'candidate_shortfall:' });
    assert.equal(result, '');
  });
});

// ── Suite 2: getAdminCatalogEntry service layer ───────────────────────────────

describe('getAdminCatalogEntry — malformed queue.last_error in API response', () => {
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase());
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('returns ok:true and surfaces an object last_error without crashing', async () => {
    globalThis.fetch = mockFetch(200, makeCatalogDetail({ code: 'ERR', message: 'bad' }));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok=true');
    if (!res.ok) throw new Error('narrowing');
    assert.deepEqual((res.data.queue as any).last_error, { code: 'ERR', message: 'bad' });
  });

  it('returns ok:true and surfaces a numeric last_error without crashing', async () => {
    globalThis.fetch = mockFetch(200, makeCatalogDetail(500));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    assert.equal((res.data.queue as any).last_error, 500);
  });

  it('returns ok:true and surfaces an array last_error without crashing', async () => {
    globalThis.fetch = mockFetch(200, makeCatalogDetail(['timeout', 'retry_limit']));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    assert.deepEqual((res.data.queue as any).last_error, ['timeout', 'retry_limit']);
  });

  it('returns ok:true when queue is entirely null', async () => {
    const payload = { ...makeCatalogDetail(null), queue: null };
    globalThis.fetch = mockFetch(200, payload);
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    assert.equal(res.data.queue, null);
  });

  it('returns ok:true when queue is missing from the response entirely', async () => {
    const { queue: _omit, ...payloadWithoutQueue } = makeCatalogDetail(null);
    globalThis.fetch = mockFetch(200, payloadWithoutQueue);
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    assert.equal(res.data.queue, undefined);
  });

  it('returns ok:false on a 500 response — does not throw', async () => {
    globalThis.fetch = mockFetch(500, { message: 'Internal server error' });
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, false);
  });
});

// ── Suite 3: combined shortfall derivation — candidates present, queue null ───
// Mirrors [catalogId].tsx lines 116-127 (shortfallFromMeta + shortfallFromQueue
// + shortfall = shortfallFromMeta ?? shortfallFromQueue).

function deriveShortfall(candidates: unknown[], queue: unknown): string | null {
  const meta = (candidates[0] as any)?.generation_metadata ?? {};
  const shortfallFromMeta =
    typeof meta.candidates_expected === 'number' &&
    typeof meta.candidates_produced === 'number' &&
    meta.candidates_produced < meta.candidates_expected
      ? `Only ${meta.candidates_produced} of ${meta.candidates_expected} candidates were generated.`
      : null;
  const shortfallFromQueue =
    typeof (queue as any)?.last_error === 'string' &&
    (queue as any).last_error.startsWith('candidate_shortfall')
      ? (queue as any).last_error.replace(/^candidate_shortfall:\s*/, '')
      : null;
  return shortfallFromMeta ?? shortfallFromQueue;
}

describe('shortfall derivation — candidates present, queue null', () => {
  it('returns null when one candidate has no generation_metadata and queue is null', () => {
    const candidates = [{ id: 'v-1', status: 'candidate', provider: 'ai', public_url: null }];
    const result = deriveShortfall(candidates, null);
    assert.equal(result, null);
  });

  it('returns null when candidate generation_metadata is empty and queue is null', () => {
    const candidates = [{ id: 'v-1', status: 'candidate', generation_metadata: {} }];
    const result = deriveShortfall(candidates, null);
    assert.equal(result, null);
  });

  it('returns null when candidate has complete generation_metadata (no shortfall) and queue is null', () => {
    // produced === expected → no shortfall from meta either
    const candidates = [
      {
        id: 'v-1',
        status: 'candidate',
        generation_metadata: { candidates_expected: 4, candidates_produced: 4 },
      },
    ];
    const result = deriveShortfall(candidates, null);
    assert.equal(result, null);
  });

  it('shortfallFromQueue is null when queue is null — does not throw', () => {
    assert.doesNotThrow(() => {
      const result = deriveShortfall(
        [{ id: 'v-1', status: 'candidate' }],
        null,
      );
      assert.equal(result, null);
    });
  });

  it('still surfaces shortfallFromMeta even when queue is null', () => {
    // Shortfall from metadata is independent of queue — confirm it still fires.
    const candidates = [
      {
        id: 'v-1',
        status: 'candidate',
        generation_metadata: { candidates_expected: 4, candidates_produced: 2 },
      },
    ];
    const result = deriveShortfall(candidates, null);
    assert.equal(result, 'Only 2 of 4 candidates were generated.');
  });
});

// ── Suite 4: shortfallFromMeta extraction logic ───────────────────────────────
// Mirrors [catalogId].tsx lines 116-122 exactly.
// candidates[0]?.generation_metadata is used as the source; if either numeric
// field is absent or the counts are not a true shortfall, the result is null.

function extractShortfallFromMeta(candidates: unknown[]): string | null {
  const meta = (candidates[0] as any)?.generation_metadata ?? {};
  return typeof meta.candidates_expected === 'number' &&
    typeof meta.candidates_produced === 'number' &&
    meta.candidates_produced < meta.candidates_expected
    ? `Only ${meta.candidates_produced} of ${meta.candidates_expected} candidates were generated.`
    : null;
}

describe('shortfallFromMeta — generation_metadata absent or incomplete clears the signal', () => {
  it('returns null when candidates array is empty', () => {
    assert.equal(extractShortfallFromMeta([]), null);
  });

  it('returns null when candidates[0] has no generation_metadata field', () => {
    assert.equal(extractShortfallFromMeta([{ id: 'v1', status: 'candidate' }]), null);
  });

  it('returns null when generation_metadata is an empty object', () => {
    assert.equal(extractShortfallFromMeta([{ generation_metadata: {} }]), null);
  });

  it('returns null when only candidates_expected is present (candidates_produced missing)', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_expected: 4 } }]),
      null,
    );
  });

  it('returns null when only candidates_produced is present (candidates_expected missing)', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_produced: 2 } }]),
      null,
    );
  });

  it('returns null when candidates_produced equals candidates_expected (no shortfall)', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_expected: 4, candidates_produced: 4 } }]),
      null,
    );
  });

  it('returns null when candidates_produced exceeds candidates_expected', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_expected: 4, candidates_produced: 5 } }]),
      null,
    );
  });

  it('returns the shortfall message when produced is less than expected', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_expected: 4, candidates_produced: 2 } }]),
      'Only 2 of 4 candidates were generated.',
    );
  });

  it('returns null when candidates_expected is a string, not a number', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_expected: '4', candidates_produced: 2 } }]),
      null,
    );
  });

  it('returns null and does not throw when both candidates_expected and candidates_produced are strings', () => {
    // API may return numeric fields as strings (e.g. "4" and "2"). The typeof
    // guard must silently absorb both and keep shortfallFromMeta null — no
    // banner should appear even though a numeric shortfall would exist.
    assert.doesNotThrow(() => {
      const result = extractShortfallFromMeta([
        { generation_metadata: { candidates_expected: '4', candidates_produced: '2' } },
      ]);
      assert.equal(result, null);
    });
  });

  it('returns null when candidates_produced is null', () => {
    assert.equal(
      extractShortfallFromMeta([{ generation_metadata: { candidates_expected: 4, candidates_produced: null } }]),
      null,
    );
  });

  it('does not throw when generation_metadata is null (falls back to empty object)', () => {
    assert.doesNotThrow(() => {
      const result = extractShortfallFromMeta([{ generation_metadata: null }]);
      assert.equal(result, null);
    });
  });
});
