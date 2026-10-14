/**
 * "WHERE THE NIGHT IS MOVING" rendered through the World shell's NOW lens
 * (spec §22; census-media MD162 §51; lead ruling D-26d).
 *
 * What these cases prove that the pure suite (crowdFlowPairing.test.ts) cannot:
 * that the NOW lens MOUNTS the card, that it reads the canonical Map gateway for
 * `crowd_flow` only, that the rendered tree carries zone names and perspective
 * counts and nothing of the flow's geometry or cohort, that every refusal leaves
 * the dashboard exactly as it was (no card, no "nothing is moving"), and that a
 * tap opens the busiest place through the §14 cluster opener.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MediaWorldShell } from '../screens/MediaWorldShell.tsx';
import { CrowdFlowCard, NIGHT_FLOW_HEADING } from '../components/CrowdFlowCard.tsx';
import type { NightFlowCardModel } from '../state/crowdFlowPairing.ts';

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
function Shell(props: React.ComponentProps<typeof MediaWorldShell>) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <MediaWorldShell {...props} />
    </SafeAreaProvider>
  );
}

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (href: unknown) => mockPush(href), back: () => {}, replace: () => {} },
}));

const A = ['a1111111-0000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000002', 'a1111111-0000-0000-0000-000000000003'];
const B = ['b2222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000002', 'b2222222-0000-0000-0000-000000000003'];
const OUTSIDE = 'c3333333-0000-0000-0000-000000000009';
const COHORT = 23;

const mockFetchMediaMap = jest.fn();
const mockFetchPlaceView = jest.fn();
jest.mock('../services/mediaProjection.ts', () => {
  const actual = jest.requireActual('../services/mediaProjection.ts');
  return {
    ...actual,
    fetchWorld: async () => ({
      ok: true,
      data: actual.mapWorldProjection({
        city: 'Da Nang',
        cityVisualState: [{ placeId: '66666666-6666-6666-6666-666666666666', label: 'My Khe', perspectiveCount: 3, freshness: 'fresh' }],
        forYouNow: [],
        changingNow: [],
        generatedAt: new Date().toISOString(),
      }),
    }),
    fetchMediaMap: (...a: unknown[]) => mockFetchMediaMap(...a),
    fetchPlaceView: (...a: unknown[]) => mockFetchPlaceView(...a),
    fetchTimeline: async () => ({ ok: true, data: actual.mapTimeline({}) }),
  };
});
// NOTE: intentionally exhaustive — the shell's experience sources pull the Supabase client.
jest.mock('../../../services/events.ts', () => ({
  listMyEvents: async () => ({ ok: true, data: { events: [] } }),
  listEvents: async () => ({ ok: true, data: { events: [] } }),
}));
// NOTE: intentionally exhaustive — see the events mock above.
jest.mock('../../../services/trips.ts', () => ({
  listMyTrips: async () => [],
}));
const mockFetchMapProjection = jest.fn();
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: (...a: unknown[]) => mockFetchMapProjection(...a),
}));
// NOTE: intentionally exhaustive — imagery is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});

type End = Partial<{ name: string | null; placeIds: string[]; placesStatus: string; placesPartial: boolean }>;

/** A `crowd_flow` object as the gateway serves it once attachFlowEndpoints has named its ends. */
function servedFlow(opts: { from?: End; to?: End; expiresAt?: string } = {}) {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    id: 'flow:zone-beach:zone-anthuong',
    kind: 'crowd_flow',
    geometry: { type: 'LineString', coordinates: [[108.24117, 16.06023], [108.24561, 16.04398]] },
    title: 'Moderate movement',
    subtitle: `${COHORT} travelers moving`,
    observedAt,
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    freshness: 'live',
    confidence: 'likely',
    privacyClass: 'aggregate_only',
    renderingPriority: 60,
    count: COHORT,
    payload: {
      observed: { flowState: 'moderate_movement', fromZoneId: 'zone-beach', toZoneId: 'zone-anthuong', cohortSize: COHORT, signalFamilies: ['next_stop', 'route_plan'], windowMinutes: 30, observedAt },
      inferred: null,
      endpoints: {
        from: { zoneId: 'zone-beach', name: 'Beachfront', placeIds: A, placesStatus: 'listed', placesPartial: false, ...opts.from },
        to: { zoneId: 'zone-anthuong', name: 'An Thuong', placeIds: B, placesStatus: 'listed', placesPartial: false, ...opts.to },
      },
    },
  };
}

function gatewayServes(objects: unknown[], extra: { enabled?: boolean; sources?: string[] } = {}) {
  mockFetchMapProjection.mockResolvedValue({
    ok: true,
    data: { enabled: extra.enabled ?? true, objects, sources: extra.sources ?? ['crowd_flow'], viewport: null, total: objects.length, nextCursor: null, liveEnrichment: null, generatedAt: new Date().toISOString() },
  });
}

function countsServe(clusters: Array<{ placeId: string; label: string; perspectiveCount: number; freshness: string | null }>) {
  mockFetchMediaMap.mockResolvedValue({
    ok: true,
    data: { clusters: clusters.map((c) => ({ ...c, cover: null })), totalPerspectives: clusters.reduce((s, c) => s + c.perspectiveCount, 0), generatedAt: null },
  });
}

const COUNTS = [
  { placeId: A[0], label: 'Sea Bar', perspectiveCount: 4, freshness: 'fresh' },
  { placeId: A[2], label: 'Pier', perspectiveCount: 1, freshness: 'recent' },
  { placeId: B[1], label: 'Roof', perspectiveCount: 7, freshness: 'recent' },
  { placeId: B[2], label: 'Corner', perspectiveCount: 2, freshness: 'fresh' },
  // Labelled like the destination zone, but NOT in its list: never paired.
  { placeId: OUTSIDE, label: 'An Thuong', perspectiveCount: 50, freshness: 'fresh' },
];

beforeEach(() => {
  mockPush.mockReset();
  mockFetchMediaMap.mockReset();
  mockFetchPlaceView.mockReset();
  mockFetchMapProjection.mockReset();
  mockFetchPlaceView.mockResolvedValue({ ok: true, data: null });
  gatewayServes([servedFlow()]);
  countsServe(COUNTS);
});

/**
 * Let every pending read resolve and every resulting render commit. A "no card"
 * assertion made before the reads finish would pass for the wrong reason.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
  });
}

/** The NOW dashboard has settled once its own City Visual State is on screen. */
async function renderNow() {
  await render(<Shell cityName="Da Nang" lat={16.06} lng={108.24} />);
  await waitFor(() => expect(screen.getByText('My Khe')).toBeTruthy());
}

describe('NOW lens — where the night is moving (census-media MD162)', () => {
  it('pairs a served flow\'s two named ends with the recent perspectives at THEIR listed places', async () => {
    await renderNow();
    await waitFor(() => expect(screen.getByText(NIGHT_FLOW_HEADING)).toBeTruthy());
    expect(screen.getByText('Beachfront')).toBeTruthy();
    expect(screen.getByText('5 perspectives')).toBeTruthy(); // 4 + 1 at Beachfront's listed places
    expect(screen.getByText('An Thuong')).toBeTruthy();
    expect(screen.getByText('9 perspectives')).toBeTruthy(); // 7 + 2; the 50 at OUTSIDE are not An Thuong's
    expect(screen.queryByText('59 perspectives')).toBeNull();
    expect(screen.getByText('Activity appears to be moving toward An Thuong')).toBeTruthy();

    // The canonical gateway, asked for crowd_flow only, around the coarse center; counts for the city.
    expect(mockFetchMapProjection).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['crowd_flow'] }));
    expect(mockFetchMediaMap).toHaveBeenCalledWith(expect.objectContaining({ city: 'Da Nang' }));
  });

  it('renders no line, no coordinate, no cohort and no zone id — only names, counts and the sentence', async () => {
    await renderNow();
    await waitFor(() => expect(screen.getByTestId('night-flow-card')).toBeTruthy());
    // Every host element and prop the screen painted: text, labels, test ids, styles.
    const painted = JSON.stringify(screen.toJSON());
    expect(painted.includes('Activity appears to be moving toward An Thuong')).toBe(true); // anti-vacuity
    for (const needle of ['108.24117', '16.06023', '108.24561', '16.04398', 'LineString', 'coordinates', 'zone-beach', 'zone-anthuong', `${COHORT} travelers`, 'Moderate movement', 'next_stop']) {
      expect(painted.includes(needle)).toBe(false);
    }
  });

  it('a tap on an end opens its busiest recent place through the §14 cluster opener', async () => {
    await renderNow();
    await waitFor(() => expect(screen.getByTestId('night-flow-0-to')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('night-flow-0-to'));
    await waitFor(() => expect(mockFetchPlaceView).toHaveBeenCalledWith(B[1]));
  });

  it('an UNREAD end or a PARTIAL end renders no card, and the dashboard is unchanged', async () => {
    for (const flow of [servedFlow({ to: { placesStatus: 'unread', placeIds: [] } }), servedFlow({ from: { placesPartial: true } })]) {
      gatewayServes([flow]);
      const view = await render(<Shell cityName="Da Nang" lat={16.06} lng={108.24} />);
      await waitFor(() => expect(screen.getByText('My Khe')).toBeTruthy());
      await waitFor(() => expect(mockFetchMapProjection).toHaveBeenCalled());
      await settle();
      expect(screen.queryByText(NIGHT_FLOW_HEADING)).toBeNull();
      expect(mockFetchMediaMap).not.toHaveBeenCalled();
      await view.unmount();
      mockFetchMapProjection.mockClear();
    }
  });

  it('a failed gateway read, a disabled gateway, or a layer it did not produce: no card, never "nothing is moving"', async () => {
    for (const arrange of [
      () => mockFetchMapProjection.mockResolvedValue({ ok: false, error: 'Network error' }),
      () => gatewayServes([servedFlow()], { enabled: false, sources: [] }),
      () => gatewayServes([servedFlow()], { sources: ['place'] }),
    ]) {
      arrange();
      const view = await render(<Shell cityName="Da Nang" lat={16.06} lng={108.24} />);
      await waitFor(() => expect(screen.getByText('My Khe')).toBeTruthy());
      await waitFor(() => expect(mockFetchMapProjection).toHaveBeenCalled());
      await settle();
      expect(screen.queryByText(NIGHT_FLOW_HEADING)).toBeNull();
      expect(screen.queryByText(/nothing is moving|quiet/i)).toBeNull();
      expect(mockFetchMediaMap).not.toHaveBeenCalled();
      await view.unmount();
      mockFetchMapProjection.mockReset();
    }
  });

  it('a failed count read renders no card: a flow is never shown without its perspectives', async () => {
    mockFetchMediaMap.mockResolvedValue({ ok: false, data: null, errorKind: 'server', message: 'HTTP 500' });
    await renderNow();
    await waitFor(() => expect(mockFetchMediaMap).toHaveBeenCalled());
    await settle();
    expect(screen.queryByText(NIGHT_FLOW_HEADING)).toBeNull();
    expect(screen.queryByText('Beachfront')).toBeNull();
  });

  it('no recent perspective at either end: no card', async () => {
    countsServe([
      { placeId: A[0], label: 'Sea Bar', perspectiveCount: 4, freshness: 'historical' },
      { placeId: OUTSIDE, label: 'An Thuong', perspectiveCount: 50, freshness: 'fresh' },
    ]);
    await renderNow();
    await waitFor(() => expect(mockFetchMediaMap).toHaveBeenCalled());
    await settle();
    expect(screen.queryByText(NIGHT_FLOW_HEADING)).toBeNull();
  });

  it('without a location nothing is read and nothing renders', async () => {
    await render(<Shell cityName="Da Nang" />);
    await waitFor(() => expect(screen.getByText('My Khe')).toBeTruthy());
    await settle();
    expect(mockFetchMapProjection).not.toHaveBeenCalled();
    expect(screen.queryByText(NIGHT_FLOW_HEADING)).toBeNull();
  });

  it('the card leaves the screen when its flow expires', async () => {
    gatewayServes([servedFlow({ expiresAt: new Date(Date.now() + 1500).toISOString() })]);
    await renderNow();
    await waitFor(() => expect(screen.getByText(NIGHT_FLOW_HEADING)).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(NIGHT_FLOW_HEADING)).toBeNull(), { timeout: 4000 });
  });
});

describe('CrowdFlowCard', () => {
  const card = (over: Partial<NightFlowCardModel> = {}): NightFlowCardModel => ({
    key: 'flow:x:y',
    from: { name: 'Beachfront', perspectiveCount: 0, freshness: null, top: null },
    to: { name: 'An Thuong', perspectiveCount: 3, freshness: 'fresh', top: { placeId: B[0], label: 'Roof', perspectiveCount: 3, freshness: 'fresh' } },
    sentence: 'Activity appears to be moving toward An Thuong',
    liveUntilMs: Date.now() + 60_000,
    ...over,
  });

  it('an end with nothing paired shows its NAME only — never "no perspectives" — and is not a button', async () => {
    const onOpenEnd = jest.fn();
    await render(<CrowdFlowCard cards={[card()]} onOpenEnd={onOpenEnd} />);
    expect(screen.getByText('Beachfront')).toBeTruthy();
    expect(screen.queryByText(/0 perspectives|no perspectives/i)).toBeNull();
    await fireEvent.press(screen.getByTestId('night-flow-0-from'));
    expect(onOpenEnd).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('night-flow-0-to'));
    expect(onOpenEnd).toHaveBeenCalledWith(expect.objectContaining({ placeId: B[0] }));
  });

  it('no cards: renders nothing at all', async () => {
    const view = await render(<CrowdFlowCard cards={[]} />);
    expect(view.toJSON()).toBeNull();
  });
});
