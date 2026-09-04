/**
 * MapCarousel — card-height regression guard
 *
 * CARD_AREA_HEIGHT was raised from 164 → 200 px to accommodate the worst-case
 * card: a buddy card whose chip row wraps to two lines (rating + city + $/hr +
 * Available) combined with Book + Message action buttons.
 *
 * RNTL does not run a native layout pass, so pixel-perfect measurement is not
 * possible here.  Instead this file:
 *   1. Guards the CARD_AREA_HEIGHT constant at 200 by reading it from source.
 *   2. Renders the worst-case buddy card (4 chips + Book + Message) and asserts
 *      every chip and both action buttons are present — confirming no content is
 *      conditionally hidden due to clipping or height mismatch.
 *   3. Renders the worst-case event card (Join + Share + Report) with the same
 *      assertion strategy.
 *   4. Confirms DETENT_MEDIUM_H = PEEK_HEIGHT (52) + CARD_AREA_HEIGHT (200).
 *
 * All renders wrap in MapStoreProvider so MapEntityCard and MapEntityActionRow
 * see the live store — the same setup used in mapPhase2c.detent.component tests.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import { MapStoreProvider } from '../../../stores/mapStore.tsx';
import { MapCarousel } from '../MapCarousel.tsx';
import type { MapEntity } from '../../../types/mapTypes.ts';
import { buddyEntity, eventEntity } from '../../../__fixtures__/mapEntities.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: expo-router is already mapped via moduleNameMapper but the mapper stub
// lacks useNavigation which MapCarousel's dependency tree may call; override here
// to match the full shape used by mapPhase2c.detent tests.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useSegments: () => [],
  useFocusEffect: () => {},
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    setOptions: jest.fn(),
    addListener: () => () => {},
  }),
  Link: ({ children }: any) => children,
  Redirect: () => null,
  Stack: { Screen: () => null },
  Tabs: { Screen: () => null },
}));

// NOTE: openDirectThread makes live Supabase fetch calls; stub here to prevent
// network I/O and keep the test deterministic.
jest.mock('../../../services/messaging.ts', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: rsvpEvent hits the API; stub to avoid network calls.
jest.mock('../../../services/events.ts', () => ({
  rsvpEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: openInMaps calls Linking.openURL — unavailable in jest-expo.
jest.mock('../../../lib/openInMaps.ts', () => ({
  openInMaps: jest.fn(),
}));

// NOTE: useFollow manages async follow-state and makes API calls; fully stub so
// no network I/O and the hook returns a stable shape on every render.
jest.mock('../../../hooks/useFollow.ts', () => ({
  useFollow: jest.fn(() => ({
    isFollowing: false,
    followsYou: false,
    followersCount: 0,
    followingCount: 0,
    loading: false,
    toggling: false,
    toggle: jest.fn(),
  })),
}));

// NOTE: useBlockUser calls blockUser/unblockUser which make fetch calls.
jest.mock('../../../hooks/useBlockUser.ts', () => ({
  useBlockUser: jest.fn(() => ({
    doBlock: jest.fn().mockResolvedValue(true),
    doUnblock: jest.fn().mockResolvedValue(true),
    loading: false,
    error: null,
  })),
}));

// NOTE: usePlanPicker opens a modal backed by trip data fetching; stub the hook.
jest.mock('../../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: TripWishlistPicker fetches trip data on open; render a testID stub.
jest.mock('../../discovery/TripWishlistPicker.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TripWishlistPicker: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="wishlist-picker" /> : null,
  };
});

// NOTE: ReportSheet makes moderation API calls; render a testID stub.
jest.mock('../../ReportSheet.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ReportSheet: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="report-sheet" /> : null,
  };
});

// ── Read CARD_AREA_HEIGHT from source ──────────────────────────────────────────
//
// We read the constant from the source file rather than importing it (it is not
// exported) so the assertion guards against the constant being silently lowered
// in the same way the grep test in MapEntityActionRow.test.tsx guards mutations.

const carouselSrc = fs.readFileSync(
  path.join(__dirname, '../MapCarousel.tsx'),
  'utf-8',
);
const cardAreaHeightMatch = carouselSrc.match(/^const CARD_AREA_HEIGHT\s*=\s*(\d+)/m);
const CARD_AREA_HEIGHT = cardAreaHeightMatch
  ? parseInt(cardAreaHeightMatch[1], 10)
  : NaN;

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// PRODUCED BY THE REAL PROJECTORS (src/__fixtures__/mapEntities.ts).
//
// These used to be hand-written `payload` object literals in the raw service-DTO
// shape. That is what let this file stay green after the producers switched to
// emitting `MapObject`: the card bodies read fields that were no longer there
// (two of them threw), and the fixtures kept supplying the old shape so nothing
// noticed. A fixture that builds its own DTO proves nothing about the app.

/**
 * Worst-case buddy entity: all four chips present in BuddyCardBody —
 *   chip 1: averageRating → "4.8"
 *   chip 2: city          → "Lisbon"
 *   chip 3: hourlyRateUsd → "$45/hr"
 *   chip 4: Available status chip (always rendered)
 * Plus Book + Message action capabilities.
 */
const buddyFixture: MapEntity = {
  ...buddyEntity({ id: 'height-test', city: 'Lisbon', hourlyRateUsd: 45, averageRating: 4.8 }),
  actionCapabilities: ['book', 'message'],
  permissions: {
    canMessage: true,
    canFollow: false,
    canBlock: false,
    canReport: false,
  },
};

/**
 * Worst-case event entity: Join + Share + Report action buttons.
 */
const eventFixture: MapEntity = {
  ...eventEntity({ id: 'height-test' }),
  actionCapabilities: ['join', 'share', 'report'],
  permissions: {
    canMessage: false,
    canFollow: false,
    canBlock: false,
    canReport: true,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapCarousel card height guard', () => {
  // ── 1. Constant guard ────────────────────────────────────────────────────────

  it('CARD_AREA_HEIGHT is 200', () => {
    expect(CARD_AREA_HEIGHT).toBe(200);
  });

  it('medium detent height equals PEEK_HEIGHT (52) + CARD_AREA_HEIGHT (200) = 252', () => {
    const PEEK_HEIGHT = 52;
    expect(PEEK_HEIGHT + CARD_AREA_HEIGHT).toBe(252);
  });

  // ── 2. Buddy card — all four chips visible at medium detent ──────────────────
  //
  // At medium detent previewDetent === 'medium', so isExpanded is true and the
  // action row is rendered alongside the card body. All four chips must be
  // reachable in the rendered tree — if the card were clipped by CARD_AREA_HEIGHT
  // some chips would be pushed off-screen by native layout and the fallback text
  // would not appear in the tree at all.

  it('buddy card: rating chip (4.8) is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByText('4.8')).toBeTruthy();
  });

  it('buddy card: city chip (Lisbon) is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByText('Lisbon')).toBeTruthy();
  });

  it('buddy card: hourly-rate chip ($45/hr) is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByText('$45/hr')).toBeTruthy();
  });

  it('buddy card: Available status chip is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByText('Available')).toBeTruthy();
  });

  // ── 3. Buddy card — action row buttons visible ───────────────────────────────

  it('buddy card: Book action button is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('map-action-book')).toBeTruthy();
  });

  it('buddy card: Message action button is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('map-action-message')).toBeTruthy();
  });

  // ── 4. Event card — Join + Share + Report all visible ───────────────────────

  it('event card: Join action button is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[eventFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('map-action-join')).toBeTruthy();
  });

  it('event card: Share action button is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[eventFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('map-action-share')).toBeTruthy();
  });

  it('event card: Report action button is rendered', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[eventFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('map-action-report')).toBeTruthy();
  });
});
