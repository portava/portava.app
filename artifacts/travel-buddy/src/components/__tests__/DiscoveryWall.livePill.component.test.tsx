/**
 * DiscoveryWall community cards — live "Open now" pill tests
 *
 * Confirms that:
 * 1. TravelerPickCard shows the verified live pill when getPlaceLiveStatusCached
 *    resolves an available open status.
 * 2. HiddenGemCard shows the pill for a closed status.
 * 3. No pill renders when the live status is unavailable or null.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * services/discovery.ts is mocked (partial via requireActual is unnecessary —
 * the cards only import saveCommunityPlace / reportCommunityPlace /
 * getPlaceLiveStatusCached from it).
 * PlanPickerController, HighlightRing/Viewer, and DiscoveryShareSheet are
 * mocked because they pull in navigation/native dependencies unrelated to
 * the pill behaviour.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockGetLive = jest.fn();

// NOTE: exhaustive on purpose — spreading requireActual would pull in supabase/apiToken
// native deps; the cards only use these three exports.
jest.mock('../../services/discovery.ts', () => ({
  saveCommunityPlace: jest.fn(async () => ({ ok: true })),
  reportCommunityPlace: jest.fn(async () => ({ ok: true })),
  getPlaceLiveStatusCached: (...args: unknown[]) => mockGetLive(...args),
}));

// NOTE: exhaustive on purpose — the real provider needs navigation context; cards only call usePlanPicker.
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: exhaustive on purpose — the real hook hits highlight services; null disables the ring.
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: () => null,
}));

jest.mock('../HighlightRing.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { HighlightRing: ({ children }: { children?: React.ReactNode }) => React.createElement(View, null, children) };
});

// NOTE: exhaustive on purpose — modal viewer irrelevant to the pill; render nothing.
jest.mock('../HighlightViewer.tsx', () => ({ HighlightViewer: () => null }));
// NOTE: exhaustive on purpose — share sheet pulls native share deps; render nothing.
jest.mock('../DiscoveryShareSheet.tsx', () => ({ DiscoveryShareSheet: () => null }));
// NOTE: exhaustive on purpose — only removeSaved is imported by DiscoveryWall.
jest.mock('../../services/discoveryBookmarks.ts', () => ({ removeSaved: jest.fn(async () => {}) }));

import { HiddenGemCard, TravelerPickCard } from '../DiscoveryWall.tsx';
import type { DiscoveryItem, TravelerPick } from '../../data/discovery.ts';

const gem: DiscoveryItem = {
  id: 'gem-1',
  name: 'Secret Falls Cafe',
  category: 'food',
  neighborhood: 'Lahug',
  city: 'Cebu City',
  blurb: 'A quiet spot behind the falls.',
  source: 'traveler',
  status: 'provisional',
  verified: false,
  savedCount: 0,
} as DiscoveryItem;

const pick: TravelerPick = {
  id: 'tp-1',
  user: { name: 'Leo', avatarUrl: 'https://example.com/a.jpg', id: 'u1', handle: null },
  place: 'The Distillery Cebu',
  note: 'Great cocktails!',
  city: 'Cebu City',
  rating: 4.6,
  tag: 'Nightlife',
  timeAgo: '2h ago',
  source: 'traveler',
  status: 'provisional',
  verified: false,
  savedCount: 0,
};

const openStatus = {
  available: true,
  openNow: true,
  confidence: { sourceClass: 'verified_live', label: 'Verified live', checkedAt: '2026-07-21T00:00:00Z' },
};

const closedStatus = { ...openStatus, openNow: false };

beforeEach(() => {
  mockGetLive.mockReset();
});

describe('TravelerPickCard — live open-now pill', () => {
  it('shows "Open now" when the cached live status is available and open', async () => {
    mockGetLive.mockResolvedValue(openStatus);
    await render(<TravelerPickCard pick={pick} />);

    await waitFor(() => expect(screen.getByTestId('pick-open-now-tp-1')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Open now')).toBeTruthy();
    expect(mockGetLive).toHaveBeenCalledWith('The Distillery Cebu', 'Cebu City');
  });

  it('renders no pill when the live status is unavailable', async () => {
    mockGetLive.mockResolvedValue({ ...openStatus, available: false, openNow: null });
    await render(<TravelerPickCard pick={pick} />);

    // Wait past the 600 ms fetch delay, then confirm nothing rendered.
    await waitFor(() => expect(mockGetLive).toHaveBeenCalled(), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('pick-open-now-tp-1')).toBeNull();
  });

  it('renders no pill when the lookup returns null (network failure cached)', async () => {
    mockGetLive.mockResolvedValue(null);
    await render(<TravelerPickCard pick={pick} />);

    await waitFor(() => expect(mockGetLive).toHaveBeenCalled(), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('pick-open-now-tp-1')).toBeNull();
  });
});

describe('HiddenGemCard — live open-now pill', () => {
  it('shows "Closed now" when the cached live status is available and closed', async () => {
    mockGetLive.mockResolvedValue(closedStatus);
    await render(<HiddenGemCard gem={gem} />);

    await waitFor(() => expect(screen.getByTestId('gem-open-now-gem-1')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Closed now')).toBeTruthy();
    expect(mockGetLive).toHaveBeenCalledWith('Secret Falls Cafe', 'Cebu City');
  });
});

/**
 * Card recycling: the same component instance receives a different place
 * (new gem/pick props) while the first place's live lookup is still pending.
 * The first result must be discarded — never briefly shown, and never
 * allowed to overwrite the second place's status after it resolves.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const pick2: TravelerPick = {
  ...pick,
  id: 'tp-2',
  place: 'Sirao Garden Cafe',
  city: 'Cebu City',
};

const gem2: DiscoveryItem = {
  ...gem,
  id: 'gem-2',
  name: 'Tops Lookout Kiosk',
} as DiscoveryItem;

describe('TravelerPickCard — recycled onto a different place', () => {
  it('discards the first place\'s slow lookup and only shows the new place\'s status', async () => {
    const first = deferred<typeof openStatus>();
    const second = deferred<typeof closedStatus>();
    mockGetLive
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = await render(<TravelerPickCard pick={pick} />);

    // Wait until the first place's lookup has actually started (600 ms delay).
    await waitFor(
      () => expect(mockGetLive).toHaveBeenCalledWith('The Distillery Cebu', 'Cebu City'),
      { timeout: 3000 },
    );

    // Recycle the card onto a different place while the first lookup is pending.
    rerender(<TravelerPickCard pick={pick2} />);

    // No stale pill from the previous place while the new lookup runs.
    expect(screen.queryByTestId('pick-open-now-tp-1')).toBeNull();
    expect(screen.queryByTestId('pick-open-now-tp-2')).toBeNull();

    // Second place's lookup fires for the new name.
    await waitFor(
      () => expect(mockGetLive).toHaveBeenCalledWith('Sirao Garden Cafe', 'Cebu City'),
      { timeout: 3000 },
    );

    // New place resolves closed → its pill renders.
    second.resolve(closedStatus);
    await waitFor(() => expect(screen.getByTestId('pick-open-now-tp-2')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Closed now')).toBeTruthy();

    // The FIRST place's slow lookup finally resolves open — it must be discarded,
    // not overwrite the second place's status.
    first.resolve(openStatus);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Open now')).toBeNull();
    expect(screen.getByText('Closed now')).toBeTruthy();
    expect(screen.queryByTestId('pick-open-now-tp-1')).toBeNull();
  });
});

describe('HiddenGemCard — recycled onto a different place', () => {
  it('discards the first gem\'s slow lookup and only shows the new gem\'s status', async () => {
    const first = deferred<typeof closedStatus>();
    const second = deferred<typeof openStatus>();
    mockGetLive
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = await render(<HiddenGemCard gem={gem} />);

    await waitFor(
      () => expect(mockGetLive).toHaveBeenCalledWith('Secret Falls Cafe', 'Cebu City'),
      { timeout: 3000 },
    );

    // Recycle onto a different gem while the first lookup is still pending.
    rerender(<HiddenGemCard gem={gem2} />);
    expect(screen.queryByTestId('gem-open-now-gem-1')).toBeNull();
    expect(screen.queryByTestId('gem-open-now-gem-2')).toBeNull();

    await waitFor(
      () => expect(mockGetLive).toHaveBeenCalledWith('Tops Lookout Kiosk', 'Cebu City'),
      { timeout: 3000 },
    );

    // New gem resolves open → its pill renders.
    second.resolve(openStatus);
    await waitFor(() => expect(screen.getByTestId('gem-open-now-gem-2')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Open now')).toBeTruthy();

    // First gem's slow result arrives late — must be discarded.
    first.resolve(closedStatus);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Closed now')).toBeNull();
    expect(screen.getByText('Open now')).toBeTruthy();
    expect(screen.queryByTestId('gem-open-now-gem-1')).toBeNull();
  });
});
