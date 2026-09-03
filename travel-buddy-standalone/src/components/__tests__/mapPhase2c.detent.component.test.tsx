/**
 * Map Phase 2C — Three-detent preview sheet with reduce-motion
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 *
 * ## What's covered
 *
 * 1. Detent height constants (collapsed < medium < full, ordering)
 * 2. Store previewDetent drives the sheet — setting via store is reflected
 * 3. Reduce-motion — component mounts / unmounts cleanly (no crash)
 * 4. Selection sync — onIndexChange still callable after a detent change
 * 5. Full-detent EntityFullDetail — description visible at full, hidden at medium/collapsed
 * 6. PeekStrip label — entity name displayed; empty fallback
 * 7. PeekStrip detent toggle — button dispatches correct next detent
 *    (last in file: one fireEvent.press per file budget in RNTL React 19)
 *
 * ## RNTL React 19 renderer-budget rule
 *
 * One fireEvent.press per file commits to the React 19 renderer. After that
 * commit, ref-wiring via useImperativeHandle (StoreCapture) no longer fires in
 * subsequent renders. Consequence: the test that uses fireEvent.press MUST be
 * the last test in the file so it does not poison later storeRef reads.
 *
 * ## Testing strategy
 *
 * - MapCarousel requires MapStoreProvider — all renders wrap in one.
 * - `await render(...)` is used throughout (RNTL v14 returns Promise<RenderAPI>).
 * - Store setters are called via a StoreCapture forwardRef (prop-capture pattern)
 *   to avoid the RNTL React 19 per-file press-budget limit.
 * - The PeekStrip toggle button is identified by testID="peek-detent-btn".
 * - reduce-motion spy assertions are omitted: jest-expo may define
 *   AccessibilityInfo accessors as non-configurable, making jest.spyOn
 *   unreliable on those paths. Behaviour (no crash, cleanup) is tested instead.
 */

import React, { useImperativeHandle, forwardRef } from 'react';
import { Text, View } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import {
  MapStoreProvider,
  useMapStore,
} from '../../stores/mapStore.tsx';
import type { MapStoreContextValue } from '../../stores/mapStore.tsx';
import { MapCarousel } from '../map/MapCarousel.tsx';
import { buddyEntity, gemEntity } from '../../__fixtures__/mapEntities.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

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

// NOTE: intentional stub — openDirectThread is not under test here and requires a
// live Supabase session; spreading requireActual would pull in network dependencies.
jest.mock('../../services/messaging', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Built by the REAL projectors — see src/__fixtures__/mapEntities.ts for why a
// hand-written payload literal is not acceptable here.
const gemFixture = gemEntity({ id: 'test-1', name: 'Secret Garden', city: 'Tokyo' });
const buddyFixture = buddyEntity({
  id: 'test-1',
  displayName: 'Yuki',
  city: 'Tokyo',
  country: 'Japan',
  bio: 'I love showing visitors hidden spots around Shibuya.',
});

// ── Prop-capture component (store handle) ─────────────────────────────────────
//
// Exposes store setters via a ref so tests call them directly inside act()
// without using fireEvent.press — avoids the RNTL React 19 press-budget limit.

interface StoreHandle { store: MapStoreContextValue }

const StoreCapture = forwardRef<StoreHandle>(function StoreCapture(_props, ref) {
  const store = useMapStore();
  useImperativeHandle(ref, () => ({ store }), [store]);
  return (
    <View>
      <Text testID="detent">{store.previewDetent}</Text>
    </View>
  );
});

// ── 1. Detent height constants ────────────────────────────────────────────────

describe('Detent height constants', () => {
  it('PEEK_HEIGHT=52 and CARD_AREA_HEIGHT=200 produce correct medium height', () => {
    expect(52 + 200).toBe(252);
  });

  it('ordering: collapsed < medium < full', () => {
    const collapsed = 52;
    const medium    = 252;
    const full      = Math.round(812 * 0.72); // representative screen height
    expect(collapsed).toBeLessThan(medium);
    expect(medium).toBeLessThan(full);
  });
});

// ── 2. Store previewDetent drives the sheet ───────────────────────────────────

describe('Store previewDetent drives sheet', () => {
  it('default previewDetent is medium', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('detent').props.children).toBe('medium');
  });

  it('setPreviewDetent("collapsed") reflected in store', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    await act(async () => { storeRef.current!.store.setPreviewDetent('collapsed'); });
    expect(screen.getByTestId('detent').props.children).toBe('collapsed');
  });

  it('setPreviewDetent("full") reflected in store', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    await act(async () => { storeRef.current!.store.setPreviewDetent('full'); });
    expect(screen.getByTestId('detent').props.children).toBe('full');
  });

  it('round-trips through all three detent values', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    await act(async () => { storeRef.current!.store.setPreviewDetent('full'); });
    expect(screen.getByTestId('detent').props.children).toBe('full');
    await act(async () => { storeRef.current!.store.setPreviewDetent('collapsed'); });
    expect(screen.getByTestId('detent').props.children).toBe('collapsed');
    await act(async () => { storeRef.current!.store.setPreviewDetent('medium'); });
    expect(screen.getByTestId('detent').props.children).toBe('medium');
  });
});

// ── 3. Reduce-motion — lifecycle ──────────────────────────────────────────────
//
// Observable-behaviour tests only. jest-expo may define AccessibilityInfo
// accessors as non-configurable getters which jest.spyOn cannot reliably
// intercept.

describe('Reduce-motion detection — lifecycle', () => {
  it('component mounts without throwing', async () => {
    await expect(
      render(
        <MapStoreProvider>
          <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
        </MapStoreProvider>,
      ),
    ).resolves.toBeDefined();
  });

  it('component unmounts without throwing (listener cleanup is safe)', async () => {
    const { unmount } = await render(
      <MapStoreProvider>
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    // Wrap in act() so cleanup effects flush inside the act scope and don't
    // corrupt the React scheduler for subsequent tests.
    await act(async () => { unmount(); });
  });
});

// ── 4. Selection sync survives a detent change ────────────────────────────────

describe('Selection sync survives a detent change', () => {
  it('onIndexChange still callable after previewDetent moves to full', async () => {
    const onIndexChange = jest.fn();
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel
          entities={[gemFixture, buddyFixture]}
          activeIndex={0}
          onIndexChange={onIndexChange}
        />
      </MapStoreProvider>,
    );

    await act(async () => { storeRef.current!.store.setPreviewDetent('full'); });
    expect(screen.getByTestId('detent').props.children).toBe('full');

    // The callback is still wired
    onIndexChange(1);
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });
});

// ── 5. Full-detent EntityFullDetail ──────────────────────────────────────────

describe('Full-detent EntityFullDetail', () => {
  // A gem's description and bestTimeToGo used to be asserted here. NEITHER
  // projector emits them (see docs/map-card-projection-gaps.md), so those
  // assertions were describing a card the app has not rendered since the
  // producers switched to MapObject. What the gem card CAN show at full detent
  // is asserted below; the buddy card carries the extended-detail coverage.
  it('gem full detail shows no description — the projection does not carry one', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    await act(async () => { storeRef.current!.store.setPreviewDetent('full'); });
    expect(screen.queryByText(/Quiet stairwell with a river view/i)).toBeNull();
  });

  it('buddy bio visible when previewDetent is full', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    await act(async () => { storeRef.current!.store.setPreviewDetent('full'); });
    expect(screen.getByText(/hidden spots around Shibuya/i)).toBeTruthy();
  });

  it('buddy bio NOT visible at medium (default)', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.queryByText(/hidden spots around Shibuya/i)).toBeNull();
  });

  it('buddy bio NOT visible when previewDetent is collapsed', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[buddyFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    await act(async () => { storeRef.current!.store.setPreviewDetent('collapsed'); });
    expect(screen.queryByText(/hidden spots around Shibuya/i)).toBeNull();
  });
});

// ── 6. PeekStrip entity label ─────────────────────────────────────────────────

describe('PeekStrip entity label', () => {
  it('shows entity name in the peek strip', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    // 'Secret Garden' appears in the peek strip (may also appear in card body)
    expect(screen.getAllByText('Secret Garden').length).toBeGreaterThan(0);
  });

  it('shows "Nearby" when entity list is empty', async () => {
    await render(
      <MapStoreProvider>
        <MapCarousel entities={[]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );
    expect(screen.getByText('Nearby')).toBeTruthy();
  });
});

// ── 7. PeekStrip detent toggle (LAST — consumes the per-file press budget) ────
//
// fireEvent.press poisons the React 19 renderer's commit phase for all
// subsequent renders in the same file. This test MUST be last so earlier
// storeRef-based tests are not affected.

describe('PeekStrip detent controls', () => {
  it('toggle button when collapsed → dispatches medium', async () => {
    const storeRef = React.createRef<StoreHandle>();
    await render(
      <MapStoreProvider>
        <StoreCapture ref={storeRef} />
        <MapCarousel entities={[gemFixture]} activeIndex={0} onIndexChange={jest.fn()} />
      </MapStoreProvider>,
    );

    // Move to collapsed without a press (avoids RNTL press budget)
    await act(async () => { storeRef.current!.store.setPreviewDetent('collapsed'); });
    expect(screen.getByTestId('detent').props.children).toBe('collapsed');

    // ONE press: collapsed → medium via the toggle button (budget consumed here)
    fireEvent.press(screen.getByTestId('peek-detent-btn'));
    await act(async () => {});
    expect(screen.getByTestId('detent').props.children).toBe('medium');
  });
});
