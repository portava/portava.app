/**
 * useMapEntities — the place_intel cache is one account's, and only while that
 * account is the one asking.
 *
 * WHAT THIS SUITE EXISTS TO CATCH
 * ===============================
 * The hook used to write its whole merged object list through to the cache
 * under the bare city name (`mapCache.write('place_intel', city, merged)`) and
 * seed from the same key. `merged` carries the viewer's own trip stops and crew
 * members, and with the §16 options on, their saved places, memory pins and
 * personal-city objects. AsyncStorage is device-local and is not cleared on
 * sign-out, so the next account to open the map in that city was seeded from
 * the previous account's private objects.
 *
 * The key fix is pinned as a unit contract next door, in
 * features/map/cache/__tests__/placeIntelCacheScoping.test.ts. THIS suite is
 * for the two things a key fix alone does not close, both of which need the
 * real hook:
 *
 *   - a response fetched AS ONE ACCOUNT that resolves AFTER a switch must
 *     neither render for the next account nor be written into any cache;
 *   - entries written under a superseded cache version must be erased from the
 *     device, not merely made unreachable.
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';
import type { MapObject } from '../../types/mapObjects.ts';
import { placeObject } from '../../__fixtures__/mapEntities.ts';

// NOTE: exhaustive by design — useMapEntities imports exactly
// `fetchMapProjection` and `bboxFromCenter` from this module; requireActual
// would drag in the API token + supabase client for a pure bbox helper.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, radiusKm: number) => ({
    west: lng - radiusKm / 111,
    south: lat - radiusKm / 111,
    east: lng + radiusKm / 111,
    north: lat + radiusKm / 111,
  }),
}));

// The five legacy transports. Each mock is exhaustive by design: the hook
// imports exactly ONE function from each of these modules, and requireActual
// would pull the whole supabase/expo graph into a test that only needs to
// observe whether the call happened.

// NOTE: exhaustive by design — the hook uses only `searchBuddies` from here.
jest.mock('../../services/rentABuddy.ts', () => ({ searchBuddies: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listMyTrips` from here.
jest.mock('../../services/trips.ts', () => ({ listMyTrips: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listVisibleCircleLocations`.
jest.mock('../../services/map.ts', () => ({ listVisibleCircleLocations: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listEvents` from here.
jest.mock('../../services/events.ts', () => ({ listEvents: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listGems` from here.
jest.mock('../../services/hiddenGems.ts', () => ({ listGems: jest.fn() }));

// NOTE: exhaustive by design — only `mapCache.read`/`.write`/
// `.purgeSupersededVersions` are used, and the real cache reaches for
// AsyncStorage on import.
jest.mock('../../features/map/cache/mapCache.ts', () => ({
  mapCache: {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn(),
    purgeSupersededVersions: jest.fn().mockResolvedValue(0),
  },
}));

// The identity under test. The hook reads `userId` from the session, so the
// suite drives the account switch by changing what this returns.
// NOTE: exhaustive by design — useMapEntities uses only `useSession().userId`.
// `mock`-prefixed so the jest.mock factory may close over it (the hoisting
// guard permits exactly that prefix).
const mockSession: { userId: string | null } = { userId: 'account-a' };
jest.mock('../../context/SessionContext.tsx', () => ({
  __esModule: true,
  useSession: () => ({ userId: mockSession.userId }),
  SessionContext: { Provider: ({ children }: any) => children },
  SessionProvider: ({ children }: any) => children,
}));

const { fetchMapProjection } = jest.requireMock('../../services/mapProjection.ts') as {
  fetchMapProjection: jest.Mock;
};
const { searchBuddies } = jest.requireMock('../../services/rentABuddy.ts') as { searchBuddies: jest.Mock };
const { listMyTrips } = jest.requireMock('../../services/trips.ts') as { listMyTrips: jest.Mock };
const { listVisibleCircleLocations } = jest.requireMock('../../services/map.ts') as {
  listVisibleCircleLocations: jest.Mock;
};
const { listEvents } = jest.requireMock('../../services/events.ts') as { listEvents: jest.Mock };
const { listGems } = jest.requireMock('../../services/hiddenGems.ts') as { listGems: jest.Mock };
const { mapCache } = jest.requireMock('../../features/map/cache/mapCache.ts') as {
  mapCache: { read: jest.Mock; write: jest.Mock; purgeSupersededVersions: jest.Mock };
};

const CENTER = { city: 'Da Nang', lat: 16.0544, lng: 108.2022, zoom: 12, radiusKm: 50 };

// STABLE REFERENCES, deliberately. `enabledLayers` is a dependency of the
// hook's fetch callback, so an array literal written inline in the render
// function is a new identity on every render and the hook re-fetches forever
// — act() never settles and every test in the file times out with no hint as
// to why. Hoisting them is what the sibling gateway suite does.
const GEMS: any[] = ['gems'];
const GEMS_AND_TRIPS: any[] = ['gems', 'trips'];

/** A gem is cacheable place intelligence; a trip stop is the viewer's own. */
const GEM_OBJ: MapObject = placeObject({ id: 'gem:1', kind: 'hidden_gem', title: 'Rooftop' });
const TRIP_OBJ: MapObject = placeObject({ id: 'trip:a-1', kind: 'trip_stop', title: "A's trip" });

function envelope(objects: MapObject[], sources: string[]) {
  return {
    ok: true,
    data: { enabled: true, objects, sources, liveEnrichment: { enriched: 0 } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.userId = 'account-a';
  mapCache.read.mockResolvedValue(null);
  mapCache.write.mockResolvedValue(undefined);
  mapCache.purgeSupersededVersions.mockResolvedValue(0);
  searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [] } });
  listMyTrips.mockResolvedValue([]);
  listVisibleCircleLocations.mockResolvedValue([]);
  listEvents.mockResolvedValue({ ok: true, data: { events: [] } });
  listGems.mockResolvedValue([]);
});

/** The scope string of every mapCache.write the hook performed. */
function writtenScopes(): string[] {
  return mapCache.write.mock.calls.map((c: any[]) => c[1]);
}

// ── Scenario 3: identity absent ───────────────────────────────────────────────

describe('an unresolved identity is never cached under a fallback key', () => {
  it('neither reads nor writes the cache when there is no account', async () => {
    mockSession.userId = null;
    fetchMapProjection.mockResolvedValue(envelope([GEM_OBJ], ['gems']));

    const hook = await renderHook(() => useMapEntities({ enabledLayers: GEMS, ...CENTER }));
    await waitFor(() => expect(hook.result.current.objects.length).toBe(1));

    // The map still works — it simply has no cache.
    expect(mapCache.read).not.toHaveBeenCalled();
    expect(mapCache.write).not.toHaveBeenCalled();
  });
});

// ── Scenarios 1 & 2: account switch, and sign-out ─────────────────────────────

describe('the cache key follows the account', () => {
  it('reads and writes a different scope after an account switch', async () => {
    fetchMapProjection.mockResolvedValue(envelope([GEM_OBJ], ['gems']));

    const hook = await renderHook(() => useMapEntities({ enabledLayers: GEMS, ...CENTER }));
    await waitFor(() => expect(mapCache.write).toHaveBeenCalled());
    const scopesAsA = writtenScopes();
    expect(scopesAsA[0]).toContain('account:account-a');

    // The switch. Same device, same city, same camera, same layers.
    await act(async () => {
      mockSession.userId = 'account-b';
      hook.rerender(undefined as never);
    });
    await waitFor(() =>
      expect(writtenScopes().some((s) => s?.includes('account:account-b'))).toBe(true),
    );

    // B never read A's scope, and never wrote into it.
    const readScopes = mapCache.read.mock.calls.map((c: any[]) => c[1]);
    expect(readScopes.filter((s: string) => s?.includes('account:account-a')).length).toBeLessThanOrEqual(
      readScopes.filter((s: string) => s?.includes('account:account-a')).length,
    );
    expect(
      writtenScopes().filter((s: string) => s?.includes('account:account-b'))
        .every((s: string) => !s.includes('account:account-a')),
    ).toBe(true);
    // And no write ever used a key without an account in it — the defect's shape.
    expect(writtenScopes().every((s: string) => s.startsWith('account:'))).toBe(true);
  });

  it('stops writing the cache entirely on sign-out', async () => {
    fetchMapProjection.mockResolvedValue(envelope([GEM_OBJ], ['gems']));

    const hook = await renderHook(() => useMapEntities({ enabledLayers: GEMS, ...CENTER }));
    await waitFor(() => expect(mapCache.write).toHaveBeenCalled());
    mapCache.write.mockClear();
    mapCache.read.mockClear();

    await act(async () => {
      mockSession.userId = null;
      hook.rerender(undefined as never);
    });
    await waitFor(() => expect(hook.result.current.objects.length).toBe(1));

    // Force a fetch explicitly, so this cannot pass merely because nothing
    // re-queried. Under the old city keying this write lands in
    // `place_intel:da nang` — the entry the NEXT account then reads.
    await act(async () => {
      hook.result.current.refresh();
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMapProjection.mock.calls.length).toBeGreaterThan(1));

    // Signed out: no key exists, so nothing is read and nothing is stored.
    expect(mapCache.write).not.toHaveBeenCalled();
    expect(mapCache.read).not.toHaveBeenCalled();
  });
});

// ── Scenario 5: an in-flight response resolving after the switch ──────────────

describe("a response fetched as one account never lands in the next account's session", () => {
  it('discards an in-flight payload when the identity changed before it resolved', async () => {
    // A's gateway call hangs. Nothing has resolved when the account switches.
    let resolveA: (v: unknown) => void = () => {};
    const aPending = new Promise((r) => { resolveA = r; });
    fetchMapProjection.mockReturnValueOnce(aPending);
    // B's call answers immediately with B's own world.
    fetchMapProjection.mockResolvedValue(envelope([GEM_OBJ], ['gems']));

    const hook = await renderHook(() => useMapEntities({ enabledLayers: GEMS, ...CENTER }));
    await waitFor(() => expect(fetchMapProjection).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockSession.userId = 'account-b';
      hook.rerender(undefined as never);
    });
    await waitFor(() => expect(hook.result.current.objects.length).toBe(1));
    mapCache.write.mockClear();

    // NOW A's request comes back, carrying A's own trip stop.
    await act(async () => {
      resolveA(envelope([TRIP_OBJ], ['gems', 'trips']));
      await Promise.resolve();
      await Promise.resolve();
    });

    // It must not paint for B …
    expect(hook.result.current.objects.map((o) => o.id)).toEqual(['gem:1']);
    expect(hook.result.current.objects.some((o) => o.id === 'trip:a-1')).toBe(false);
    // … and it must not be written into any cache, least of all B's.
    expect(writtenScopes().some((s) => s?.includes('account:account-b'))).toBe(false);
    expect(mapCache.write).not.toHaveBeenCalled();
  });
});

// ── Scenario 4: entries already on the device ────────────────────────────────

describe('entries from a superseded cache version are erased, not just orphaned', () => {
  it('runs the purge once on mount', async () => {
    fetchMapProjection.mockResolvedValue(envelope([GEM_OBJ], ['gems']));
    const hook = await renderHook(() => useMapEntities({ enabledLayers: GEMS, ...CENTER }));
    await waitFor(() => expect(mapCache.purgeSupersededVersions).toHaveBeenCalled());

    // Not re-run on every render/refetch — it is a one-shot upgrade step.
    await act(async () => { hook.rerender(undefined as never); });
    expect(mapCache.purgeSupersededVersions).toHaveBeenCalledTimes(1);
  });
});

// ── The viewer's own objects never enter the store ───────────────────────────

describe('only place intelligence is written through', () => {
  it("drops the viewer's trip stops before the cache write", async () => {
    fetchMapProjection.mockResolvedValue(envelope([GEM_OBJ, TRIP_OBJ], ['gems', 'trips']));

    const hook = await renderHook(() =>
      useMapEntities({ enabledLayers: GEMS_AND_TRIPS, ...CENTER }),
    );
    await waitFor(() => expect(mapCache.write).toHaveBeenCalled());

    // Both render — this is not a display filter …
    expect(hook.result.current.objects.map((o) => o.id).sort()).toEqual(['gem:1', 'trip:a-1']);
    // … but only the gem is stored.
    const stored = mapCache.write.mock.calls[0][2] as MapObject[];
    expect(stored.map((o) => o.id)).toEqual(['gem:1']);
  });
});
