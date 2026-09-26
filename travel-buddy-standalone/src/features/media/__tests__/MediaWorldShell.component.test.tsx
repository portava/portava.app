/**
 * MediaWorldShell — the six lenses, their §5 modes, and the §14 entry contexts,
 * rendered through the shell itself (census-media §19: MD15 · MD33 · MD21 ·
 * MD25/MD30/MD31/MD35 map modes · MD26 time mode · MD89 · MD90 · MD91 · MD27).
 *
 * What these cases prove that the per-screen suites cannot: that the SHELL
 * mounts the new screens (the HIDDEN GEMS lens is the §16 gem-state screen, not
 * the pre-existing GemsFeed), that each Map / Time mode is the one Media Map /
 * Media Timeline, and that a tap in the Experiences and People lenses stages
 * the right §14 entry-context KIND with a collection scoped to that entity.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MediaWorldShell } from '../screens/MediaWorldShell.tsx';

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
function Shell(props: React.ComponentProps<typeof MediaWorldShell>) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <MediaWorldShell {...props} />
    </SafeAreaProvider>
  );
}
import { getPerspectiveViewerContext, clearPerspectiveViewerContext } from '../state/perspectiveViewerContext.ts';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (href: unknown) => mockPush(href), back: () => {}, replace: () => {} },
}));

const TRIP = '33333333-3333-3333-3333-333333333333';
const EVENT = '44444444-4444-4444-4444-444444444444';

const mockFetchGems = jest.fn();
const mockFetchExperience = jest.fn();
jest.mock('../services/mediaProjection.ts', () => {
  const actual = jest.requireActual('../services/mediaProjection.ts');
  return {
    ...actual,
    fetchWorld: async () => ({ ok: true, data: actual.mapWorldProjection({ city: 'Da Nang', cityVisualState: [], forYouNow: [], changingNow: [] }) }),
    fetchGems: (...a: unknown[]) => mockFetchGems(...a),
    // The lens calls fetchExperiencesByIds; route each id through the one mock so
    // the test controls every experience the lens resolves.
    fetchExperiencesByIds: async (ids: string[]) => {
      const data = [];
      for (const id of ids) {
        const r = await mockFetchExperience(id, {});
        if (r?.ok && r.data) data.push(r.data);
      }
      return { ok: true, data };
    },
    fetchPeople: async () => ({
      ok: true,
      data: actual.mapPeopleProjection({
        people: [
          {
            contributor: { id: 'maya', displayName: 'Maya', verified: true },
            relation: 'followed',
            perspectiveCount: 2,
            freshness: 'fresh',
            media: [
              { id: 'p1', mediaType: 'image', thumbnailUrl: 't', observationClass: 'observed', contributor: { id: 'maya', displayName: 'Maya' } },
              { id: 'p2', mediaType: 'image', thumbnailUrl: 't', observationClass: 'observed', contributor: { id: 'maya', displayName: 'Maya' } },
            ],
          },
        ],
      }),
    }),
    fetchMediaMap: async () => ({ ok: true, data: { clusters: [], totalPerspectives: 0, generatedAt: null } }),
    fetchTimeline: async () => ({ ok: true, data: actual.mapTimeline({}) }),
    fetchMyWorld: async () => ({ ok: true, data: actual.mapMyWorldLibrary({ buckets: [] }) }),
  };
});
// NOTE: intentionally exhaustive — the Experiences lens gathers ids from these
// three canonical services; the real modules pull the Supabase client, and the
// test supplies the canonical rows itself.
jest.mock('../../../services/events.ts', () => ({
  listMyEvents: async () => ({ ok: true, data: { events: [{ id: EVENT }] } }),
  listEvents: async () => ({ ok: true, data: { events: [] } }),
}));
// NOTE: intentionally exhaustive — see the events mock above.
jest.mock('../../../services/trips.ts', () => ({
  listMyTrips: async () => [{ id: TRIP }],
}));
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: async () => ({ ok: true, data: { enabled: false, objects: [] } }),
}));
// NOTE: intentionally exhaustive — imagery is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});

function experienceBody(id: string, kind: 'event' | 'trip', title: string) {
  const { mapExperienceProjection } = jest.requireActual('../services/mediaProjection.ts');
  return {
    ok: true,
    data: mapExperienceProjection({
      id,
      kind,
      title,
      available: true,
      placeIds: [],
      perspectiveCount: 1,
      contributorCount: 1,
      freshness: 'fresh',
      heroMedia: [{ id: `${kind}-media`, mediaType: 'image', thumbnailUrl: 't', observationClass: 'observed' }],
    }),
  };
}

beforeEach(() => {
  mockPush.mockReset();
  clearPerspectiveViewerContext();
  mockFetchGems.mockResolvedValue({
    ok: true,
    data: jest.requireActual('../state/gemLens.ts').mapGemLensProjection({
      gems: [{ gemId: 'g1', name: 'Secret cove', state: 'recently_confirmed', confidence: { score: 0.8, band: 'live' } }],
      determined: true,
      undetermined: [],
    }),
  });
  mockFetchExperience.mockImplementation(async (id: string) =>
    id === TRIP
      ? experienceBody(TRIP, 'trip', 'Vietnam')
      : id === EVENT
        ? experienceBody(EVENT, 'event', 'Beach Festival')
        : experienceBody(id, 'event', 'Linked event'),
  );
});

async function openLens(label: string) {
  await fireEvent.press(screen.getByLabelText(label));
}

describe('MediaWorldShell', () => {
  it('HIDDEN GEMS is the §16 gem-STATE screen (not GemsFeed), scoped by the city label, honouring all three modes', async () => {
    await render(<Shell cityName="Da Nang" lat={16.05} lng={108.22} />);
    await openLens('Hidden Gems');
    await waitFor(() => expect(screen.getByTestId('gem-lens-overview')).toBeTruthy());
    expect(mockFetchGems).toHaveBeenCalledWith(expect.objectContaining({ city: 'Da Nang' }));
    expect(screen.getByTestId('hidden-gem-card-g1')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Visual'));
    await waitFor(() => expect(screen.getByTestId('gem-lens-visual')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Map'));
    // Gems-only Media Map (the gateway is off in this fixture, so it says so).
    await waitFor(() => expect(screen.getByText('No hidden gems on the map yet')).toBeTruthy());
  });

  it('NOW → Map is the one Media Map and NOW → Time is the Media Timeline screen', async () => {
    await render(<Shell cityName="Da Nang" lat={16.05} lng={108.22} />);
    await fireEvent.press(screen.getByLabelText('Map'));
    await waitFor(() => expect(screen.getByText('No perspectives on the map yet')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Time'));
    await waitFor(() => expect(screen.getByTestId('media-timeline-screen')).toBeTruthy());
  });

  it('EXPERIENCES resolves the viewer\'s own events and trips; a Trip opens the TRIP entry context, an Event the EVENT one', async () => {
    await render(<Shell cityName="Da Nang" lat={16.05} lng={108.22} />);
    await openLens('Experiences');
    await waitFor(() => expect(screen.getByLabelText('Vietnam')).toBeTruthy());
    expect(mockFetchExperience).toHaveBeenCalledWith(TRIP, expect.anything());
    expect(mockFetchExperience).toHaveBeenCalledWith(EVENT, expect.anything());

    await fireEvent.press(screen.getByLabelText('Vietnam'));
    let staged = getPerspectiveViewerContext();
    expect(staged?.input.kind).toBe('trip');
    expect(staged?.input.entityId).toBe(TRIP);
    expect(mockPush).toHaveBeenLastCalledWith('/media-perspective/trip-media');

    await fireEvent.press(screen.getByLabelText('Beach Festival'));
    staged = getPerspectiveViewerContext();
    expect(staged?.input.kind).toBe('event');
    expect(staged?.input.entityId).toBe(EVENT);
  });

  it('a deep-linked experience id is resolved first', async () => {
    const LINKED = '55555555-5555-5555-5555-555555555555';
    await render(<Shell cityName="Da Nang" initialLens="experiences" experienceIds={[LINKED]} />);
    await waitFor(() => expect(mockFetchExperience).toHaveBeenCalledWith(LINKED, expect.anything()));
  });

  it('PEOPLE: tapping a person\'s perspective opens the PEOPLE entry context scoped to that person', async () => {
    await render(<Shell cityName="Da Nang" />);
    await openLens('People');
    await waitFor(() => expect(screen.getAllByLabelText('Perspective').length).toBeGreaterThan(0));
    await fireEvent.press(screen.getAllByLabelText('Perspective')[0]!);
    const staged = getPerspectiveViewerContext();
    expect(staged?.input.kind).toBe('people');
    expect(staged?.input.entityId).toBe('maya');
    expect((staged?.input.media ?? []).map((m) => m.id)).toEqual(['p1', 'p2']);
    expect(mockPush).toHaveBeenLastCalledWith(expect.stringMatching(/^\/media-perspective\//));
  });

  it('the header Search opens Media Search, not the global app search', async () => {
    await render(<Shell cityName="Da Nang" />);
    await fireEvent.press(screen.getByLabelText('Search media'));
    expect(mockPush).toHaveBeenCalledWith('/media-search');
  });

  it('MY WORLD → Map is the Media Map over the owner\'s own places', async () => {
    await render(<Shell cityName="Da Nang" lat={16.05} lng={108.22} />);
    await openLens('My World');
    await fireEvent.press(screen.getByLabelText('Map'));
    await waitFor(() => expect(screen.getByText('Your world on the map')).toBeTruthy());
  });
});
