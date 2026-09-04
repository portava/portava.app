/**
 * useMapEntities — the map re-queries when the CAMERA settles (spec §34).
 *
 * WHAT THIS SUITE EXISTS TO CATCH
 * ===============================
 * The hook used to key its fetch on the COMMANDED viewport (a deep-link centre,
 * the city fallback, the store's commanded zoom). The camera DiscoveryMapView
 * actually settled on was deliberately kept out of the fetch key — "a float
 * that changes on every pinch would refetch the projection continuously" — so
 * panning or zooming never re-queried the gateway: the map showed whatever the
 * shell had last aimed at, forever.
 *
 * §34 says the opposite is required, with a guard: "Viewport intelligence
 * response … Debounce after camera settles; never re-query on every pixel
 * movement." So the hook now takes the live `camera`, quantises it to a zoom
 * band and a coarse centre grid, and re-queries once it has been still for the
 * settle debounce. This suite drives the real hook and asserts the three things
 * that make that safe: it DOES re-query on a settle, it does NOT re-query for
 * every intermediate frame of a gesture, and a superseded response can never
 * repaint over the newest one.
 *
 * A short `settleDebounceMs` + real timers + waitFor is used rather than fake
 * timers: fake timers inside async React tests poison later renders in the file
 * (documented in useCityPulse.sessionId.component.test.tsx and
 * PulseLiveCarousel.component.test.tsx). A short window fires naturally.
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';
import type { MapObject } from '../../types/mapObjects.ts';
import type { ToggleableEntityType } from '../../types/mapTypes.ts';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection`
// and `bboxFromCenter`; the bbox stub keeps the centre recoverable so a call's
// viewport can be read back: (west+east)/2 === lng, (south+north)/2 === lat.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, radiusKm: number) => ({
    west: lng - radiusKm / 111,
    south: lat - radiusKm / 111,
    east: lng + radiusKm / 111,
    north: lat + radiusKm / 111,
  }),
}));

// NOTE: exhaustive by design — the hook uses only `searchBuddies` here, and
// requireActual would pull the whole supabase/expo graph into the test.
jest.mock('../../services/rentABuddy.ts', () => ({ searchBuddies: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listMyTrips` from here.
jest.mock('../../services/trips.ts', () => ({ listMyTrips: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listVisibleCircleLocations`.
jest.mock('../../services/map.ts', () => ({ listVisibleCircleLocations: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listEvents` from here.
jest.mock('../../services/events.ts', () => ({ listEvents: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listGems` from here.
jest.mock('../../services/hiddenGems.ts', () => ({ listGems: jest.fn() }));

// NOTE: exhaustive by design — only `mapCache.read`/`.write` are used, and the
// real cache reaches for AsyncStorage on import.
jest.mock('../../features/map/cache/mapCache.ts', () => ({
  mapCache: { read: jest.fn().mockResolvedValue(null), write: jest.fn() },
}));

const { fetchMapProjection } = jest.requireMock('../../services/mapProjection.ts') as {
  fetchMapProjection: jest.Mock;
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

type Camera = { lat: number; lng: number; zoom: number };

/** Bangkok — the commanded centre every case mounts at. */
const BANGKOK = { lat: 13.75, lng: 100.5 };
/** Tokyo — a genuinely different slice of the world, far outside Bangkok's bbox. */
const TOKYO: Camera = { lat: 35.68, lng: 139.76, zoom: 12 };
/** Manila / Chiang Mai — two more far-apart camera rests for the burst case. */
const MANILA: Camera = { lat: 14.6, lng: 120.98, zoom: 13 };
const CHIANG_MAI: Camera = { lat: 18.79, lng: 98.98, zoom: 11 };

function eventObject(id: string, lat: number, lng: number): MapObject {
  return {
    id,
    kind: 'event',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    title: id,
    privacyClass: 'place_level',
    renderingPriority: 50,
  };
}

function envelope(objects: MapObject[]) {
  return {
    ok: true as const,
    data: {
      enabled: true,
      objects,
      viewport: null,
      total: objects.length,
      nextCursor: null,
      sources: ['events'],
      liveEnrichment: { considered: objects.length, enriched: 0, skipped: 0 },
      generatedAt: '2026-09-04T12:00:00.000Z',
    },
  };
}

/** The centre implied by a recorded fetch call's bbox (see the stub above). */
function callCenter(call: { bbox: { west: number; east: number; south: number; north: number } }) {
  const { west, east, south, north } = call.bbox;
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

/** All fetch-call centres so far, oldest first. */
function centers(): { lat: number; lng: number }[] {
  return fetchMapProjection.mock.calls.map((c) => callCenter(c[0]));
}

function near(a: { lat: number; lng: number }, b: { lat: number; lng: number }, deg = 0.3): boolean {
  return Math.abs(a.lat - b.lat) < deg && Math.abs(a.lng - b.lng) < deg;
}

const BASE = {
  enabledLayers: ['events'] as ToggleableEntityType[],
  city: 'Bangkok',
  lat: BANGKOK.lat,
  lng: BANGKOK.lng,
  zoom: 12,
  settleDebounceMs: 30,
};

beforeEach(() => {
  fetchMapProjection.mockReset();
  fetchMapProjection.mockResolvedValue(envelope([eventObject('e1', BANGKOK.lat, BANGKOK.lng)]));
});

afterEach(async () => {
  // A settle fires a fetch whose resolution updates state a beat after this
  // test's own waitFor is satisfied. Drain that (and any pending debounce)
  // inside act so a late update lands in THIS test's act scope rather than
  // bleeding into the next test's — the React 19 + RNTL failure mode the
  // suite header warns about.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useMapEntities — §34 camera settle', () => {
  it('re-queries the gateway for the viewport the camera settled on', async () => {
    // Mount with no live camera: the first fetch runs off the COMMANDED centre
    // (Bangkok) so the map is never blank waiting for a gesture.
    const { rerender } = await renderHook((props: { camera: typeof TOKYO | null }) =>
      useMapEntities({ ...BASE, camera: props.camera }), { initialProps: { camera: null } });

    await waitFor(() => expect(fetchMapProjection).toHaveBeenCalled());
    expect(near(centers()[0], BANGKOK)).toBe(true);

    // The camera settles on Tokyo. After the settle debounce the gateway is
    // asked again — for Tokyo's viewport, not Bangkok's.
    rerender({ camera: TOKYO });
    await waitFor(() => {
      const last = centers()[centers().length - 1];
      expect(near(last, TOKYO)).toBe(true);
    });
  });

  it('debounces: a burst of intermediate frames produces ONE re-query, for the resting frame', async () => {
    // §34: "never re-query on every pixel movement." Far-apart cameras arrive
    // back-to-back in one tick — the gesture's intermediate frames. Only the
    // last (the resting frame) may reach the network: each rerender's effect
    // cleanup clears the prior debounce timer, so only Chiang Mai's survives.
    const { rerender } = await renderHook((props: { camera: typeof TOKYO | null }) =>
      useMapEntities({ ...BASE, camera: props.camera }), { initialProps: { camera: null } });

    await waitFor(() => expect(fetchMapProjection).toHaveBeenCalled());
    const beforeBurst = fetchMapProjection.mock.calls.length;

    // Awaited so each rerender's act fully closes before the next (un-awaited
    // overlapping rerenders corrupt RNTL's act scope, per the suite header).
    // The awaits yield only microtasks, so the 30 ms debounce window never
    // elapses mid-burst: each rerender's effect cleanup clears the prior timer.
    await rerender({ camera: TOKYO });
    await rerender({ camera: MANILA });
    await rerender({ camera: CHIANG_MAI });

    await waitFor(() => {
      const last = centers()[centers().length - 1];
      expect(near(last, CHIANG_MAI)).toBe(true);
    });

    // Exactly one re-query happened for the whole burst, and neither of the
    // frames the gesture passed through (Tokyo, Manila) was ever fetched.
    expect(fetchMapProjection.mock.calls.length).toBe(beforeBurst + 1);
    expect(centers().some((c) => near(c, TOKYO))).toBe(false);
    expect(centers().some((c) => near(c, MANILA))).toBe(false);
  });

  it('discards a superseded response and aborts its request', async () => {
    // The network is slower than the finger: a fetch the user has panned past
    // resolves LATE. Its objects must not repaint over the newer viewport's,
    // and its request must have been aborted at the transport.
    const deferred: {
      resolve: (v: unknown) => void;
      signal: AbortSignal | undefined;
    }[] = [];
    fetchMapProjection.mockImplementation((opts: { signal?: AbortSignal }) =>
      new Promise((resolve) => deferred.push({ resolve, signal: opts.signal })));

    const { result, rerender } = await renderHook((props: { camera: typeof TOKYO | null }) =>
      useMapEntities({ ...BASE, camera: props.camera }), { initialProps: { camera: null } });

    // Mount fetch (index 0) — leave it pending; it is not what this test drives.
    await waitFor(() => expect(deferred.length).toBe(1));

    // Settle on Tokyo → fetch index 1 (the one that will be superseded).
    rerender({ camera: TOKYO });
    await waitFor(() => expect(deferred.length).toBe(2));

    // Settle on Chiang Mai before Tokyo's answer arrives → fetch index 2.
    rerender({ camera: CHIANG_MAI });
    await waitFor(() => expect(deferred.length).toBe(3));

    // The superseding fetch (Chiang Mai) resolves FIRST with its object.
    await act(async () => {
      deferred[2].resolve(envelope([eventObject('chiang-mai', CHIANG_MAI.lat, CHIANG_MAI.lng)]));
    });
    await waitFor(() => expect(result.current.objects.map((o) => o.id)).toContain('chiang-mai'));

    // Now the superseded Tokyo fetch resolves LATE. It must be discarded.
    await act(async () => {
      deferred[1].resolve(envelope([eventObject('tokyo-stale', TOKYO.lat, TOKYO.lng)]));
    });

    expect(result.current.objects.map((o) => o.id)).toContain('chiang-mai');
    expect(result.current.objects.map((o) => o.id)).not.toContain('tokyo-stale');
    // The superseded request was cancelled at the transport, not merely ignored.
    expect(deferred[1].signal?.aborted).toBe(true);
  });

  it('without a camera, nothing settles and the fetch keys on the commanded viewport', async () => {
    // Backward compatibility: ForYou / Discovery surfaces pass no camera. The
    // hook must behave exactly as it did before §34 — one fetch, at Bangkok, no
    // debounce machinery firing a second.
    await renderHook(() => useMapEntities({ ...BASE }));

    await waitFor(() => expect(fetchMapProjection).toHaveBeenCalled());
    // Give any stray debounce longer than its window to (not) fire.
    await new Promise((r) => setTimeout(r, 80));

    expect(fetchMapProjection.mock.calls.length).toBe(1);
    expect(near(centers()[0], BANGKOK)).toBe(true);
  });
});
