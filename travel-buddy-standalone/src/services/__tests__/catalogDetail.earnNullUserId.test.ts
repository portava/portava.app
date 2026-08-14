/**
 * Catalog detail screen — null user_id in earn history
 *
 * The earn-history section of [catalogId].tsx renders each row as:
 *
 *   {r.user_id != null ? r.user_id.slice(0, 8) + '…' : '—'} — {r.source_type} — date
 *
 * When user_id is null (which CatalogEarnSampleRow allows), the expression
 * must produce a readable placeholder ("—") rather than leaving the prefix
 * blank or rendering "undefined…".
 *
 * Tests:
 *   Suite 1 — pure rendering logic (inline replica of the screen expression):
 *     1. A non-null user_id renders the first 8 chars followed by "…".
 *     2. A null user_id renders "—" (not empty, not "undefined…").
 *     3. A short user_id (fewer than 8 chars) is not truncated beyond its length.
 *     4. An empty-string user_id renders "" + "…" (not "—") — only null triggers the fallback.
 *
 *   Suite 2 — service layer (getAdminCatalogEntry):
 *     5. An earnSample row with user_id null is returned intact from the service.
 *     6. A mixed earnSample (one null, one non-null) is returned intact so the
 *        screen can render both without any silent dropping.
 *     7. An earnSample with all rows having non-null user_id is returned correctly.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx/esm --test \
 *     src/services/__tests__/catalogDetail.earnNullUserId.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { adminGet } from '../adminApi.ts';

// Thin replica of getAdminCatalogEntry — same HTTP contract, no bare imports.
async function getAdminCatalogEntry(id: string) {
  return adminGet<any>(`/api/admin/stamps/catalog/${id}`);
}

// ── Inline replica of the earn-row rendering expression ───────────────────────
// Mirrors [catalogId].tsx earn-history map exactly:
//   {r.user_id != null ? r.user_id.slice(0, 8) + '…' : '—'}

function renderUserPrefix(userId: string | null): string {
  return userId != null ? userId.slice(0, 8) + '…' : '—';
}

// ── Fake Supabase client ───────────────────────────────────────────────────────

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function makeFakeSupabase() {
  return {
    auth: {
      getSession: () =>
        Promise.resolve({
          data: {
            session: {
              access_token: 'test-token-earn-null-user-id',
              expires_at: FAR_FUTURE,
            },
          },
        }),
      refreshSession: () =>
        Promise.resolve({
          data: {
            session: {
              access_token: 'test-token-earn-null-user-id',
              expires_at: FAR_FUTURE,
            },
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

// ── Minimal CatalogDetail fixture with overridable earnSample ─────────────────

function makeCatalogDetail(earnSample: unknown[]): Record<string, unknown> {
  return {
    entry: {
      id: 'cat-1',
      canonical_location_key: 'fr-paris',
      stamp_type: 'city',
      display_name: 'Paris',
      country: 'France',
      country_code: 'FR',
      region: null,
      city: 'Paris',
      neighborhood: null,
      status: 'approved',
      active_version_id: 'ver-1',
      earn_count: 2,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    versions: [],
    queue: null,
    audit: [],
    earnSample,
  };
}

// ── Suite 1: pure rendering logic ─────────────────────────────────────────────

describe('earn-row user prefix — rendering logic', () => {
  it('renders the first 8 chars followed by "…" when user_id is a full UUID', () => {
    const result = renderUserPrefix('abcd1234-5678-90ef-ghij-klmnopqrstuv');
    assert.equal(result, 'abcd1234…');
  });

  it('renders "—" when user_id is null — not blank, not "undefined…"', () => {
    const result = renderUserPrefix(null);
    assert.equal(result, '—');
    assert.notEqual(result, '');
    assert.notEqual(result, 'undefined…');
  });

  it('renders the full string plus "…" when user_id is shorter than 8 chars', () => {
    // slice(0, 8) on a 4-char string returns the 4-char string — not padded.
    const result = renderUserPrefix('abcd');
    assert.equal(result, 'abcd…');
  });

  it('renders "…" (empty prefix + ellipsis) for an empty-string user_id — only null triggers "—"', () => {
    const result = renderUserPrefix('');
    assert.equal(result, '…');
    // Confirm the empty-string path is distinct from the null path.
    assert.notEqual(result, '—');
  });
});

// ── Suite 2: service layer ────────────────────────────────────────────────────

describe('getAdminCatalogEntry — earnSample with null user_id', () => {
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase());
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('returns ok:true and surfaces a null user_id earn row intact', async () => {
    const row = {
      id: 'earn-1',
      user_id: null,
      source_type: 'check_in',
      earned_at: '2025-06-01T12:00:00Z',
    };
    globalThis.fetch = mockFetch(200, makeCatalogDetail([row]));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok=true');
    if (!res.ok) throw new Error('narrowing');
    assert.equal(res.data.earnSample.length, 1);
    assert.equal(res.data.earnSample[0].user_id, null);
    assert.equal(res.data.earnSample[0].source_type, 'check_in');
  });

  it('returns both rows intact when earnSample mixes null and non-null user_ids', async () => {
    const rows = [
      { id: 'earn-1', user_id: null, source_type: 'check_in', earned_at: '2025-06-01T12:00:00Z' },
      { id: 'earn-2', user_id: 'abcd1234-ef56-7890', source_type: 'manual_grant', earned_at: '2025-06-02T09:00:00Z' },
    ];
    globalThis.fetch = mockFetch(200, makeCatalogDetail(rows));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok=true');
    if (!res.ok) throw new Error('narrowing');
    assert.equal(res.data.earnSample.length, 2);
    assert.equal(res.data.earnSample[0].user_id, null);
    assert.equal(res.data.earnSample[1].user_id, 'abcd1234-ef56-7890');
  });

  it('returns ok:true for a normal earnSample where all rows have non-null user_ids', async () => {
    const rows = [
      { id: 'earn-1', user_id: 'aaaabbbb-cccc-dddd', source_type: 'check_in', earned_at: '2025-05-01T08:00:00Z' },
      { id: 'earn-2', user_id: 'eeeeffff-0000-1111', source_type: 'challenge', earned_at: '2025-05-02T10:00:00Z' },
    ];
    globalThis.fetch = mockFetch(200, makeCatalogDetail(rows));
    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok=true');
    if (!res.ok) throw new Error('narrowing');
    assert.equal(res.data.earnSample.length, 2);
    assert.equal(res.data.earnSample[0].user_id, 'aaaabbbb-cccc-dddd');
    assert.equal(res.data.earnSample[1].user_id, 'eeeeffff-0000-1111');
  });
});
