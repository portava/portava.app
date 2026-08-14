/**
 * Malformed audit-entry guard tests
 *
 * Verifies that a missing `created_at` or `action` field in an audit entry
 * returned by the API doesn't crash the CatalogDetail screen.
 *
 * The screen renders audit rows as:
 *   <Text>{a.action}</Text>
 *   <Text>{a.notes ?? ''}</Text>
 *   <Text>{new Date(a.created_at).toLocaleString()}</Text>
 *
 * When `created_at` is absent `new Date(undefined)` yields Invalid Date whose
 * `.toLocaleString()` returns the string "Invalid Date" — no throw, no crash.
 * When `action` is absent React Native Text renders nothing — also no crash.
 *
 * Scenarios covered:
 *   1. getAdminCatalogEntry returns ok:true when the API omits `created_at`
 *   2. Rendering logic for a missing `created_at` produces a safe string (not a throw)
 *   3. Rendering logic for a missing `action` produces a safe value (not a throw)
 *   4. getAdminCatalogEntry returns ok:true when the API omits `action`
 *   5. notes fallback (`?? ''`) works when notes is null or absent
 *
 * Run:
 *   pnpm --dir travel-buddy-standalone test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { getAdminCatalogEntry } from '../adminStamps.ts';

// ── Fake Supabase client ────────────────────────────────────────────────────

function makeFakeSupabase(token: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: token, expires_at: expiresAt } },
      }),
      refreshSession: async () => ({
        data: { session: { access_token: token } },
      }),
    },
  };
}

// ── Screen rendering helpers (mirror what [catalogId].tsx does) ─────────────
//
// These extract the pure-JS side of the render so we can assert on them in a
// node:test environment without React Native.

/** Reproduces: new Date(a.created_at).toLocaleString() */
function renderAuditDate(created_at: unknown): string {
  return new Date(created_at as any).toLocaleString();
}

/** Reproduces: a.notes ?? '' */
function renderAuditNotes(notes: unknown): string {
  return (notes as any) ?? '';
}

/** Reproduces: a.action (rendered directly in Text — undefined is safe in JSX) */
function renderAuditAction(action: unknown): unknown {
  return action;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

function makeDetailResponse(auditOverrides: Record<string, unknown>[]) {
  return {
    entry: {
      id: 'cat-1',
      canonical_location_key: 'fr__paris',
      stamp_type: 'city',
      display_name: 'Paris',
      country: 'France',
      country_code: 'FR',
      region: null,
      city: 'Paris',
      neighborhood: null,
      status: 'approved',
      active_version_id: null,
      earn_count: 5,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    },
    versions: [],
    queue: null,
    earnSample: [],
    audit: auditOverrides,
  };
}

// ── Suite 1: missing created_at ─────────────────────────────────────────────

describe('CatalogDetail audit — missing created_at', () => {
  let savedFetch: typeof fetch;

  before(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase('fake-admin-token'));
  });

  after(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('getAdminCatalogEntry resolves ok:true even when audit entry omits created_at', async () => {
    const malformedAudit = [{ id: 'a1', action: 'approved', notes: null /* no created_at */ }];
    globalThis.fetch = mockFetch(200, makeDetailResponse(malformedAudit));

    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok:true when audit entry has no created_at');
    assert.ok(res.ok, 'type guard');
    const audit = res.data.audit;
    assert.equal(audit.length, 1, 'audit array should pass through with one entry');
    assert.equal((audit[0] as any).created_at, undefined, 'created_at should be absent on the returned entry');
  });

  it('renderAuditDate(undefined) returns a string without throwing', () => {
    // This is what the screen does: new Date(a.created_at).toLocaleString()
    // With undefined it yields "Invalid Date" — a safe string, not a crash.
    let result: string;
    assert.doesNotThrow(() => {
      result = renderAuditDate(undefined);
    }, 'new Date(undefined).toLocaleString() must not throw');
    assert.equal(typeof result!, 'string', 'result must be a string');
  });

  it('renderAuditDate(null) returns a string without throwing', () => {
    let result: string;
    assert.doesNotThrow(() => {
      result = renderAuditDate(null);
    }, 'new Date(null).toLocaleString() must not throw');
    assert.equal(typeof result!, 'string', 'result must be a string');
  });

  it('renderAuditDate with a valid ISO string returns a non-empty string', () => {
    const result = renderAuditDate('2024-06-15T12:00:00Z');
    assert.ok(result.length > 0, 'valid created_at should produce a non-empty date string');
  });
});

// ── Suite 2: missing action ──────────────────────────────────────────────────

describe('CatalogDetail audit — missing action', () => {
  let savedFetch: typeof fetch;

  before(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase('fake-admin-token'));
  });

  after(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('getAdminCatalogEntry resolves ok:true even when audit entry omits action', async () => {
    const malformedAudit = [{ id: 'a2', created_at: '2024-01-01T00:00:00Z', notes: 'some note' /* no action */ }];
    globalThis.fetch = mockFetch(200, makeDetailResponse(malformedAudit));

    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok:true when audit entry has no action');
    assert.ok(res.ok, 'type guard');
    const audit = res.data.audit;
    assert.equal(audit.length, 1, 'audit array should pass through with one entry');
    assert.equal((audit[0] as any).action, undefined, 'action should be absent on the returned entry');
  });

  it('renderAuditAction(undefined) returns undefined — safe in React Native Text', () => {
    // React Native <Text>{undefined}</Text> renders nothing, not a crash.
    const result = renderAuditAction(undefined);
    assert.equal(result, undefined, 'undefined action is safe for React Native Text');
  });

  it('renderAuditAction(null) returns null — safe in React Native Text', () => {
    const result = renderAuditAction(null);
    assert.equal(result, null, 'null action is safe for React Native Text');
  });
});

// ── Suite 3: notes fallback ──────────────────────────────────────────────────

describe('CatalogDetail audit — notes fallback', () => {
  it('renderAuditNotes(null) returns empty string via ?? operator', () => {
    assert.equal(renderAuditNotes(null), '', "null notes should fall back to ''");
  });

  it('renderAuditNotes(undefined) returns empty string via ?? operator', () => {
    assert.equal(renderAuditNotes(undefined), '', "undefined notes should fall back to ''");
  });

  it('renderAuditNotes with a real string returns the string unchanged', () => {
    assert.equal(renderAuditNotes('Approved by admin'), 'Approved by admin');
  });
});

// ── Suite 4: both fields missing simultaneously ──────────────────────────────

describe('CatalogDetail audit — both created_at and action missing', () => {
  let savedFetch: typeof fetch;

  before(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase('fake-admin-token'));
  });

  after(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('getAdminCatalogEntry resolves ok:true for a fully-malformed audit entry', async () => {
    const malformedAudit = [{ id: 'a3', notes: null /* no action, no created_at */ }];
    globalThis.fetch = mockFetch(200, makeDetailResponse(malformedAudit));

    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok:true for a fully-malformed audit entry');
    assert.ok(res.ok, 'type guard');
    assert.equal(res.data.audit.length, 1);
  });

  it('all three render helpers tolerate a fully-malformed entry without throwing', () => {
    const malformed: any = { id: 'a3', notes: null };
    assert.doesNotThrow(() => renderAuditDate(malformed.created_at));
    assert.doesNotThrow(() => renderAuditNotes(malformed.notes));
    assert.doesNotThrow(() => renderAuditAction(malformed.action));
  });
});
