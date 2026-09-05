/**
 * useMapEntities — every optional §16 layer flag is a FETCH KEY (Map spec §16).
 *
 * WHAT THIS SUITE EXISTS TO CATCH
 * ===============================
 * The six optional §16 layers (Crowd Flow, Relevant Places, Saved, Memories,
 * Safety, Trip meeting points) do not ride inside `enabledLayers`. Each arrives
 * on its own hook option, resolved by the map shell from a §16 preference that
 * loads ASYNCHRONOUSLY and that the viewer can toggle at any time.
 *
 * `doFetch` reads all six. It is a `useCallback`, and the only effect that runs
 * it depends on its identity — so a flag the callback reads but does not DEPEND
 * on is frozen at whatever value it held on mount. The layer can then be
 * switched on and never load, for the whole session, with no error and no empty
 * state: the request simply never names its kind.
 *
 * That is what had happened to §16 Crowd Flow — `crowdFlow` was absent from the
 * dependency array while being read twice in the callback (the all-off early
 * return and the `wantedKinds` build). The layer never loaded after mount.
 *
 * So this suite does not test crowd flow specially. It walks EVERY optional
 * flag through the same toggle and asserts the requested `kinds` follow, which
 * is the invariant the dep array has to keep — and it drives the real hook over
 * the real transport boundary, so a future omission fails here rather than
 * shipping as a silently dead layer.
 *
 * Real timers + waitFor, no fake timers: fake timers inside async React tests
 * poison later renders in the same file (see useMapEntities.cameraSettle).
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { useMapEntities, GATEWAY_KIND_FOR_OPTIONAL_LAYER } from '../useMapEntities.ts';
import type { ToggleableEntityType } from '../../types/mapTypes.ts';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection`
// and `bboxFromCenter` from this module.
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

const BANGKOK = { lat: 13.75, lng: 100.5 };

function envelope() {
  return {
    ok: true as const,
    data: {
      enabled: true,
      objects: [],
      viewport: null,
      total: 0,
      nextCursor: null,
      sources: ['events'],
      liveEnrichment: { considered: 0, enriched: 0, skipped: 0 },
      generatedAt: '2026-09-05T12:00:00.000Z',
    },
  };
}

/**
 * Stable array identities. `enabledLayers` is itself a fetch key, so a fresh
 * `[]` per render would re-key the callback on every render and spin.
 */
const EVENTS_ONLY: ToggleableEntityType[] = ['events'];
const NO_LAYERS: ToggleableEntityType[] = [];

const BASE = {
  enabledLayers: EVENTS_ONLY,
  city: 'Bangkok',
  lat: BANGKOK.lat,
  lng: BANGKOK.lng,
  zoom: 12,
};

/** The `kinds` of the most recent gateway call. */
function lastKinds(): string[] {
  const calls = fetchMapProjection.mock.calls;
  return (calls[calls.length - 1]?.[0]?.kinds ?? []) as string[];
}

/**
 * Every optional flag, with the gateway kind it must add. Read from the hook's
 * OWN map rather than restated, so a rename cannot make this suite vacuous.
 */
const OPTIONAL_FLAGS: { option: string; kind: string }[] = [
  { option: 'crowdFlow', kind: GATEWAY_KIND_FOR_OPTIONAL_LAYER.crowd_flow },
  { option: 'places', kind: GATEWAY_KIND_FOR_OPTIONAL_LAYER.relevant_places },
  { option: 'saved', kind: GATEWAY_KIND_FOR_OPTIONAL_LAYER.saved },
  { option: 'memories', kind: GATEWAY_KIND_FOR_OPTIONAL_LAYER.memories },
  { option: 'safety', kind: GATEWAY_KIND_FOR_OPTIONAL_LAYER.safety },
  { option: 'meetingPoints', kind: GATEWAY_KIND_FOR_OPTIONAL_LAYER.meeting_point },
];

beforeEach(() => {
  fetchMapProjection.mockReset();
  fetchMapProjection.mockResolvedValue(envelope());
});

afterEach(async () => {
  // Drain a late state update into THIS test's act scope rather than the next
  // test's — the React 19 + RNTL failure mode the cameraSettle suite documents.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('useMapEntities — toggling an optional §16 layer re-requests it', () => {
  for (const { option, kind } of OPTIONAL_FLAGS) {
    it(`${option}: switching it ON after mount adds '${kind}' to the requested kinds`, async () => {
      const { rerender } = await renderHook((props: { on: boolean }) =>
        useMapEntities({ ...BASE, [option]: props.on }), { initialProps: { on: false } });

      await waitFor(() => expect(fetchMapProjection).toHaveBeenCalled());
      expect(lastKinds()).not.toContain(kind);

      // The viewer switches the layer on (or its §16 preference resolves).
      await rerender({ on: true });
      await waitFor(() => expect(lastKinds()).toContain(kind));
    });

    it(`${option}: switching it OFF again stops requesting '${kind}'`, async () => {
      const { rerender } = await renderHook((props: { on: boolean }) =>
        useMapEntities({ ...BASE, [option]: props.on }), { initialProps: { on: true } });

      await waitFor(() => expect(lastKinds()).toContain(kind));

      // A layer switched off must not keep arriving to be filtered on-device.
      await rerender({ on: false });
      await waitFor(() => expect(lastKinds()).not.toContain(kind));
    });
  }

  for (const { option, kind } of OPTIONAL_FLAGS) {
    it(`${option}: it is the ONLY thing on — the all-off guard reads it too`, async () => {
      // The early return that means "nothing enabled" reads the same six flags.
      // A stale reading there swallows the fetch entirely, so a viewer with
      // every legacy pin layer off and one §16 layer on sees a permanently
      // empty map rather than a late one.
      const { rerender } = await renderHook((props: { on: boolean }) =>
        useMapEntities({ ...BASE, enabledLayers: NO_LAYERS, [option]: props.on }),
        { initialProps: { on: false } });

      // Nothing at all is on: the guard fires and no request is made.
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(fetchMapProjection).not.toHaveBeenCalled();

      await rerender({ on: true });
      await waitFor(() => expect(fetchMapProjection).toHaveBeenCalled());
      expect(lastKinds()).toEqual([kind]);
    });
  }
});
