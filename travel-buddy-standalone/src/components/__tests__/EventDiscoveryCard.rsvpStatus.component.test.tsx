/**
 * EventDiscoveryCard — saved RSVP status labels.
 *
 * The list card must display the status returned by the API instead of
 * collapsing every non-going RSVP into "Maybe".
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EventDiscoveryCard } from '../EventDiscoveryCard.tsx';
import type { EventListItem, EventRsvpStatus } from '../../services/events.ts';

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ testID, ...rest }: { testID?: string; [k: string]: unknown }) =>
      React.createElement(View, { testID: testID ?? 'expo-image', ...rest }),
  };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) =>
      React.createElement(View, rest, children),
  };
});

function makeEvent(myRsvp: EventRsvpStatus): EventListItem {
  return {
    id: 'evt-rsvp',
    hostId: 'host-1',
    hostName: 'Jane Host',
    hostHandle: null,
    hostAvatarUrl: null,
    title: 'Coastal cliff hike',
    description: null,
    locationName: 'Coastal cliffs',
    locationLat: null,
    locationLng: null,
    startsAt: '2099-08-01T18:00:00Z',
    endsAt: null,
    coverUrl: null,
    coverMediaType: null,
    coverImageSourceType: null,
    coverDisclaimerRequired: null,
    coverDisclaimerText: null,
    maxAttendees: null,
    ageMin: null,
    ageMax: null,
    trustScoreMin: null,
    verifiedOnly: false,
    visibility: 'public',
    state: 'open',
    chatEnabled: false,
    chatThreadId: null,
    waitlistEnabled: false,
    priceType: 'free',
    priceUrl: null,
    rsvpOptions: ['going', 'maybe', 'interested', 'cant_go'],
    goingCount: 4,
    waitlistCount: 0,
    category: 'Hiking',
    city: 'Portava',
    country: 'PT',
    rsvpClosed: false,
    showExactLocation: true,
    isHost: false,
    createdAt: '2099-07-01T00:00:00Z',
    updatedAt: '2099-07-01T00:00:00Z',
    myRsvp,
  };
}

describe('EventDiscoveryCard — RSVP status label', () => {
  it.each([
    ['going', 'Going ✅'],
    ['maybe', 'Maybe 🤔'],
    ['interested', 'Interested 👀'],
    ['cant_go', "Can't go ❌"],
  ] as const)('shows %s as %s', async (status, label) => {
    await render(<EventDiscoveryCard event={makeEvent(status)} onPress={jest.fn()} />);

    expect(screen.getByText(label)).toBeTruthy();
  });
});