/**
 * MapCarousel — action-row integration tests
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 *
 * ## What's covered
 *
 * 1. Action row rendered inside MapEntityCard when detent is 'medium' (default)
 * 2. Action row rendered when detent is 'full'
 * 3. Action row hidden when detent is 'collapsed'
 * 4. Detent switch collapsed → medium re-shows the action row
 * 5. Capability gating — only declared capability buttons appear
 * 6. No action row when entity has no actionCapabilities
 *
 * ## Why MapEntityCard rather than MapCarousel
 *
 * MapCarousel renders entity cards via AnimatedFlatList. Under jest-expo, FlatList
 * does not render its items, so assertions on card content always fail. Exporting
 * MapEntityCard and mounting it directly sidesteps this while still exercising the
 * exact component that owns the action-row visibility logic.
 *
 * ## RNTL React 19 renderer-budget rule
 *
 * After any act() that triggers a React 19 renderer commit, the global `screen`
 * object's `getByTestID` / `queryByTestID` (capital D) variants stop working.
 * We use the query functions returned by render() directly (getByTestId, lowercase d)
 * for all assertions — this works regardless of renderer state.
 *
 * Detent changes are driven via store ref + act(), matching the pattern in
 * mapPhase2c.detent.component.test.tsx.
 */

import React, { useImperativeHandle, forwardRef } from 'react';
import { View } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { MapStoreProvider, useMapStore } from '../../stores/mapStore.tsx';
import type { MapStoreContextValue } from '../../stores/mapStore.tsx';
import { MapEntityCard } from '../map/MapCarousel.tsx';
import type { MapEntity } from '../../types/mapTypes.ts';
import { gemEntity } from '../../__fixtures__/mapEntities.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentional stub — expo-router requires native modules not available under
// jest-expo; spreading requireActual pulls in those modules and crashes the suite.
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

// NOTE: intentional stub — openDirectThread requires a live Supabase session;
// spreading requireActual would pull in network dependencies not available under jest-expo.
jest.mock('../../services/messaging', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: useFollow is a hook whose real implementation makes network calls and manages async
// state — the test must fully control the returned state object to avoid network I/O.
jest.mock('../../hooks/useFollow.ts', () => ({
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

// NOTE: useBlockUser calls blockUser/unblockUser from services/blocks.ts which makes fetch
// calls; the test stubs both to avoid any network I/O.
jest.mock('../../hooks/useBlockUser.ts', () => ({
  useBlockUser: jest.fn(() => ({
    doBlock: jest.fn().mockResolvedValue(true),
    doUnblock: jest.fn().mockResolvedValue(true),
    loading: false,
    error: null,
  })),
}));

// NOTE: PlanPickerController exports a React context provider and hook; the provider pulls in
// modal + trip-fetch side-effects we don't want in unit tests. Only usePlanPicker is needed.
const mockOpenPlanPicker = jest.fn();
jest.mock('../PlanPickerController.tsx', () => ({
  usePlanPicker: () => ({ open: mockOpenPlanPicker, isAdded: () => false }),
}));

// NOTE: events.ts fetches from the API; we only need to assert rsvpEvent is callable.
jest.mock('../../services/events.ts', () => ({
  rsvpEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: openInMaps calls Linking.openURL which is unavailable in jest-expo; stub prevents
// native module access.
jest.mock('../../lib/openInMaps.ts', () => ({
  openInMaps: jest.fn(),
}));

jest.mock('../discovery/TripWishlistPicker.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TripWishlistPicker: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="wishlist-picker" /> : null,
  };
});

jest.mock('../ReportSheet.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ReportSheet: ({ visible }: { visible: boolean }) =>
      visible ? <View testID="report-sheet" /> : null,
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────────────
//
// Built by the REAL projector — see src/__fixtures__/mapEntities.ts. A
// hand-written raw-DTO payload proves nothing about a card whose producer emits
// MapObject.

const gemFixture: MapEntity = gemEntity({
  id: 'carousel-1',
  name: 'Rooftop Terrace',
  category: 'viewpoint',
  city: 'Rome',
  country: 'Italy',
});

const noCapEntity: MapEntity = {
  ...gemFixture,
  id: 'gem:no-caps',
  actionCapabilities: [],
};

/** Stub SharedValue — Reanimated's useAnimatedStyle is mocked by jest-expo. */
const fakeScrollX = { value: 0 } as any;

// ── Prop-capture component (store handle) ──────────────────────────────────────

interface StoreHandle { store: MapStoreContextValue }

const StoreCapture = forwardRef<StoreHandle>(function StoreCapture(_props, ref) {
  const store = useMapStore();
  useImperativeHandle(ref, () => ({ store }), [store]);
  return <View />;
});

// ── Helper ─────────────────────────────────────────────────────────────────────
//
// Returns the render API directly so callers use getByTestId / queryByTestId
// from the render result — these remain stable across act() re-renders unlike
// the global `screen` object's capital-D variants under the React 19 renderer.

async function renderCard(entity: MapEntity, storeRef: React.RefObject<StoreHandle>) {
  return render(
    <MapStoreProvider>
      <StoreCapture ref={storeRef} />
      <MapEntityCard
        entity={entity}
        index={0}
        scrollX={fakeScrollX}
        onPress={jest.fn()}
      />
    </MapStoreProvider>,
  );
}

// ── 1. Action row visible at medium detent (default) ──────────────────────────

describe('MapCarousel action row — medium detent (default)', () => {
  it('renders map-action-row when entity has actionCapabilities', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { getByTestId } = await renderCard(gemFixture, storeRef);

    expect(getByTestId('map-action-row')).toBeTruthy();
  });

  it('renders Save button when save capability is declared', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { getByTestId } = await renderCard(gemFixture, storeRef);

    expect(getByTestId('map-action-save')).toBeTruthy();
  });

  it('renders Share and Directions buttons when declared', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { getByTestId } = await renderCard(gemFixture, storeRef);

    expect(getByTestId('map-action-share')).toBeTruthy();
    expect(getByTestId('map-action-directions')).toBeTruthy();
  });

  it('does not render Join button when capability is absent', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { queryByTestId } = await renderCard(gemFixture, storeRef);

    expect(queryByTestId('map-action-join')).toBeNull();
  });

  it('does not render map-action-row when entity has no capabilities', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { queryByTestId } = await renderCard(noCapEntity, storeRef);

    expect(queryByTestId('map-action-row')).toBeNull();
  });
});

// ── 2. Action row visible at full detent ─────────────────────────────────────

describe('MapCarousel action row — full detent', () => {
  it('renders map-action-row when store detent is set to full', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { getByTestId } = await renderCard(gemFixture, storeRef);

    await act(async () => {
      storeRef.current!.store.setPreviewDetent('full');
    });

    expect(getByTestId('map-action-row')).toBeTruthy();
  });
});

// ── 3. Action row hidden at collapsed detent ──────────────────────────────────

describe('MapCarousel action row — collapsed detent', () => {
  it('hides map-action-row when store detent is set to collapsed', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { queryByTestId } = await renderCard(gemFixture, storeRef);

    await act(async () => {
      storeRef.current!.store.setPreviewDetent('collapsed');
    });

    expect(queryByTestId('map-action-row')).toBeNull();
  });

  it('re-shows map-action-row when detent returns from collapsed to medium', async () => {
    const storeRef = React.createRef<StoreHandle>();
    const { getByTestId, queryByTestId } = await renderCard(gemFixture, storeRef);

    await act(async () => {
      storeRef.current!.store.setPreviewDetent('collapsed');
    });

    expect(queryByTestId('map-action-row')).toBeNull();

    await act(async () => {
      storeRef.current!.store.setPreviewDetent('medium');
    });

    expect(getByTestId('map-action-row')).toBeTruthy();
  });
});
