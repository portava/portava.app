/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; sweep SW9): the NOW map's empty states are reached only from a
 * whole, answered read.
 *
 * Two empty states sat beside the unread-layers banner and contradicted it: the carousel's "No results nearby — try
 * adjusting your filters" was drawn whenever no entity survived, and the Time Machine's city timeline said "No city
 * trend to show" whenever it had no band — both over a map whose layers the gateway did not read, or cut, and over a
 * temporal read that failed. Each now says the map could not be read whole instead.
 *
 *   CA1  the carousel, no entities, the map not whole → "Couldn’t load everything here", never "No results nearby"
 *   CA0  CONTROL: no entities, the map whole → "No results nearby"
 *   TL1  the city timeline, no band, not whole → "City trend couldn’t be checked here"
 *   TL0  CONTROL: no band, whole → "No city trend to show" (and "Not enough confirmed signal…" when objects qualified)
 *   TL2  TimeMachineControl hands `timelineNotWhole` to the timeline
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { MapStoreProvider } from '../../../stores/mapStore.tsx';
import { MapCarousel } from '../MapCarousel.tsx';
import { CityTimeline } from '../CityTimeline.tsx';
import { TimeMachineControl } from '../TimeMachineControl.tsx';

// NOTE: exhaustive by design — the carousel's tree calls only these, and a card push is never reached here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useSegments: () => [],
  useFocusEffect: () => {},
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(), addListener: () => () => {} }),
  Link: ({ children }: any) => children,
  Redirect: () => null,
  Stack: { Screen: () => null },
  Tabs: { Screen: () => null },
}));
// NOTE: openDirectThread makes live Supabase fetch calls; stubbed so no card action reaches the network.
jest.mock('../../../services/messaging.ts', () => ({ openDirectThread: jest.fn().mockResolvedValue({ ok: false }) }));

const NOW = new Date('2026-09-30T12:00:00Z');
const EMPTY_TIMELINE = { bands: [], horizonStartsAt: '2026-09-30T10:00:00.000Z', horizonEndsAt: '2026-09-30T16:00:00.000Z', mode: 'forecast' as const, offsetKey: 'r60', qualifyingObjects: 0 };

async function carousel(layersNotWhole: boolean) {
  await render(<MapStoreProvider><MapCarousel entities={[]} activeIndex={0} onIndexChange={() => {}} layersNotWhole={layersNotWhole} /></MapStoreProvider>);
}

describe('census-discovery §115 (SW9): the NOW map never says "nothing here" over a map it did not read whole', () => {
  it('CA1 the carousel with no entities over a map not read whole → says so, never "No results nearby"', async () => {
    await carousel(true);
    expect(screen.queryByText('No results nearby')).toBeNull();
    expect(screen.getByText('Couldn’t load everything here')).toBeTruthy();
  });
  it('CA0 CONTROL: no entities over a whole map → "No results nearby"', async () => {
    await carousel(false);
    expect(screen.getByText('No results nearby')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load everything here')).toBeNull();
  });
  it('TL1 an empty city timeline over a read that was not whole → "City trend couldn’t be checked here"', async () => {
    await render(<CityTimeline timeline={EMPTY_TIMELINE as any} tz="UTC" notWhole />);
    expect(screen.getByText('City trend couldn’t be checked here')).toBeTruthy();
    expect(screen.queryByText('No city trend to show')).toBeNull();
  });
  it('TL0 CONTROL: an empty timeline over a whole read → "No city trend to show"; with qualifying objects, "Not enough…"', async () => {
    await render(<CityTimeline timeline={EMPTY_TIMELINE as any} tz="UTC" />);
    expect(screen.getByText('No city trend to show')).toBeTruthy();
    await render(<CityTimeline timeline={{ ...EMPTY_TIMELINE, qualifyingObjects: 2 } as any} tz="UTC" />);
    expect(screen.getByText('Not enough confirmed signal for a city trend yet')).toBeTruthy();
  });
  it('TL2 TimeMachineControl hands timelineNotWhole to its timeline', async () => {
    await render(<TimeMachineControl offset={{ kind: 'relative', minutes: 60 } as any} onChange={() => {}} now={NOW} tz="UTC" timeline={EMPTY_TIMELINE as any} timelineNotWhole />);
    expect(screen.getByText('City trend couldn’t be checked here')).toBeTruthy();
    await render(<TimeMachineControl offset={{ kind: 'relative', minutes: 60 } as any} onChange={() => {}} now={NOW} tz="UTC" timeline={EMPTY_TIMELINE as any} />);
    expect(screen.getByText('No city trend to show')).toBeTruthy();
  });
});
