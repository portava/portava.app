/**
 * census-media §29 (MD300): the Media Map draws each cluster's server-chosen
 * cover, and reads through the §39 `map_thumbnails` cache — on the standalone
 * map and in the Places and Experiences Map modes, which each pass their own
 * cluster source.
 *
 * The cache runs for REAL here (MediaCache over in-memory storage and files);
 * only the network half is stubbed. So "offline" below is the real
 * cache-through rule answering: the map a previous online view stored, re-aged
 * and labelled. What each case proves on the screen:
 *   • a cover is drawn on the map cluster AND on its list row, through the
 *     signing image component; a video is drawn by its poster, never its file;
 *   • a cluster with no cover is drawn as before (the count bubble, the pin);
 *   • a live answer carries no cached label; a cached one says its age;
 *   • each lens's own loader reads through the cache: offline, each still
 *     draws, and says so.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaMapScreen } from '../screens/MediaMapScreen.tsx';
import { MediaPlacesScreen } from '../screens/MediaPlacesScreen.tsx';
import { MediaExperiencesScreen } from '../screens/MediaExperiencesScreen.tsx';
import { MediaCache, _setMediaCache, type CacheEnv } from '../../../services/media/mediaCache.ts';
import { StyleSheet } from 'react-native';
import { color } from '../../../theme/tokens.ts';

const mockFetchMediaMap = jest.fn();
const mockFetchMapProjection = jest.fn();

jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchMediaMap: (...args: unknown[]) => mockFetchMediaMap(...args),
  fetchPlaceView: async () => ({ ok: true, data: null }),
  fetchExperience: async (id: string) => ({
    ok: true,
    data: {
      id, kind: 'trip', title: 'Da Nang week', placeIds: ['11111111-1111-4111-8111-111111111111'], tripId: id,
      perspectiveCount: 2, contributorCount: 1, freshness: 'recent', heroMedia: [],
    },
  }),
}));
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: (...args: unknown[]) => mockFetchMapProjection(...args),
}));
// NOTE: intentionally exhaustive — the image layer is not under test; this
// stand-in records WHICH reference each cover was drawn with.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return {
    CachedImage: ({ source, testID }: { source?: { uri?: string }; testID?: string }) => (
      <View testID={testID} accessibilityLabel={source?.uri} />
    ),
  };
});
// NOTE: intentionally exhaustive — the global maplibre stub renders nothing for
// children; this one renders them, so a marker's cover is on screen to assert.
jest.mock('@maplibre/maplibre-react-native', () => {
  const { View } = require('react-native');
  const Pass = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>;
  return { Map: Pass, Camera: () => null, Marker: Pass, GeoJSONSource: Pass, Layer: () => null };
});

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const TRIP = '44444444-4444-4444-8444-444444444444';
const CENTER = { lat: 16.05, lng: 108.22 };
const MIN = 60_000;

function cover(id: string, extra: Record<string, unknown>) {
  return { id, mediaType: 'image', observationClass: 'observed', freshness: 'fresh', ageMinutes: 5, ...extra };
}

const LIVE_MAP = {
  ok: true,
  data: {
    generatedAt: '2026-09-26T00:00:00Z',
    totalPerspectives: 12,
    clusters: [
      { placeId: P1, label: 'An Thuong', perspectiveCount: 8, freshness: 'fresh', cover: cover('c1', { url: 'post-media/u/c1.jpg', thumbnailUrl: 'post-media/u/c1.thumb.jpg' }) },
      { placeId: P2, label: 'My Khe', perspectiveCount: 3, freshness: 'recent', cover: null },
      { placeId: P3, label: 'Son Tra', perspectiveCount: 1, freshness: 'recent', cover: cover('v1', { mediaType: 'video', url: 'post-media/u/v1.mp4', thumbnailUrl: 'post-media/u/v1.mp4.poster.jpg' }) },
    ],
  },
};
const OUTAGE = { ok: false, data: null, errorKind: 'network', message: 'Network error' };

function placed(ids: string[]) {
  return {
    ok: true,
    data: {
      enabled: true,
      objects: ids.map((id, i) => ({
        id: `place:${id}`, kind: 'place', title: id, privacyClass: 'place_level', renderingPriority: 1,
        geometry: { type: 'Point', coordinates: [108.2 + i / 100, 16.05] },
      })),
    },
  };
}

/** WCAG 2.x contrast of two solid `#rrggbb` colours. */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`not a solid #rrggbb colour: ${hex}`);
    const n = parseInt(m[1]!, 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

let clock = 1_000_000;
let cache: MediaCache;

function memoryEnv(): CacheEnv {
  const store = new Map<string, string>();
  return {
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => { store.set(k, v); },
      removeItem: async (k) => { store.delete(k); },
    },
    files: {
      dirFor: (a) => `file:///docs/media-offline/${a}/`,
      download: async () => 1000,
      remove: async () => {},
    },
    accountId: async () => 'acct-A',
    now: () => clock,
    sign: async (refs) => Object.fromEntries(refs.map((r) => [r, `https://signed.test/${r}`])),
  };
}

/** The online view stored the map; wait until it is on the device. */
async function stored(): Promise<void> {
  await waitFor(async () => expect((await cache.inventory()).map((e) => e.scope)).toContain('map_thumbnails'));
}

beforeEach(() => {
  clock = 1_000_000;
  cache = new MediaCache(memoryEnv());
  _setMediaCache(cache);
  mockFetchMediaMap.mockReset();
  mockFetchMapProjection.mockReset();
  mockFetchMediaMap.mockResolvedValue(LIVE_MAP);
  mockFetchMapProjection.mockResolvedValue(placed([P1, P2, P3]));
});
afterEach(() => _setMediaCache(null));

describe('census-media §29 (MD300) — the Media Map draws covers, and reads through the §39 cache', () => {
  it('draws each cluster\'s cover on its map cluster and its list row; a video by its poster; no cover ⇒ drawn as before', async () => {
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cover-${P1}`)).toBeTruthy());
    // On the map cluster, through the signing image component, with the server's own reference.
    expect(screen.getByTestId(`media-map-cover-${P1}`).props.accessibilityLabel).toBe('post-media/u/c1.thumb.jpg');
    expect(screen.getByTestId(`media-map-row-cover-${P1}`).props.accessibilityLabel).toBe('post-media/u/c1.thumb.jpg');
    // A video is drawn by its poster, never by the video file.
    expect(screen.getByTestId(`media-map-cover-${P3}`).props.accessibilityLabel).toBe('post-media/u/v1.mp4.poster.jpg');
    // No cover: the count bubble and the pin, exactly as before covers.
    expect(screen.queryByTestId(`media-map-cover-${P2}`)).toBeNull();
    expect(screen.queryByTestId(`media-map-row-cover-${P2}`)).toBeNull();
    expect(screen.getByTestId(`media-map-cluster-${P2}`)).toBeTruthy();
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    // A live answer is not labelled as cached.
    expect(screen.queryByTestId('media-map-cached')).toBeNull();
  });

  it('offline, the standalone map is the one the cache stored — aged, labelled "Cached · updated 3h ago", covers still drawn', async () => {
    const online = await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cover-${P1}`)).toBeTruthy());
    await stored();
    await online.unmount();

    clock += 3 * 60 * MIN;
    mockFetchMediaMap.mockResolvedValue(OUTAGE);
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-cached')).toBeTruthy());
    expect(screen.getByText('Cached · updated 3h ago')).toBeTruthy();
    expect(screen.getByTestId(`media-map-cover-${P1}`).props.accessibilityLabel).toBe('post-media/u/c1.thumb.jpg');
    expect(screen.getByTestId(`media-map-row-${P2}`)).toBeTruthy();
    expect(screen.queryByText('The Media Map could not load')).toBeNull();
  });

  it('PLACES lens: its one-place Map reads through the same cache — offline it still draws that place, and says it is cached', async () => {
    const online = await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cover-${P1}`)).toBeTruthy());
    await stored();
    await online.unmount();

    clock += 2 * 60 * MIN;
    mockFetchMediaMap.mockResolvedValue(OUTAGE);
    await render(<MediaPlacesScreen mode="map" zones={[]} city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-row-${P1}`)).toBeTruthy());
    // Open An Thuong: PlaceDetail's own Map loader (this place only).
    await fireEvent.press(screen.getByTestId(`media-map-row-${P1}`));
    await waitFor(() => expect(screen.getByTestId('media-map-open-cluster')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-map-open-cluster'));
    await waitFor(() => expect(screen.getByText('Da Nang · An Thuong')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('media-map-cached')).toBeTruthy());
    expect(screen.getByText('Cached · updated 2h ago')).toBeTruthy();
    expect(screen.getByTestId(`media-map-cover-${P1}`)).toBeTruthy();
    expect(screen.queryByTestId(`media-map-row-${P2}`)).toBeNull(); // only this place
  });

  it('a SELECTED count bubble keeps its count readable — ink on the onInk fill (found by lane H, census-media §27)', async () => {
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cluster-${P2}`)).toBeTruthy());
    const unselected = StyleSheet.flatten(screen.getByTestId(`media-map-cluster-count-${P2}`).props.style);
    await fireEvent.press(screen.getByTestId(`media-map-cluster-${P2}`));
    await waitFor(() => expect(screen.getByTestId('media-map-selected')).toBeTruthy());
    const fill = StyleSheet.flatten(screen.getByTestId(`media-map-cluster-${P2}`).props.style).backgroundColor as string;
    const text = StyleSheet.flatten(screen.getByTestId(`media-map-cluster-count-${P2}`).props.style).color as string;
    expect(fill).toBe(color.onInk); // the selected fill this fix does not touch
    expect(text).not.toBe(fill);
    expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(4.5); // WCAG AA for 12 px text; 3:1 is the floor asked for
    expect(unselected.color).toBe(color.onInk); // unselected is unchanged
  });

  it('EXPERIENCES lens: its Map reads through the same cache — offline it draws the trip\'s place, with its cover, labelled', async () => {
    const online = await render(<MediaExperiencesScreen mode="map" experienceIds={[TRIP]} city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cover-${P1}`)).toBeTruthy());
    expect(screen.queryByTestId(`media-map-row-${P2}`)).toBeNull(); // only the trip's own places
    expect(screen.queryByTestId('media-map-cached')).toBeNull();
    await stored();
    await online.unmount();

    clock += 60 * MIN;
    mockFetchMediaMap.mockResolvedValue(OUTAGE);
    await render(<MediaExperiencesScreen mode="map" experienceIds={[TRIP]} city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-cached')).toBeTruthy());
    expect(screen.getByText('Cached · updated 1h ago')).toBeTruthy();
    expect(screen.getByTestId(`media-map-cover-${P1}`).props.accessibilityLabel).toBe('post-media/u/c1.thumb.jpg');
  });
});
