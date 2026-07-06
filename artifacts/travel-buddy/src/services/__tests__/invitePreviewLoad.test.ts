/**
 * invitePreviewLoad.test.ts
 *
 * Unit tests for mapInvitePreviewToScreenState() — the production mapper
 * extracted from load() in app/invite/[token].tsx and living in
 * src/lib/invitePreviewMapper.ts.
 *
 * Tests confirm that isTerminal preview data routes to ScreenState kind:'terminal'
 * (not 'ready'), and that all other result variants are correctly routed too.
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
  isTerminal: boolean;
  terminalReason: string | null;
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
    isTerminal:         false,
    terminalReason:     null,
    ...overrides,
  };
}

describe('mapInvitePreviewToScreenState() — isTerminal routing', () => {
  // ── isTerminal: false → 'ready' ──────────────────────────────────────────
  it('maps an active trip preview to ScreenState kind:\'ready\'', () => {
    const state: ScreenState = mapInvitePreviewToScreenState(
      { data: makePreview({ isTerminal: false }) },
    );
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.equal(state.preview.tripId, 'trip-abc-123');
    }
  });

  // ── isTerminal: true (cancelled) → 'terminal' ────────────────────────────
  it('maps isTerminal:true to ScreenState kind:\'terminal\' (never \'ready\')', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: makePreview({
        isTerminal:     true,
        terminalReason: 'This trip is no longer active.',
        tripStatus:     'cancelled',
      }),
    });
    assert.equal(state.kind, 'terminal', 'cancelled trip must reach terminal state');
    if (state.kind === 'terminal') {
      assert.equal(state.message, 'This trip is no longer active.');
      assert.equal(state.preview.tripStatus, 'cancelled');
    }
  });

  // ── isTerminal: true (archived) → 'terminal' ─────────────────────────────
  it('maps isTerminal:true to \'terminal\' for an archived trip', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: makePreview({
        isTerminal:     true,
        terminalReason: 'This trip is no longer active.',
        tripStatus:     'archived',
      }),
    });
    assert.equal(state.kind, 'terminal');
    if (state.kind === 'terminal') {
      assert.equal(state.message, 'This trip is no longer active.');
    }
  });

  // ── isTerminal: true (past end_date) → 'terminal' ────────────────────────
  it('maps isTerminal:true to \'terminal\' when end_date has passed', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: makePreview({
        isTerminal:     true,
        terminalReason: 'This trip has already ended.',
        tripStatus:     'upcoming',
        endDate:        '2020-01-01',
      }),
    });
    assert.equal(state.kind, 'terminal');
    if (state.kind === 'terminal') {
      assert.equal(state.message, 'This trip has already ended.');
    }
  });

  // ── terminalReason fallback ───────────────────────────────────────────────
  it('falls back to the default message when terminalReason is null', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: makePreview({ isTerminal: true, terminalReason: null }),
    });
    assert.equal(state.kind, 'terminal');
    if (state.kind === 'terminal') {
      assert.equal(state.message, 'This trip is no longer active.');
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

  // ── gone response → 'gone' (trip_inactive: ended or cancelled) ────────────
  it('maps gone:true + goneReason:\'trip_inactive\' to \'gone\' with trip-level message', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: null,
      gone: true,
      goneReason: 'trip_inactive',
    });
    assert.equal(state.kind, 'gone');
    if (state.kind === 'gone') {
      assert.equal(state.message, 'This trip is no longer active.');
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

  // ── alreadyMember takes precedence over isTerminal ────────────────────────
  it('maps alreadyMember:true to \'already_member\' even when isTerminal is also true', () => {
    const state: ScreenState = mapInvitePreviewToScreenState({
      data: makePreview({ alreadyMember: true, isTerminal: true }),
    });
    assert.equal(state.kind, 'already_member');
    if (state.kind === 'already_member') {
      assert.equal(state.tripId, 'trip-abc-123');
    }
  });
});
