/**
 * DiscoveryWall — no Directions / Navigate button when coordinates are absent
 *
 * HiddenGemCard and TravelerPickCard receive DiscoveryItem / TravelerPick shapes,
 * neither of which carries lat/lng.  HiddenGemCard passes only { id, name, city }
 * to PlaceQuickActions; TravelerPickCard owns its own action row with no Navigate
 * chip.
 *
 * This confirms the same guard PlaceCard uses (null coords → Directions button
 * absent) holds on both wall cards so a future refactor can never accidentally
 * surface a name-only geocode fallback.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * services/discovery.ts, PlanPickerController, HighlightRing/Viewer,
 * DiscoveryShareSheet, discoveryBookmarks, AddToEventSheet, and lib/maps are
 * mocked exhaustively because they pull in native / navigation deps unrelated
 * to the navigate-button visibility under test.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// ── Service / navigation mocks ──────────────────────────────────────────────

// NOTE: exhaustive — the cards only use these three exports; avoid pulling in
// Supabase native internals under jest-expo.
jest.mock('../../services/discovery.ts', () => ({
  saveCommunityPlace: jest.fn(async () => ({ ok: true })),
  reportCommunityPlace: jest.fn(async () => ({ ok: true })),
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: exhaustive — the real provider needs full navigation context.
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: exhaustive — highlight ring hits highlight services; null disables it.
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: () => null,
}));

jest.mock('../HighlightRing.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    HighlightRing: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(View, null, children),
  };
});

// NOTE: exhaustive — modal viewer is orthogonal to button visibility.
jest.mock('../HighlightViewer.tsx', () => ({ HighlightViewer: () => null }));

// NOTE: exhaustive — share sheet pulls native share deps.
jest.mock('../DiscoveryShareSheet.tsx', () => ({ DiscoveryShareSheet: () => null }));

// NOTE: exhaustive — only removeSaved is imported by DiscoveryWall.
jest.mock('../../services/discoveryBookmarks.ts', () => ({
  removeSaved: jest.fn(async () => {}),
}));

// NOTE: exhaustive — AddToEventSheet renders its own Modal tree unrelated to
// the navigate-button guard.
jest.mock('../AddToEventSheet.tsx', () => ({ AddToEventSheet: () => null }));

// NOTE: exhaustive — openMapsNavigation opens a native deep-link; stub so no
// Linking call escapes under test.
jest.mock('../../lib/maps.ts', () => ({
  openMapsNavigation: jest.fn(),
}));

// NOTE: exhaustive — useEntityHeaderImage may call FSQ / AI services.
jest.mock('../../hooks/useEntityHeaderImage.ts', () => ({
  useEntityHeaderImage: () => null,
}));

// NOTE: exhaustive — CachedImage wraps expo-image which crashes under jest-expo.
jest.mock('../CachedImage.tsx', () => ({
  CachedImage: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { HiddenGemCard, TravelerPickCard } from '../DiscoveryWall.tsx';
import type { DiscoveryItem, TravelerPick } from '../../data/discovery.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const gem: DiscoveryItem = {
  id: 'gem-nav-1',
  name: 'Rooftop Garden Cafe',
  category: 'food',
  neighborhood: 'Lahug',
  city: 'Cebu City',
  blurb: 'A quiet spot on the rooftop.',
  source: 'traveler',
  status: 'provisional',
  verified: false,
  savedCount: 0,
} as DiscoveryItem;

const pick: TravelerPick = {
  id: 'tp-nav-1',
  user: {
    name: 'Aria',
    avatarUrl: 'https://example.com/a.jpg',
    id: 'u-nav-1',
    handle: null,
  },
  place: 'Sunset Bar Cebu',
  note: 'Best sundowners in the city.',
  city: 'Cebu City',
  rating: 4.7,
  tag: 'Nightlife',
  timeAgo: '1h ago',
  source: 'traveler',
  status: 'provisional',
  verified: false,
  savedCount: 0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HiddenGemCard — no Navigate chip when coordinates are absent', () => {
  it('does not render a Navigate or Directions button when lat/lng are absent', async () => {
    // HiddenGemCard calls PlaceQuickActions with only { id, name, city } — no lat/lng.
    // PlaceQuickActions must hide the Navigate chip (same guard as PlaceCard).
    await render(<HiddenGemCard gem={gem} />);

    // Neither the chip label text nor the accessibilityLabel should appear.
    expect(screen.queryByText('Navigate')).toBeNull();
    expect(screen.queryByText('Directions')).toBeNull();
    expect(screen.queryByLabelText('Navigate to this place')).toBeNull();
  });
});

describe('TravelerPickCard — no Navigate chip when coordinates are absent', () => {
  it('does not render a Navigate or Directions button', async () => {
    // TravelerPickCard owns its own action row (Save / Route / Add to Plan / Report)
    // and has never exposed a Navigate chip — confirm it remains absent.
    await render(<TravelerPickCard pick={pick} />);

    expect(screen.queryByText('Navigate')).toBeNull();
    expect(screen.queryByText('Directions')).toBeNull();
    expect(screen.queryByLabelText('Navigate to this place')).toBeNull();
  });
});
