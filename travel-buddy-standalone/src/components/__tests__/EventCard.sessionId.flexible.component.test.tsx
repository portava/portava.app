/**
 * FlexibleSection — sessionId forwarding (with sessionId)
 *
 * Split out from EventCard.sessionId.component.test.tsx: this scenario needs an
 * expand press followed by an inner-card press. Under React 19 + RNTL v14 the
 * per-file fireEvent.press budget degrades cumulatively, so each FlexibleSection
 * scenario lives in its own fresh-renderer file (one it(), single mount, two
 * synchronous presses, no post-press flush).
 *
 * Confirms that pressing a dimmed card inside FlexibleSection calls
 * fireRankOutcome with the 'tap' outcome and the supplied sessionId so the
 * outcome row joins back to the correct impression batch in rank_events.
 *
 * ## Mock strategy — mirrors the sibling files.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

// NOTE: intentionally exhaustive — pulling requireActual would import freshToken
// and trigger EXPO_PUBLIC_API_BASE_URL resolution; this test only needs the spy.
jest.mock('../../hooks/useRankOutcome', () => ({
  fireRankOutcome: jest.fn(),
}));

// NOTE: intentionally exhaustive — SaveButton brings in collections service,
// savedPostsCache, and SessionContext with native module chains.  A minimal
// stub keeps this test focused on the sessionId prop-forwarding contract.
jest.mock('../SaveButton', () => {
  const React = require('react');
  const mockFn = jest.fn((_props: Record<string, unknown>) => null);
  return { SaveButton: mockFn };
});

// NOTE: intentionally exhaustive — ui.tsx imports expo-linear-gradient which
// requires native GL modules unavailable under the jest-expo runner.
jest.mock('../ui', () => ({
  Stamp:  () => null,
  Avatar: () => null,
}));

// ── Subject under test ───────────────────────────────────────────────────────

import { FlexibleSection } from '../EventCard.tsx';
import { fireRankOutcome } from '../../hooks/useRankOutcome.ts';
import type { CityEvent } from '../../types/models.ts';

const mockFireRankOutcome = fireRankOutcome as jest.Mock;

// ── Fixture ──────────────────────────────────────────────────────────────────

const MOCK_EVENT: CityEvent = {
  id:            'ev-test-1',
  kind:          'event',
  title:         'Sunset Mixer',
  city:          'Manila',
  citySlug:      'manila',
  startAt:       '2026-07-19T18:00:00+08:00',
  block:         'evening',
  category:      'social',
  attendeeCount: 12,
  capacity:      30,
  score:         null,
};

// ── Test ───────────────────────────────────────────────────────────────────

describe('FlexibleSection — sessionId forwarding (with sessionId)', () => {
  beforeEach(() => {
    mockFireRankOutcome.mockClear();
  });

  test('pressing a dimmed card inside FlexibleSection calls fireRankOutcome with the correct sessionId', async () => {
    const view = await render(
      <FlexibleSection events={[MOCK_EVENT]} sessionId="sess-flex-456" />,
    );

    // Expand the collapsed section first. The expand toggles `open` state which
    // conditionally renders the body; flush once so that commit lands before we
    // query/press the inner card. This is the only post-press flush in the file.
    fireEvent.press(view.getByText("When you're flexible"));
    await act(async () => {});

    // Now press the dimmed event card inside.
    fireEvent.press(view.getByText('Sunset Mixer'));

    expect(mockFireRankOutcome).toHaveBeenCalledWith(
      'ev-test-1',
      'events',
      'tap',
      'sess-flex-456',
    );
  });
});
