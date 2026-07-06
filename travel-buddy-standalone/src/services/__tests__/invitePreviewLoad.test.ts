/**
 * invitePreviewLoad.test.ts
 *
 * Unit tests for mapInvitePreviewToScreenState() — the production mapper
 * extracted from load() in app/invite/[token].tsx and living in
 * src/lib/invitePreviewMapper.ts.
 *
 * Terminal trips (cancelled, archived, past end_date) now return HTTP 410
 * from the API with reason:'trip_inactive', so the mapper sees them as
 * gone:true + goneReason:'trip_inactive' and routes to ScreenState kind:'gone'.
 *
 * The mapper uses only `import type` for its service-layer types, so this test
 * has zero React Native / supabase module dependencies and runs under node:test.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/invitePreviewLoad.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapInvitePreviewToScreenState } from '../../lib/invitePreviewMapper.ts';
import type { ScreenState } from '../../lib/invitePreviewMapper.ts';

// Inline type for test fixtures only (mirrors InvitePreview from trips.ts)
interface InvitePreview {
  tripId: string;
  tripTitle: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  coverUrl: string | null;
  alreadyMember: boolean;
  linkId: string;
  expiresAt: string | null;
  tripStatus: string | null;
  isFull: boolean;
}

function makePreview(overrides: Partial<InvitePreview> = {}): InvitePreview {
  return {
    tripId:             'trip-abc-123',
    tripTitle:          'Summer Escape',
    destinationCity:    'Bali',
    destinationCountry: 'Indonesia',
    startDate:          '2099-07-01',
    endDate:            '2099-07-14',
    coverUrl:           null,
    alreadyMember:      false,
    linkId:             'link-xyz-456',
    expiresAt:          null,
    tripStatus:         'upcoming',
    isFull:             false,
    ...overrides,
  };
}

describe('mapInvitePreviewToScreenState() — routing', () => {
  // ── active trip → 'ready' ─────────────────────────────────────────────────
  it('maps an active trip preview to ScreenState kind:\'ready\'', () => {
    const state: ScreenState = mapInvitePreviewToScreenState(
      { data: makePreview() },
    );
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.equal(state.preview.tripId, 'trip-abc-123');
    }
  });

  // ── gone (trip_inactive: cancelled) → 'gone_inactive' ───────────────────
  it('maps gone:true + goneReason:\'trip_inactive\' to \'gone_inactive\' (cancelled)', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: null,
      gone: true,
      goneReason: 'trip_inactive',
    });
    assert.equal(state.kind, 'gone_inactive', 'cancelled trip must reach gone_inactive state');
  });

  // ── gone (trip_inactive: archived) → 'gone_inactive' ─────────────────────
  it('maps gone:true + goneReason:\'trip_inactive\' to \'gone_inactive\' for an archived trip', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: null,
      gone: true,
      goneReason: 'trip_inactive',
    });
    assert.equal(state.kind, 'gone_inactive');
  });

  // ── gone (trip_inactive: past end_date) → 'gone_inactive' ────────────────
  it('maps gone:true + goneReason:\'trip_inactive\' to \'gone_inactive\' when end_date has passed', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: null,
      gone: true,
      goneReason: 'trip_inactive',
    });
    assert.equal(state.kind, 'gone_inactive');
  });

  // ── gone_inactive with tombstone → tombstone is forwarded ─────────────────
  it('forwards goneTripInfo as tombstone when trip_inactive includes trip details', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: null,
      gone: true,
      goneReason: 'trip_inactive',
      goneTripInfo: {
        title: 'Tokyo Sprint',
        destinationCity: 'Tokyo',
        destinationCountry: 'Japan',
        startDate: '2024-03-01',
        endDate: '2024-03-10',
        coverUrl: null,
      },
    });
    assert.equal(state.kind, 'gone_inactive');
    if (state.kind === 'gone_inactive') {
      assert.equal(state.tombstone?.title, 'Tokyo Sprint');
      assert.equal(state.tombstone?.destinationCity, 'Tokyo');
    }
  });

  // ── gone response → 'gone' (generic: link revoked/expired) ──────────────
  it('maps gone:true (no goneReason) to \'gone\' with link-level message', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({ data: null, gone: true });
    assert.equal(state.kind, 'gone');
    if (state.kind === 'gone') {
      assert.equal(state.message, 'This invite link has expired or been revoked.');
    }
  });

  // ── gone + unknown goneReason falls back to link-level message ────────────
  it('maps gone:true + unknown goneReason to the generic link-level message', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: null,
      gone: true,
      goneReason: 'some_future_reason',
    });
    assert.equal(state.kind, 'gone');
    if (state.kind === 'gone') {
      assert.equal(state.message, 'This invite link has expired or been revoked.');
    }
  });

  // ── not_authenticated → 'not_authed' ─────────────────────────────────────
  it('maps not_authenticated error to ScreenState kind:\'not_authed\'', () => {
    const state: ScreenState = mapInvitePreviewToScreenState(
      { data: null, error: 'not_authenticated' },
    );
    assert.equal(state.kind, 'not_authed');
  });

  // ── null data → 'error' ───────────────────────────────────────────────────
  it('maps null data (no error flag) to ScreenState kind:\'error\'', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({ data: null });
    assert.equal(state.kind, 'error');
  });

  // ── alreadyMember → 'already_member' ─────────────────────────────────────
  it('maps alreadyMember:true to \'already_member\'', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: makePreview({ alreadyMember: true }),
    });
    assert.equal(state.kind, 'already_member');
    if (state.kind === 'already_member') {
      assert.equal(state.tripId, 'trip-abc-123');
    }
  });
});
