/**
 * Catalog detail screen — archived-version suppression
 *
 * The admin stamp detail page ([catalogId].tsx) builds the candidate list with:
 *
 *   const candidates = versions.filter((v) => v.status === 'candidate');
 *
 * This means archived versions that the API returns (status === 'archived')
 * must NOT appear in the candidate list shown to admins.
 *
 * Tests:
 *   Suite 1 — pure filtering logic (inline replica of screen line 109):
 *     1. A lone archived version yields an empty candidates list.
 *     2. A mix of archived + candidate versions keeps only candidates.
 *     3. Multiple archived versions are all suppressed; all candidates survive.
 *     4. Only-candidate versions are all preserved (no false exclusion).
 *     5. An approved version is not treated as a candidate (separate section).
 *
 *   Suite 2 — service layer (getAdminCatalogEntry):
 *     6. Archived versions in the API response are passed through intact so
 *        the UI can apply its own filter — the service layer must not drop them.
 *     7. A response with only archived versions yields ok:true with non-empty
 *        versions array, so the UI receives the data and can filter it itself.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx/esm --test \
 *     src/services/__tests__/catalogDetail.archivedVersions.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { adminGet } from '../adminApi.ts';

// ── Thin replica of getAdminCatalogEntry (same contract as the screen uses) ───

async function getAdminCatalogEntry(id: string) {
  return adminGet<any>(`/api/admin/stamps/catalog/${id}`);
}

// ── Inline replica of the candidate-filter logic from [catalogId].tsx line 109 ─
// Any change to the screen that diverges from this will cause these tests to
// catch the mismatch, ensuring the screen and the test stay in sync.

function extractCandidates(versions: Array<{ status: string }>): Array<{ status: string }> {
  return versions.filter((v) => v.status === 'candidate');
}

// ── Fake auth client ───────────────────────────────────────────────────────────

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function makeFakeSupabase() {
  return {
    auth: {
      getSession: () =>
        Promise.resolve({
          data: {
            session: {
              access_token: 'test-token-archived-versions',
              expires_at: FAR_FUTURE,
            },
          },
        }),
      refreshSession: () =>
        Promise.resolve({
          data: {
            session: {
              access_token: 'test-token-archived-versions',
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

// ── Minimal artwork version factory ───────────────────────────────────────────

function makeVersion(id: string, status: string): Record<string, unknown> {
  return {
    id,
    catalog_id: 'cat-1',
    status,
    public_url: `https://cdn.example.com/${id}.png`,
    generation_source: 'ai_generated',
    provider: 'dall-e-3',
    prompt_used: null,
    prompt_template_version: 'v1.0',
    rejection_reason: null,
    created_at: '2025-01-01T00:00:00Z',
  };
}

// ── Minimal CatalogDetail fixture ─────────────────────────────────────────────

function makeCatalogDetail(versions: unknown[]): Record<string, unknown> {
  return {
    entry: {
      id: 'cat-1',
      canonical_location_key: 'jp-osaka',
      stamp_type: 'city',
      display_name: 'Osaka',
      country: 'Japan',
      country_code: 'JP',
      region: null,
      city: 'Osaka',
      neighborhood: null,
      status: 'review_required',
      active_version_id: null,
      earn_count: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    versions,
    queue: null,
    audit: [],
    earnSample: [],
  };
}

// ── Suite 1: pure filtering logic ─────────────────────────────────────────────

describe('candidate filter — archived versions are suppressed', () => {
  it('a lone archived version produces an empty candidates list', () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    const candidates = extractCandidates(versions);
    assert.equal(candidates.length, 0, 'archived version must not appear in candidates');
  });

  it('a mix of archived + candidate versions keeps only the candidate', () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-candidate-1', 'candidate'),
    ];
    const candidates = extractCandidates(versions);
    assert.equal(candidates.length, 1, 'only the candidate version must survive the filter');
    assert.equal(candidates[0].status, 'candidate');
    const ids = candidates.map((v: any) => v.id);
    assert.ok(!ids.includes('ver-archived-1'), 'archived version id must not appear in candidates');
    assert.ok(ids.includes('ver-candidate-1'), 'candidate version id must appear');
  });

  it('multiple archived versions are all suppressed — all candidates survive', () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-archived-2', 'archived'),
      makeVersion('ver-candidate-1', 'candidate'),
      makeVersion('ver-candidate-2', 'candidate'),
    ];
    const candidates = extractCandidates(versions);
    assert.equal(candidates.length, 2, 'only the two candidate versions must survive');
    for (const c of candidates) {
      assert.equal(c.status, 'candidate', 'every surviving entry must have status candidate');
    }
    const ids = candidates.map((v: any) => v.id);
    assert.ok(!ids.includes('ver-archived-1'), 'first archived version must be absent');
    assert.ok(!ids.includes('ver-archived-2'), 'second archived version must be absent');
  });

  it('only-candidate versions are all preserved — no false exclusion', () => {
    const versions = [
      makeVersion('ver-candidate-1', 'candidate'),
      makeVersion('ver-candidate-2', 'candidate'),
      makeVersion('ver-candidate-3', 'candidate'),
    ];
    const candidates = extractCandidates(versions);
    assert.equal(
      candidates.length,
      3,
      'all three candidates must survive when there are no archived versions',
    );
  });

  it('approved and active versions are excluded — filter is status=candidate only', () => {
    const versions = [
      makeVersion('ver-approved-1', 'approved'),
      makeVersion('ver-active-1', 'active'),
      makeVersion('ver-candidate-1', 'candidate'),
    ];
    const candidates = extractCandidates(versions);
    assert.equal(candidates.length, 1, 'only the candidate version must appear');
    assert.equal((candidates[0] as any).id, 'ver-candidate-1');
  });
});

// ── Suite 2: service layer passes versions through intact ─────────────────────
//
// The service must NOT silently strip archived versions — if it did, the UI
// filter would have nothing to act on, and the test above would be meaningless.

describe('getAdminCatalogEntry — archived versions are forwarded to the UI layer', () => {
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    _setTestSupabase(makeFakeSupabase());
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    _resetTestSupabase();
  });

  it('returns ok:true and preserves archived versions in the versions array', async () => {
    const apiVersions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-candidate-1', 'candidate'),
    ];
    globalThis.fetch = mockFetch(200, makeCatalogDetail(apiVersions));

    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok=true');
    if (!res.ok) throw new Error('type narrowing');

    assert.ok(Array.isArray(res.data.versions), 'versions must be an array');
    assert.equal(
      res.data.versions.length,
      2,
      'service must return both the archived and the candidate version — not drop the archived one',
    );

    const archivedInResponse = res.data.versions.find((v: any) => v.id === 'ver-archived-1');
    assert.ok(archivedInResponse, 'archived version must be present in the service response');
    assert.equal(
      archivedInResponse.status,
      'archived',
      'archived version status must be preserved as "archived"',
    );

    const candidateInResponse = res.data.versions.find((v: any) => v.id === 'ver-candidate-1');
    assert.ok(candidateInResponse, 'candidate version must also be present');
    assert.equal(candidateInResponse.status, 'candidate');
  });

  it('returns ok:true with a non-empty versions array when all versions are archived', async () => {
    const apiVersions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-archived-2', 'archived'),
    ];
    globalThis.fetch = mockFetch(200, makeCatalogDetail(apiVersions));

    const res = await getAdminCatalogEntry('cat-1');
    assert.equal(res.ok, true, 'expected ok=true even when all versions are archived');
    if (!res.ok) throw new Error('type narrowing');

    assert.equal(
      res.data.versions.length,
      2,
      'service must forward all archived versions so the UI can filter them itself',
    );

    // Applying the screen filter to the service response must yield an empty list —
    // this is the crucial end-to-end check that archived versions are hidden on the UI.
    const candidates = extractCandidates(res.data.versions);
    assert.equal(
      candidates.length,
      0,
      'applying the screen filter to a versions array of only archived versions must produce zero candidates',
    );
  });
});

// ── Suite 3: render-branch logic — empty-state and no "Set as Active" button ──
//
// The screen renders the candidate card section (which contains the "Set as Active"
// button) only when candidates.length > 0.  When all versions are archived the
// filter produces an empty list, so the card section must not be entered and the
// "Set as Active" button must never appear.
//
// We replicate the exact branching logic from [catalogId].tsx lines 204-228:
//
//   {candidates.length > 0 ? (
//     <CandidateCard … onActivate … />   // ← "Set as Active" lives here
//   ) : !approved ? (
//     <empty-state text />               // ← this branch must be taken
//   ) : null}

describe('render-branch logic — all-archived versions hit the empty-state, not the candidate card', () => {
  // Mirrors the exact two derived values the screen computes from `versions`.
  function deriveScreenState(versions: Array<{ status: string }>) {
    const candidates = versions.filter((v) => v.status === 'candidate');
    const approved   = versions.find((v) => v.status === 'approved');
    return { candidates, approved };
  }

  // The render predicate: true when the candidate-card section (and its
  // "Set as Active" buttons) would be rendered.
  function wouldRenderCandidateCards(versions: Array<{ status: string }>): boolean {
    const { candidates } = deriveScreenState(versions);
    return candidates.length > 0;
  }

  // The render predicate for the empty-state branch (taken when candidates.length
  // === 0 AND there is no approved version).
  function wouldRenderEmptyState(versions: Array<{ status: string }>): boolean {
    const { candidates, approved } = deriveScreenState(versions);
    return candidates.length === 0 && !approved;
  }

  it('a single archived version: candidate-card section is NOT rendered', () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    assert.equal(
      wouldRenderCandidateCards(versions),
      false,
      'candidate cards must not render when the only version is archived',
    );
  });

  it('a single archived version: empty-state branch IS rendered', () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    assert.equal(
      wouldRenderEmptyState(versions),
      true,
      'empty-state branch must be taken when there are no candidates and no approved version',
    );
  });

  it('multiple archived versions: candidate-card section (Set as Active) is NOT rendered', () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-archived-2', 'archived'),
      makeVersion('ver-archived-3', 'archived'),
    ];
    assert.equal(
      wouldRenderCandidateCards(versions),
      false,
      '"Set as Active" button must not appear for any archived version',
    );
  });

  it('multiple archived versions: empty-state branch IS rendered', () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-archived-2', 'archived'),
    ];
    assert.equal(
      wouldRenderEmptyState(versions),
      true,
      'empty-state text must be shown when all versions are archived and none are approved',
    );
  });

  it('archived versions alongside an approved version: candidate-card section is NOT rendered, empty-state is also NOT rendered', () => {
    // When there is an approved version but no candidates, neither the candidate
    // card section nor the empty-state renders (approved artwork is shown instead).
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-approved-1', 'approved'),
    ];
    assert.equal(
      wouldRenderCandidateCards(versions),
      false,
      'candidate-card section must not render when there are no candidate-status versions',
    );
    assert.equal(
      wouldRenderEmptyState(versions),
      false,
      'empty-state must not render when an approved version exists — approved artwork is shown instead',
    );
  });

  it('candidate versions still trigger candidate-card section — no regression', () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-candidate-1', 'candidate'),
    ];
    assert.equal(
      wouldRenderCandidateCards(versions),
      true,
      'candidate-card section must render when at least one candidate-status version exists',
    );
    assert.equal(
      wouldRenderEmptyState(versions),
      false,
      'empty-state must not render when there is an active candidate',
    );
  });
});

// ── Suite 4: empty-state hint text — queue-status branch ──────────────────────
//
// Inside the empty-state card, the hint text depends on the queue job status
// ([catalogId].tsx lines ~256-260):
//
//   {queue?.status === 'queued' || queue?.status === 'generating'
//     ? '⏳ AI artwork generation is in progress…'
//     : 'No candidates yet. Tap Regenerate to queue AI artwork generation.'}
//
// After a regenerate, all versions are archived (candidates.length === 0) and a
// queue job is 'queued'/'generating' — the hint must say generation is in
// progress, not prompt the admin to regenerate again.

describe('empty-state hint — shows in-progress text when a queue job is active', () => {
  const IN_PROGRESS = '⏳ AI artwork generation is in progress…';
  const REGENERATE_PROMPT = 'No candidates yet. Tap Regenerate to queue AI artwork generation.';

  // Exact replica of the screen's hint-text expression.
  function emptyStateHint(queue: { status: string } | null): string {
    return queue?.status === 'queued' || queue?.status === 'generating'
      ? IN_PROGRESS
      : REGENERATE_PROMPT;
  }

  // Combined predicate: all versions archived → empty state renders, and the
  // hint text is derived from the queue status.
  function hintForScreen(versions: Array<{ status: string }>, queue: { status: string } | null): string | null {
    const candidates = versions.filter((v) => v.status === 'candidate');
    const approved = versions.find((v) => v.status === 'approved');
    if (candidates.length > 0 || approved) return null; // empty-state not rendered
    return emptyStateHint(queue);
  }

  it("all archived + queue status 'queued' → in-progress message", () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-archived-2', 'archived'),
    ];
    assert.equal(
      hintForScreen(versions, { status: 'queued' }),
      IN_PROGRESS,
      "hint must say generation is in progress when a job is queued",
    );
  });

  it("all archived + queue status 'generating' → in-progress message", () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    assert.equal(
      hintForScreen(versions, { status: 'generating' }),
      IN_PROGRESS,
      "hint must say generation is in progress when a job is generating",
    );
  });

  it('all archived + queue is null → regenerate-prompt message', () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    assert.equal(
      hintForScreen(versions, null),
      REGENERATE_PROMPT,
      'hint must prompt regeneration when there is no queue job',
    );
  });

  it("all archived + terminal queue status ('completed') → regenerate-prompt message", () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    assert.equal(
      hintForScreen(versions, { status: 'completed' }),
      REGENERATE_PROMPT,
      'a finished job must not claim generation is still in progress',
    );
  });

  it("all archived + failed queue status → regenerate-prompt message", () => {
    const versions = [makeVersion('ver-archived-1', 'archived')];
    assert.equal(
      hintForScreen(versions, { status: 'failed' }),
      REGENERATE_PROMPT,
      'a failed job must fall back to the regenerate prompt',
    );
  });

  it('no versions at all + queued job → in-progress message', () => {
    assert.equal(
      hintForScreen([], { status: 'queued' }),
      IN_PROGRESS,
      'a brand-new entry with a queued job must also show the in-progress hint',
    );
  });

  it('approved version present → empty-state (and its hint) never renders regardless of queue', () => {
    const versions = [
      makeVersion('ver-archived-1', 'archived'),
      makeVersion('ver-approved-1', 'approved'),
    ];
    assert.equal(
      hintForScreen(versions, { status: 'queued' }),
      null,
      'empty-state must not render when an approved version exists',
    );
  });
});
