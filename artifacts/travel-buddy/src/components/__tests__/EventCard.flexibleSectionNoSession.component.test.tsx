/**
 * FlexibleSection — sessionId forwarding (WITHOUT a sessionId)
 *
 * Split into its own file: expanding the collapsed section and then tapping the
 * revealed dimmed card requires TWO live presses whose setState must commit
 * (open the section, then dispatch the card's onPress).  Per the renderer's
 * cumulative press-degradation limit, only the first ~1-2 mounts in a file
 * commit press-driven setState reliably, so each FlexibleSection scenario needs
 * a fresh renderer (= its own file).  See the "with a sessionId" sibling file.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, fireEvent, screen, act } from '@testing-library/react-native';

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

// ── Test ─────────────────────────────────────────────────────────────────────

describe('FlexibleSection — sessionId forwarding (no sessionId)', () => {
  beforeEach(() => {
    mockFireRankOutcome.mockClear();
  });

  test('pressing a dimmed card inside FlexibleSection without a sessionId calls fireRankOutcome with undefined', async () => {
    await render(<FlexibleSection events={[MOCK_EVENT]} />);

    // Expand the collapsed section first (live press → setState commit).
    fireEvent.press(screen.getByText("When you're flexible"));
    // Flush the expand setState so the dimmed card mounts.  Safe here: no
    // further mounts follow this press (single-scenario file), so the
    // post-press flush cannot poison a later instance.
    await act(async () => {});

    // Now press the dimmed event card inside.
    fireEvent.press(screen.getByText('Sunset Mixer'));

    expect(mockFireRankOutcome).toHaveBeenCalledWith(
      'ev-test-1',
      'events',
      'tap',
      undefined,
    );
  });
});
