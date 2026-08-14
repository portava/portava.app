/**
 * Catalog detail screen — approved artwork stale-style badge tests
 *
 * The admin stamp detail page ([catalogId].tsx) shows a "Stale style —
 * regenerate recommended" notice in the Active Artwork section when the
 * approved version's prompt_template_version is null or does not match
 * CURRENT_STYLE_VERSION.
 *
 * This file tests the staleness detection logic inline (mirrors the screen
 * condition exactly) plus the service-layer pass-through of the field.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx/esm --test \
 *     src/services/__tests__/catalogDetail.approvedStale.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_STYLE_VERSION } from '../adminStamps.ts';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { adminGet } from '../adminApi.ts';

// Thin replica of getAdminCatalogEntry — same HTTP contract, no bare imports.
async function getAdminCatalogEntry(id: string) {
  return adminGet<any>(`/api/admin/stamps/catalog/${id}`);
}

// ── Inline staleness check (mirrors [catalogId].tsx approved section) ─────────
// The screen renders the approved-stale banner when this is true.

function isApprovedStale(version: { prompt_template_version: string | null }): boolean {
  return (
    version.prompt_template_version == null ||
    version.prompt_template_version !== CURRENT_STYLE_VERSION
  );
}

// ── Fake Supabase / fetch helpers ─────────────────────────────────────────────

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function makeFakeSupabase() {
  return {
    auth: {
      getSession: () =>
        Promise.resolve({
          data: {
            session: { access_token: 'test-token-approved-stale', expires_at: FAR_FUTURE },
          },
        }),
      refreshSession: () =>
        Promise.resolve({
          data: {
            session: { access_token: 'test-token-approved-stale', expires_at: FAR_FUTURE },
          },
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

function makeApprovedVersion(promptTemplateVersion: string | null) {
  return {
    id: 'ver-approved',
    catalog_id: 'cat-1',
    status: 'approved' as const,
    public_url: 'https://example.com/stamp.png',
    generation_source: 'ai_generated' as const,
    provider: 'openai',
    prompt_used: 'a stamp of Tokyo',
    prompt_template_version: promptTemplateVersion,
    rejection_reason: null,
    created_at: '2025-01-01T00:00:00Z',
  };
}

function makeCatalogDetail(approvedVersion: ReturnType<typeof makeApprovedVersion>) {
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
      status: 'approved',
      active_version_id: approvedVersion.id,
      earn_count: 5,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    versions: [approvedVersion],
    queue: null,
    audit: [],
    earnSample: [],
  };
}

// ── Suite 1: isApprovedStale logic ────────────────────────────────────────────

describe('approved artwork stale detection — staleness check logic', () => {
  it('returns true when prompt_template_version is null', () => {
    assert.equal(isApprovedStale({ prompt_template_version: null }), true);
  });

  it('returns true when prompt_template_version is an old version string', () => {
    assert.equal(isApprovedStale({ prompt_template_version: 'v0.9' }), true);
  });

  it('returns true when prompt_template_version is an empty string', () => {
    assert.equal(isApprovedStale({ prompt_template_version: '' }), true);
  });

  it('returns false when prompt_template_version matches CURRENT_STYLE_VERSION', () => {
    assert.equal(isApprovedStale({ prompt_template_version: CURRENT_STYLE_VERSION }), false);
  });

  it('CURRENT_STYLE_VERSION is defined and non-empty', () => {
    assert.ok(typeof CURRENT_STYLE_VERSION === 'string' && CURRENT_STYLE_VERSION.length > 0);
  });
});

// ── Suite 2: service-layer pass-through ───────────────────────────────────────

describe('getAdminCatalogEntry — approved version prompt_template_version pass-through', () => {
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase());
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('surfaces prompt_template_version=null on the approved version — banner should show', async () => {
    const approved = makeApprovedVersion(null);
    globalThis.fetch = mockFetch(200, makeCatalogDetail(approved));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    const ver = res.data.versions.find((v: any) => v.status === 'approved');
    assert.ok(ver, 'approved version must be present');
    assert.equal(ver.prompt_template_version, null);
    assert.equal(isApprovedStale(ver), true);
  });

  it('surfaces an old prompt_template_version on the approved version — banner should show', async () => {
    const approved = makeApprovedVersion('v0.1');
    globalThis.fetch = mockFetch(200, makeCatalogDetail(approved));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    const ver = res.data.versions.find((v: any) => v.status === 'approved');
    assert.ok(ver);
    assert.equal(ver.prompt_template_version, 'v0.1');
    assert.equal(isApprovedStale(ver), true);
  });

  it('surfaces CURRENT_STYLE_VERSION on the approved version — banner should NOT show', async () => {
    const approved = makeApprovedVersion(CURRENT_STYLE_VERSION);
    globalThis.fetch = mockFetch(200, makeCatalogDetail(approved));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('narrowing');
    const ver = res.data.versions.find((v: any) => v.status === 'approved');
    assert.ok(ver);
    assert.equal(ver.prompt_template_version, CURRENT_STYLE_VERSION);
    assert.equal(isApprovedStale(ver), false);
  });
});
