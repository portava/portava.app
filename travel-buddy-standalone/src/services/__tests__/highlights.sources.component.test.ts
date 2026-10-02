/**
 * §12 / §3.6 — what a Highlight is built from, on the client.
 *
 * Highlights/Memories Development Architecture Spec v1 §12 ("Highlights are
 * disposable, audience-specific projections over Memories and Episodes") and
 * §4 (TruthLevel). Census H93.
 *
 * WHAT WAS MISSING. Migration 2722 (`highlight_sources`) is applied on
 * production — `artifacts/api-server/src/lib/capability/production-applied-
 * migrations.json` lists it — `POST /highlights` has accepted `sourceMemoryIds`
 * and `GET /highlights/:id/sources` has served provenance, and NOTHING in this
 * client sent the field or read the route. A repository-wide grep for
 * `sources` across `src/` and `app/` returned two unrelated hits. So every
 * Highlight this app could create was sourceless by construction, and the
 * question "what is this built from" was unaskable rather than merely
 * unanswered.
 *
 * WHAT THIS SUITE PINS:
 *   - the create sends `sourceMemoryIds` when there are some, and OMITS the
 *     field when there are none. `[]` is a claim ("projects nothing") and
 *     absent is a different one ("this is a Stories-style post"); the server
 *     schema treats them alike today and the client must not be the reason
 *     they stop being distinguishable.
 *   - a 200 with an empty list is the §12 FINDING — sourceless — and is the
 *     only case allowed to read as one;
 *   - a refusal is a refusal. `feature_disabled` (2722 absent on THAT
 *     deployment) survives as itself and is never flattened to `db_error`,
 *     because one of those is worth retrying and the other never will be;
 *   - `sourceMemoryIds` on a Highlight that came from a read which does not
 *     project it stays `undefined`, not `[]`. §28.11.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — lib/supabase builds a real client from env
// at import time. Only the configured flag is read by the code under test.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: null,
}));

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import {
  fetchHighlightSources,
  createHighlight,
  fetchActiveHighlights,
} from '../highlights.ts';

const HID = '44444444-4444-4444-8444-444444444444';
const M1 = '55555555-5555-4555-8555-555555555551';
const M2 = '55555555-5555-4555-8555-555555555552';

function capture(reply: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: any }> = [];
  global.fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  }) as unknown as typeof fetch;
  return calls;
}

describe('§12 provenance — reading it', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  it('carries each source and its §4 truth level through', async () => {
    capture({
      ok: true,
      status: 200,
      body: {
        highlightId: HID,
        sources: [
          { sourceType: 'MEMORY', sourceId: M1, provenance: 'USER_ASSERTED', createdAt: '2026-09-01T00:00:00.000Z' },
          { sourceType: 'MEMORY', sourceId: M2, provenance: 'INFERRED', createdAt: null },
        ],
      },
    });

    const r = await fetchHighlightSources(HID);

    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
    // §4's precedence is the point of the column. Two sources, two claims.
    expect(r.data?.[0].provenance).toBe('USER_ASSERTED');
    expect(r.data?.[1].provenance).toBe('INFERRED');
    expect(r.data?.[1].createdAt).toBeNull();
  });

  it('treats a 200 with an empty list as SOURCELESS, which is the H93 finding', async () => {
    capture({ ok: true, status: 200, body: { highlightId: HID, sources: [] } });

    const r = await fetchHighlightSources(HID);

    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('keeps `feature_disabled` as itself — 2722 absent is never worth a retry', async () => {
    capture({
      ok: false,
      status: 403,
      body: { error: 'feature_disabled', message: 'Highlight sources are not available on this deployment yet.' },
    });

    const r = await fetchHighlightSources(HID);

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('feature_disabled');
    expect(r.data).toBeNull();
  });

  it('keeps `degraded_unavailable` as itself, and does NOT answer with an empty list', async () => {
    capture({ ok: false, status: 503, body: { error: 'degraded_unavailable', message: 'try again' } });

    const r = await fetchHighlightSources(HID);

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('degraded_unavailable');
    // The distinction this whole row turns on: a failed read is not "sourceless".
    expect(r.data).toBeNull();
  });

  it('reports an unreachable network as such', async () => {
    global.fetch = jest.fn(async () => { throw new Error('Network request failed'); }) as unknown as typeof fetch;

    const r = await fetchHighlightSources(HID);

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('network_unreachable');
  });
});

describe('§12 provenance — writing it', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  it('sends sourceMemoryIds when the caller names sources', async () => {
    const calls = capture({
      ok: true, status: 201,
      body: { id: HID, owner_id: 'me', media_url: 'u', media_type: 'image/jpeg', sourceMemoryIds: [M1] },
    });

    const r = await createHighlight({ mediaUrl: 'u', mediaType: 'image/jpeg', sourceMemoryIds: [M1] });

    expect(r.ok).toBe(true);
    expect(JSON.parse(calls[0].init.body).sourceMemoryIds).toEqual([M1]);
    expect(r.data?.sourceMemoryIds).toEqual([M1]);
  });

  it('OMITS the field entirely when no source is named', async () => {
    const calls = capture({
      ok: true, status: 201,
      body: { id: HID, owner_id: 'me', media_url: 'u', media_type: 'image/jpeg', sourceMemoryIds: [] },
    });

    await createHighlight({ mediaUrl: 'u', mediaType: 'image/jpeg' });

    // Not `sourceMemoryIds: []`. See this file's header on why the two differ.
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('sourceMemoryIds');
  });

  it('omits it for an explicitly empty array too', async () => {
    const calls = capture({
      ok: true, status: 201,
      body: { id: HID, owner_id: 'me', media_url: 'u', media_type: 'image/jpeg', sourceMemoryIds: [] },
    });

    await createHighlight({ mediaUrl: 'u', mediaType: 'image/jpeg', sourceMemoryIds: [] });

    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('sourceMemoryIds');
  });

  it('leaves sourceMemoryIds UNDEFINED on a read that does not project it', async () => {
    capture({
      ok: true, status: 200,
      body: { highlights: [{ id: HID, owner_id: 'me', media_url: 'u', media_type: 'image/jpeg' }] },
    });

    const r = await fetchActiveHighlights();

    expect(r.ok).toBe(true);
    // `[]` here would print "built from nothing" over every Highlight in the
    // app on the strength of a field nobody sent.
    expect(r.data?.[0].sourceMemoryIds).toBeUndefined();
  });
});

/**
 * §4 / §5 — the class and lifecycle fields the server already serves.
 *
 * `routes/highlights.ts:161#describeLifetimeFields` puts `lifetimeClass`,
 * `lifetimeProvenance`, `lifecycleState` and `lifecycleProvenance` on the
 * profile read (`:1103`) and the active feed (`:1353`). `mapHighlight` carried
 * `pinnedAt` and DROPPED the other four, so the client could not tell a
 * Highlight with no class from one on a build that cannot store a class —
 * census H21 / H31's own distinction, lost one layer above the wire.
 *
 * The whole point is the THREE answers, so all three are pinned.
 */
describe('§4 / §5 class and lifecycle fields', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  function row(extra: Record<string, unknown>) {
    return { id: HID, owner_id: 'me', media_url: 'u', media_type: 'image/jpeg', ...extra };
  }

  it('carries a stored class and a derived lifecycle state through', async () => {
    capture({
      ok: true, status: 200,
      body: {
        highlights: [row({
          lifetimeClass: 'TRIP', lifetimeProvenance: 'stored',
          lifecycleState: 'PINNED', lifecycleProvenance: 'derived',
          pinnedAt: '2026-09-10T00:00:00.000Z',
        })],
      },
    });

    const r = await fetchActiveHighlights();
    const h = r.data?.[0];

    expect(h?.lifetimeClass).toBe('TRIP');
    expect(h?.lifetimeProvenance).toBe('stored');
    expect(h?.lifecycleState).toBe('PINNED');
    // `derived`, not `stored`: nothing in the API server writes lifecycle_state,
    // and a surface that said "stored" would claim a write that never happened.
    expect(h?.lifecycleProvenance).toBe('derived');
  });

  it('keeps "no class assigned" distinct from "this build cannot say"', async () => {
    capture({
      ok: true, status: 200,
      body: {
        highlights: [row({
          lifetimeClass: null, lifetimeProvenance: 'unavailable',
          lifecycleState: null, lifecycleProvenance: 'unavailable',
        })],
      },
    });

    const r = await fetchActiveHighlights();
    const h = r.data?.[0];

    // The columns WERE projected and the server said it cannot report a class.
    expect(h?.lifetimeClass).toBeNull();
    expect(h?.lifetimeProvenance).toBe('unavailable');
  });

  it('leaves every class field UNDEFINED when the read did not project them', async () => {
    // `GET /highlights/archived` and `GET /highlights/following-feed` do not
    // run `describeLifetimeFields` at all — they emit raw rows — so this is the
    // live shape on two of the four read surfaces, not a hypothetical.
    capture({ ok: true, status: 200, body: { highlights: [row({ lifetime_class: 'TRIP' })] } });

    const r = await fetchActiveHighlights();
    const h = r.data?.[0];

    // NOT `null`, and deliberately NOT read off the snake_case column either:
    // without `lifetimeProvenance` the client cannot tell a stored class from
    // an invalid one, and reimplementing `describeHighlightLifetime` here would
    // be a second copy of a vocabulary the server owns.
    expect(h?.lifetimeClass).toBeUndefined();
    expect(h?.lifetimeProvenance).toBeUndefined();
    expect(h?.lifecycleState).toBeUndefined();
    expect(h?.lifecycleProvenance).toBeUndefined();
  });
});
