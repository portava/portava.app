/**
 * EventCard — sessionId forwarding tests
 *
 * Confirms that:
 * 1. Tapping the event card calls fireRankOutcome with the 'tap' outcome and
 *    the sessionId from useCityPulse — so the outcome row can be joined back
 *    to the correct impression batch in rank_events.
 * 2. The sessionId is also forwarded to SaveButton as a prop so a subsequent
 *    'save' outcome is attributed to the same session.
 *
 * Without these checks, a future refactor could silently drop sessionId from
 * EventCard and the learning loop would stop closing without any test catching it.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * fireRankOutcome is mocked at the module level so the test can assert on
 * its arguments without triggering network calls or the freshToken chain.
 *
 * SaveButton is stubbed exhaustively because it brings in collections,
 * savedPostsCache, and SessionContext (with their own native-module chains).
 * The stub records the props it receives so we can assert sessionId forwarding.
 *
 * ui.tsx (Stamp, Avatar) is stubbed exhaustively because it imports
 * expo-linear-gradient, which requires native GL modules unavailable under
 * the jest-expo runner.
 *
 * expo-router and lucide-react-native are handled by the global moduleNameMapper.
 */

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

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

import { EventCard } from '../EventCard.tsx';
import { fireRankOutcome } from '../../hooks/useRankOutcome.ts';
import type { CityEvent } from '../../types/models.ts';

const mockFireRankOutcome = fireRankOutcome as jest.Mock;

// Retrieve the SaveButton spy through requireMock so it's always the hoisted
// instance (not a stale reference captured before jest processes the factory).
function getMockSaveButton(): jest.Mock {
  return jest.requireMock('../SaveButton').SaveButton as jest.Mock;
}

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EventCard — sessionId forwarding', () => {
  beforeEach(() => {
    mockFireRankOutcome.mockClear();
    getMockSaveButton().mockClear();
  });

  test('tapping the card calls fireRankOutcome with the tap outcome and the supplied sessionId', async () => {
    await render(<EventCard ev={MOCK_EVENT} sessionId="sess-abc-123" />);

    // Press the card title — it is inside the outer Pressable so the press
    // event bubbles up to the card's onPress handler.
    fireEvent.press(screen.getByText('Sunset Mixer'));

    expect(mockFireRankOutcome).toHaveBeenCalledWith(
      'ev-test-1',
      'events',
      'tap',
      'sess-abc-123',
    );
  });

  test('tapping the card without a sessionId calls fireRankOutcome with undefined', async () => {
    await render(<EventCard ev={MOCK_EVENT} />);

    fireEvent.press(screen.getByText('Sunset Mixer'));

    expect(mockFireRankOutcome).toHaveBeenCalledWith(
      'ev-test-1',
      'events',
      'tap',
      undefined,
    );
  });

  test('SaveButton receives the sessionId prop so the save outcome shares the same session', async () => {
    await render(<EventCard ev={MOCK_EVENT} sessionId="sess-abc-123" />);

    const MockSaveButton = getMockSaveButton();
    // SaveButton is mocked — inspect the props it was rendered with.
    const receivedProps = MockSaveButton.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(receivedProps).toBeDefined();
    expect(receivedProps.sessionId).toBe('sess-abc-123');
    expect(receivedProps.entityId).toBe('ev-test-1');
    expect(receivedProps.entityType).toBe('event');
  });

  test('SaveButton receives undefined sessionId when none is provided', async () => {
    await render(<EventCard ev={MOCK_EVENT} />);

    const MockSaveButton = getMockSaveButton();
    const receivedProps = MockSaveButton.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(receivedProps).toBeDefined();
    // sessionId prop is omitted → undefined; SaveButton converts to null internally
    expect(receivedProps.sessionId).toBeUndefined();
  });

  test('fireRankOutcome is not called when the View-on-map button is pressed', async () => {
    await render(<EventCard ev={MOCK_EVENT} sessionId="sess-abc-123" />);

    // The inner map button calls stopPropagation and navigates; it must NOT
    // also fire a tap outcome — only the outer card press does.
    fireEvent.press(screen.getByText('View on map'));

    expect(mockFireRankOutcome).not.toHaveBeenCalled();
  });

  test('router.push is still called even when fireRankOutcome throws synchronously', async () => {
    // Simulate a future regression where fireRankOutcome throws instead of
    // being truly fire-and-forget.  router.push must still be reached.
    mockFireRankOutcome.mockImplementation(() => {
      throw new Error('outcome endpoint unreachable');
    });

    const pushSpy = jest.spyOn(router, 'push');

    await render(<EventCard ev={MOCK_EVENT} sessionId="sess-abc-123" />);

    fireEvent.press(screen.getByText('Sunset Mixer'));

    expect(pushSpy).toHaveBeenCalledWith('/(tabs)/trips');

    pushSpy.mockRestore();
  });
});

// NOTE: The FlexibleSection sessionId-forwarding tests live in their own file
// (EventCard.flexibleSection.component.test.tsx).  Each one needs TWO live
// presses that commit setState (expand the section, then tap the revealed
// card).  Per the renderer's cumulative press-degradation limit, only the
// first ~2 mounts in a file dispatch presses whose setState commits, and these
// scenarios sit after 6 EventCard mounts here — the expand press silently
// no-ops.  Splitting into a separate file gives each scenario a fresh renderer.
