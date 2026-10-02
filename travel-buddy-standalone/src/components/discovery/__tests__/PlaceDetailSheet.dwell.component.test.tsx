/**
 * PlaceDetailSheet — the `04` §7 dwell hooks (census-discovery DV-41, §55).
 *
 * The sheet only FEEDS the emitter (hooks/useDiscoveryDwell.ts, covered by its
 * own suite): it hands over the surface that served the place, the place and
 * its served exposure id, and whether it is visible; and it reports every touch
 * and every scroll drag on itself as an interaction. What this pins:
 *   • the hook gets exactly { surface, itemId, recommendationId, visible };
 *   • the Layover card's sheet (no rankSurface) hands over surface null;
 *   • a touch anywhere on the sheet, and a drag of its scroll view, is an interaction;
 *   • closing hands over visible=false (which is what ends the view).
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports.
// Avoids overlapping act() from Modal animation lifecycle — see
// .agents/memory/modal-proxy-mock.md.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { PlaceDetailSheet } from '../PlaceDetailSheet.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockNoteInteraction = jest.fn();
const mockUseDiscoveryDwell = jest.fn((_args: unknown) => ({ noteInteraction: mockNoteInteraction }));
// NOTE: intentionally exhaustive — the real hook times and posts; its own suite
// covers that. Here only what the sheet hands it, and when it calls back.
jest.mock('../../../hooks/useDiscoveryDwell', () => ({
  useDiscoveryDwell: (args: unknown) => mockUseDiscoveryDwell(args),
}));

// NOTE: intentionally exhaustive — the real hook posts through fetch.
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: () => ({ reportTap: jest.fn(), reportSave: jest.fn(), reportJoin: jest.fn(), reportRsvp: jest.fn() }),
}));

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals; both lookups resolve to "nothing".
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatus:    jest.fn().mockResolvedValue(null),
  getWikidataEnrichment: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  toggleSave: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker has its own Modal chain.
jest.mock('../TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area native modules.
jest.mock('../../../hooks/useBottomInset', () => ({ usePlainBottomInset: () => 0 }));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the fallback branch is all we need.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ fallback, children, testID }: any) => {
    const { View } = require('react-native');
    return <View testID={testID ?? 'sheet-img'}>{fallback ?? children ?? null}</View>;
  },
  MediaFallback: () => {
    const { View } = require('react-native');
    return <View testID="sheet-media-fallback" />;
  },
}));

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: { coords: null, source: 'none', freshness: 'unavailable', place: null },
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE: DiscoveryPlace = {
  id:           'db/9c1d2e3f-0000-0000-0000-000000000001',
  name:         'Dwell Place',
  category:     'places',
  type:         'landmark',
  description:  'A description long enough to scroll past.',
  distanceKm:   null,
  lat:          48.8566,
  lng:          2.3522,
  tags:         [],
  address:      '1 Place du Louvre, Paris',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
  recommendationId: 'rec_DetailSheet_dwl_01',
};

async function mountSheet(props: Partial<React.ComponentProps<typeof PlaceDetailSheet>> = {}) {
  const utils = await render(
    <PlaceDetailSheet place={PLACE} visible onClose={jest.fn()} onAddToPlan={jest.fn()} rankSurface="discovery" {...props} />,
  );
  await waitFor(() => expect(utils.getByText('Dwell Place')).toBeTruthy());
  return utils;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('PlaceDetailSheet — dwell hooks', () => {
  it('hands the emitter the serving surface, the place, its exposure id and visibility — and visible=false on close', async () => {
    const utils = await mountSheet();
    expect(mockUseDiscoveryDwell).toHaveBeenLastCalledWith({
      surface: 'discovery', itemId: PLACE.id, recommendationId: PLACE.recommendationId, visible: true,
    });
    await utils.rerender(
      <PlaceDetailSheet place={PLACE} visible={false} onClose={jest.fn()} onAddToPlan={jest.fn()} rankSurface="discovery" />,
    );
    expect(mockUseDiscoveryDwell).toHaveBeenLastCalledWith({
      surface: 'discovery', itemId: PLACE.id, recommendationId: PLACE.recommendationId, visible: false,
    });
  });

  it("the Layover card's sheet (no rankSurface) hands over surface null", async () => {
    await mountSheet({ rankSurface: undefined });
    expect(mockUseDiscoveryDwell).toHaveBeenLastCalledWith(expect.objectContaining({ surface: null }));
  });

  it('a touch on the sheet and a drag of its scroll view are interactions', async () => {
    const { getByText } = await mountSheet();
    expect(mockNoteInteraction).not.toHaveBeenCalled();
    fireEvent(getByText('Dwell Place'), 'touchStart');
    expect(mockNoteInteraction).toHaveBeenCalledTimes(1);
    fireEvent(getByText('A description long enough to scroll past.'), 'scrollBeginDrag');
    expect(mockNoteInteraction).toHaveBeenCalledTimes(2);
  });
});
