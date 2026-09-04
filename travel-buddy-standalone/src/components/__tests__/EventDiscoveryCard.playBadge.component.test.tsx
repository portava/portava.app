/**
 * EventDiscoveryCard — video play badge tests
 *
 * Confirms that:
 * 1. A video-cover event renders VideoThumbnail — play badge is visible.
 * 2. An image-cover event renders without the play badge.
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

function makeEvent(overrides: {
  coverMediaType: 'image' | 'video' | null;
  coverUrl?: string | null;
}): EventListItem {
  return {
    id:               'evt-1',
    hostId:           'host-1',
    hostName:         'Jane Host',
    hostHandle:       'janehost',
    hostAvatarUrl:    null,
    title:            'Test Event',
    description:      null,
    locationName:     'Central Park',
    locationLat:      null,
    locationLng:      null,
    startsAt:         '2025-08-01T18:00:00Z',
    endsAt:           null,
    coverUrl:         overrides.coverUrl ?? 'https://example.com/cover.jpg',
    coverMediaType:   overrides.coverMediaType,
    maxAttendees:     null,
    ageMin:           null,
    ageMax:           null,
    trustScoreMin:    null,
    verifiedOnly:     false,
    visibility:       'public',
    state:            'open',
    chatEnabled:      false,
    chatThreadId:     null,
    waitlistEnabled:  false,
    priceType:        'free',
    priceUrl:         null,
    rsvpOptions:      ['going'],
    goingCount:       4,
    waitlistCount:    0,
    category:         'Music',
    city:             'New York',
    country:          'US',
    rsvpClosed:       false,
    showExactLocation: true,
    isHost:           false,
    createdAt:        '2025-07-01T00:00:00Z',
    updatedAt:        '2025-07-01T00:00:00Z',
    myRsvp:           null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventDiscoveryCard — video cover', () => {
  it('renders the play badge (VideoThumbnail) when coverMediaType is video', async () => {
    const event = makeEvent({ coverMediaType: 'video' });
    await render(
      <EventDiscoveryCard event={event} onPress={jest.fn()} />,
    );

    // VideoThumbnail exposes accessibilityLabel="Play video" on its Pressable.
    expect(screen.getByLabelText('Play video')).toBeTruthy();
  });

  it('shows the play icon inside the VideoThumbnail for a video cover', async () => {
    const event = makeEvent({ coverMediaType: 'video' });
    await render(
      <EventDiscoveryCard event={event} onPress={jest.fn()} />,
    );

    // The lucide mock renders Play as <View testID="icon-Play" />.
    expect(screen.getByTestId('icon-Play')).toBeTruthy();
  });
});

describe('EventDiscoveryCard — image cover', () => {
  it('renders no play badge for an image cover event', async () => {
    const event = makeEvent({ coverMediaType: 'image' });
    await render(
      <EventDiscoveryCard event={event} onPress={jest.fn()} />,
    );

    // No VideoThumbnail — play badge accessibility label must be absent.
    expect(screen.queryByLabelText('Play video')).toBeNull();
  });

  it('renders no play icon for an image cover event', async () => {
    const event = makeEvent({ coverMediaType: 'image' });
    await render(
      <EventDiscoveryCard event={event} onPress={jest.fn()} />,
    );

    // The lucide Play icon is only rendered inside VideoThumbnail.
    expect(screen.queryByTestId('icon-Play')).toBeNull();
  });
});
