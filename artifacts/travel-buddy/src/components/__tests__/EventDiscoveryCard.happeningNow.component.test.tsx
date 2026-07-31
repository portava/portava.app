/**
 * EventDiscoveryCard — state-badge "Happening now" / "Completed" tests
 *
 * Confirms that:
 * 1. When startsAt is in the past and endsAt is in the future, the badge
 *    reads "Happening now" — not "Open".
 * 2. When both startsAt and endsAt are in the past, the badge reads
 *    "Completed".
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * expo-image is mocked exhaustively because it relies on native Expo modules
 * that are unavailable in the jest-expo runner.
 * expo-linear-gradient is mocked because Avatar (via ui.tsx) imports it and
 * it also brings in native modules.
 * lucide-react-native and expo-router are handled by the global moduleNameMapper.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EventDiscoveryCard } from '../EventDiscoveryCard.tsx';
import type { EventListItem } from '../../services/events.ts';

// NOTE: intentionally exhaustive — expo-image uses native ExpoView internals
// that crash the jest-expo runner when loaded via requireActual.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ testID, ...rest }: { testID?: string; [k: string]: unknown }) =>
      React.createElement(View, { testID: testID ?? 'expo-image', ...rest }),
  };
});

// NOTE: Avatar (via ui.tsx) imports expo-linear-gradient which brings in
// native modules unavailable under the jest-expo runner.
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) =>
      React.createElement(View, rest, children),
  };
});

// ── Fixture factory ───────────────────────────────────────────────────────────

/** Dates that are clearly in the past and future from any reasonable test run. */
const PAST_STARTS   = '2020-01-01T00:00:00Z';
const FUTURE_ENDS   = '2099-12-31T23:59:59Z';
const PAST_ENDS     = '2020-01-02T00:00:00Z'; // after PAST_STARTS, still past

function makeEvent(overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id:                   'evt-1',
    hostId:               'host-1',
    hostName:             'Jane Host',
    hostHandle:           null,
    hostAvatarUrl:        null,
    title:                'Test Event',
    description:          null,
    locationName:         'Central Park',
    locationLat:          null,
    locationLng:          null,
    startsAt:             '2025-08-01T18:00:00Z',
    endsAt:               null,
    coverUrl:             null,
    coverMediaType:       null,
    coverImageSourceType: null,
    coverDisclaimerRequired: null,
    coverDisclaimerText:  null,
    maxAttendees:         null,
    ageMin:               null,
    ageMax:               null,
    trustScoreMin:        null,
    verifiedOnly:         false,
    visibility:           'public',
    state:                'open',
    chatEnabled:          false,
    chatThreadId:         null,
    waitlistEnabled:      false,
    priceType:            'free',
    priceUrl:             null,
    rsvpOptions:          ['going'],
    goingCount:           4,
    waitlistCount:        0,
    category:             'Music',
    city:                 'New York',
    country:              'US',
    rsvpClosed:           false,
    showExactLocation:    true,
    isHost:               false,
    createdAt:            '2025-07-01T00:00:00Z',
    updatedAt:            '2025-07-01T00:00:00Z',
    myRsvp:               null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventDiscoveryCard — state badge auto-promotion', () => {
  it('shows "Happening now" when startsAt is past and endsAt is in the future', async () => {
    const event = makeEvent({ state: 'open', startsAt: PAST_STARTS, endsAt: FUTURE_ENDS });
    await render(<EventDiscoveryCard event={event} onPress={jest.fn()} />);

    expect(screen.getByText('Happening now')).toBeTruthy();
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('shows "Completed" when both startsAt and endsAt are in the past', async () => {
    const event = makeEvent({ state: 'open', startsAt: PAST_STARTS, endsAt: PAST_ENDS });
    await render(<EventDiscoveryCard event={event} onPress={jest.fn()} />);

    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.queryByText('Open')).toBeNull();
    expect(screen.queryByText('Happening now')).toBeNull();
  });
});
