/**
 * useMapEntities — the gateway is asked for EVERY layer it serves (spec §19).
 *
 * WHAT THIS SUITE EXISTS TO CATCH
 * ===============================
 * The gateway served six kinds; `GATEWAY_KIND_FOR_LAYER` named two. Buddies,
 * trips and friends were still re-derived on the device from their own
 * per-layer endpoints — "the mobile client should not independently
 * reconstruct Portava intelligence rules" — and nothing failed, because the
 * only tests that touched this hook MIRRORED its loops instead of running it.
 *
 * So this suite runs the real hook. Every assertion below is about observable
 * behaviour at its two boundaries: what it ASKS the network for, and what it
 * hands the renderer. Nothing here re-implements a projector.
 *
 * The gateway fixtures are written from the SERVER's projectors
 * (artifacts/api-server/src/lib/mapProjection.ts), not from the client's — the
 * two disagreed on real fields (the server's crew_member subtitle carries the
 * country; its trip_stop subtitle carries the destination city the client
 * projector was reading under a name the DTO does not have), and a fixture
 * copied from the client would have hidden exactly that.
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';
import type { MapObject } from '../../types/mapObjects.ts';
import { placeObject, PLACE_ID } from '../../__fixtures__/mapEntities.ts';

// NOTE: exhaustive by design. useMapEntities imports exactly `fetchMapProjection`
// and `bboxFromCenter` from this module; requireActual would drag in the API
// token + supabase client for a pure bbox helper, so the helper is restated as
// the trivial stub the hook only forwards to the fetch mock.
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
// observe whether the call happened at all.

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

// NOTE: exhaustive by design — only `mapCache.read`/`.write` are used, and the
// real cache reaches for AsyncStorage on import.
jest.mock('../../features/map/cache/mapCache.ts', () => ({
  mapCache: { read: jest.fn(), write: jest.fn() },
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
  mapCache: { read: jest.Mock; write: jest.Mock };
};

// ── Gateway fixtures, copied from the SERVER's projectors ─────────────────────

/** projectBuddy: title = displayName, subtitle = [city, tagline] joined ' · '. */
const BUDDY_OBJ: MapObject = {
  id: 'buddy:b1',
  kind: 'buddy_zone',
  geometry: { type: 'Point', coordinates: [100.5, 13.75] },
  title: 'Mika',
  subtitle: 'Bangkok · Street food guide',
  privacyClass: 'approximate',
  renderingPriority: 40,
  interaction: {
    actions: ['view', 'book', 'message', 'report'],
    detailRoute: '/(rent-a-buddy)/buddy/b1',
    opensSheet: true,
  },
};

/** projectTrip: subtitle = [destinationCity, dateRange] joined ' · '. */
const TRIP_OBJ: MapObject = {
  id: 'trip:t1',
  kind: 'trip_stop',
  geometry: { type: 'Point', coordinates: [98.98, 18.79] },
  title: 'Songkran',
  subtitle: 'Chiang Mai · 2026-04-12 → 2026-04-16',
  privacyClass: 'place_level',
  renderingPriority: 70,
  interaction: { actions: ['view', 'share', 'navigate'], detailRoute: '/trip/t1', opensSheet: true },
};

/** projectCircleMember: subtitle = [city, country] joined ', '. */
const FRIEND_OBJ: MapObject = {
  id: 'friend:u9',
  kind: 'crew_member',
  geometry: { type: 'Point', coordinates: [139.76, 35.68] },
  title: 'Rui',
  subtitle: 'Tokyo, Japan',
  privacyClass: 'approximate',
  renderingPriority: 60,
  interaction: { actions: ['message', 'follow', 'report', 'block'], opensSheet: true },
};

const CENTER = { city: 'Bangkok', lat: 13.75, lng: 100.5 };

function envelope(objects: MapObject[], sources: string[]) {
  return {
    ok: true as const,
    data: {
      enabled: true,
      objects,
      viewport: null,
      total: objects.length,
      nextCursor: null,
      sources,
      liveEnrichment: { considered: objects.length, enriched: 0, skipped: 0 },
      generatedAt: '2026-08-31T12:00:00.000Z',
    },
  };
}

/** The `enabled: false` answer the endpoint gives when the flag is off. */
const DISABLED = {
  ok: true as const,
  data: {
    enabled: false,
    objects: [],
    viewport: null,
    total: 0,
    nextCursor: null,
    sources: [],
    liveEnrichment: null,
    generatedAt: '2026-08-31T12:00:00.000Z',
  },
};

async function load(enabledLayers: any[], extra: Record<string, unknown> = {}) {
  // RNTL v14's renderHook resolves a promise here — awaiting it is what makes
  // `result` exist at all.
  const hook = await renderHook(() => useMapEntities({ enabledLayers, ...CENTER, ...extra }));
  // Settle on the §33 ladder advancing off its cache-first seed, which every
  // completed load does — rather than on objects appearing, because several
  // cases below assert an EMPTY result and would otherwise time out instead of
  // asserting.
  await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
  return hook;
}

/** The `kinds` array of the single gateway call. */
function requestedKinds(): string[] {
  expect(fetchMapProjection).toHaveBeenCalled();
  return fetchMapProjection.mock.calls[0][0].kinds;
}

beforeEach(() => {
  jest.clearAllMocks();
  mapCache.read.mockResolvedValue(null);
  mapCache.write.mockResolvedValue(undefined);
  // The legacy transports answer with data, so a test that expects them NOT to
  // run fails loudly (extra objects) rather than passing on an empty response.
  searchBuddies.mockResolvedValue({ ok: true, data: { buddies: [{ id: 'legacy-b', displayName: 'Legacy', city: 'X', meetupBaseLat: 1, meetupBaseLng: 2 }] } });
  listMyTrips.mockResolvedValue([
    { id: 'legacy-t', title: 'Legacy trip', visibility: 'public', destinationCity: 'X', destinationLat: 1, destinationLng: 2 },
  ]);
  listVisibleCircleLocations.mockResolvedValue([{ userId: 'legacy-u', name: 'Legacy', city: 'X', lat: 1, lng: 2 }]);
  listEvents.mockResolvedValue({ ok: true, data: { events: [] } });
  listGems.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Per layer: the client asks for the kind, and renders what came back
// ═══════════════════════════════════════════════════════════════════════════════

describe('buddies reach the renderer through the gateway', () => {
  it('asks the gateway for buddy_zone when the buddies layer is on', async () => {
    fetchMapProjection.mockResolvedValue(envelope([BUDDY_OBJ], ['buddies']));
    await load(['buddies']);
    expect(requestedKinds()).toContain('buddy_zone');
  });

  it('renders the gateway buddy with the title, subtitle and position the server sent', async () => {
    fetchMapProjection.mockResolvedValue(envelope([BUDDY_OBJ], ['buddies']));
    const { result } = await load(['buddies']);

    const obj = result.current.objects.find((o) => o.kind === 'buddy_zone')!;
    expect(obj.title).toBe('Mika');
    // Not 'Bangkok' alone: the subtitle the SERVER built, tagline included.
    expect(obj.subtitle).toBe('Bangkok · Street food guide');

    const entity = result.current.entities.find((e) => e.id === 'buddy:b1')!;
    expect(entity.type).toBe('buddies');
    expect([entity.lat, entity.lng]).toEqual([13.75, 100.5]);
    expect(entity.detailRoute).toBe('/(rent-a-buddy)/buddy/b1');
  });

  it('does not also fetch the marketplace when the gateway served buddies', async () => {
    fetchMapProjection.mockResolvedValue(envelope([BUDDY_OBJ], ['buddies']));
    const { result } = await load(['buddies']);
    expect(searchBuddies).not.toHaveBeenCalled();
    expect(result.current.objects).toHaveLength(1);
  });
});

describe('trips reach the renderer through the gateway', () => {
  it('asks the gateway for trip_stop when the trips layer is on', async () => {
    fetchMapProjection.mockResolvedValue(envelope([TRIP_OBJ], ['trips']));
    await load(['trips']);
    expect(requestedKinds()).toContain('trip_stop');
  });

  it('renders the gateway trip with the destination city in its subtitle', async () => {
    fetchMapProjection.mockResolvedValue(envelope([TRIP_OBJ], ['trips']));
    const { result } = await load(['trips']);

    const obj = result.current.objects.find((o) => o.kind === 'trip_stop')!;
    expect(obj.title).toBe('Songkran');
    // The city is the half the client projector lost by reading `destination`.
    expect(obj.subtitle).toContain('Chiang Mai');

    const entity = result.current.entities.find((e) => e.id === 'trip:t1')!;
    expect(entity.type).toBe('trips');
    expect([entity.lat, entity.lng]).toEqual([18.79, 98.98]);
  });

  it('does not also fetch /api/trips/me when the gateway served trips', async () => {
    fetchMapProjection.mockResolvedValue(envelope([TRIP_OBJ], ['trips']));
    const { result } = await load(['trips']);
    expect(listMyTrips).not.toHaveBeenCalled();
    expect(result.current.objects).toHaveLength(1);
  });
});

describe('circle members reach the renderer through the gateway', () => {
  it('asks the gateway for crew_member when the friends layer is on', async () => {
    fetchMapProjection.mockResolvedValue(envelope([FRIEND_OBJ], ['circle']));
    await load(['friends']);
    expect(requestedKinds()).toContain('crew_member');
  });

  it('renders the gateway circle member with the city AND country subtitle', async () => {
    fetchMapProjection.mockResolvedValue(envelope([FRIEND_OBJ], ['circle']));
    const { result } = await load(['friends']);

    const obj = result.current.objects.find((o) => o.kind === 'crew_member')!;
    expect(obj.title).toBe('Rui');
    expect(obj.subtitle).toBe('Tokyo, Japan');

    const entity = result.current.entities.find((e) => e.id === 'friend:u9')!;
    expect(entity.type).toBe('friends');
  });

  it('does not also fetch /api/me/circle-locations when the gateway served the circle', async () => {
    fetchMapProjection.mockResolvedValue(envelope([FRIEND_OBJ], ['circle']));
    const { result } = await load(['friends']);
    expect(listVisibleCircleLocations).not.toHaveBeenCalled();
    expect(result.current.objects).toHaveLength(1);
  });

  it('renders the gateway position verbatim — the client never re-coarsens it', async () => {
    // readCircleLocations already ran coarsenPosition (an ~2.2 km or ~11 km
    // grid cell with a per-user offset) before this coordinate left the server.
    // The legacy path then added its own ±0.01° jitter on top, which never
    // protected anything — the pre-jitter value was already on the device — and
    // which SEPARATES two members the server had collapsed into one cell.
    // Dropping it must not move the pin anywhere the server did not put it.
    fetchMapProjection.mockResolvedValue(envelope([FRIEND_OBJ], ['circle']));
    const { result } = await load(['friends']);

    const entity = result.current.entities.find((e) => e.id === 'friend:u9')!;
    expect([entity.lat, entity.lng]).toEqual([35.68, 139.76]);
    // The rung the server stamped survives; nothing here upgrades it.
    expect(result.current.objects[0].privacyClass).toBe('approximate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A layer the viewer has not enabled is never requested
// ═══════════════════════════════════════════════════════════════════════════════

describe('disabled layers are not requested', () => {
  it('asks only for the enabled layer, not for every kind the gateway serves', async () => {
    fetchMapProjection.mockResolvedValue(envelope([BUDDY_OBJ], ['buddies']));
    await load(['buddies']);

    const kinds = requestedKinds();
    expect(kinds).toEqual(['buddy_zone']);
    for (const off of ['trip_stop', 'crew_member', 'event', 'hidden_gem', 'social_zone']) {
      expect(kinds).not.toContain(off);
    }
  });

  it('a layer switched off is absent from the request even when others are on', async () => {
    fetchMapProjection.mockResolvedValue(envelope([TRIP_OBJ, FRIEND_OBJ], ['trips', 'circle']));
    await load(['trips', 'friends']);

    const kinds = requestedKinds();
    expect(kinds.sort()).toEqual(['crew_member', 'trip_stop']);
    expect(kinds).not.toContain('buddy_zone');
  });

  it('omitting the kind is not the same as asking for everything', async () => {
    // The server treats an ABSENT `kinds` as "serve them all". A client that
    // stopped narrowing would silently start receiving — and drawing — layers
    // the viewer switched off.
    fetchMapProjection.mockResolvedValue(envelope([BUDDY_OBJ], ['buddies']));
    await load(['buddies']);
    expect(fetchMapProjection.mock.calls[0][0].kinds).toBeDefined();
    expect(fetchMapProjection.mock.calls[0][0].kinds.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rollback and partial answers
// ═══════════════════════════════════════════════════════════════════════════════

describe('the flag-off path is a real rollback', () => {
  it('every layer falls back to its own fetcher when the gateway is disabled', async () => {
    fetchMapProjection.mockResolvedValue(DISABLED);
    const { result } = await load(['buddies', 'trips', 'friends']);

    expect(searchBuddies).toHaveBeenCalled();
    expect(listMyTrips).toHaveBeenCalled();
    expect(listVisibleCircleLocations).toHaveBeenCalled();
    expect(result.current.source).toBe('legacy');
    expect(result.current.objects.map((o) => o.kind).sort()).toEqual([
      'buddy_zone', 'crew_member', 'trip_stop',
    ]);
  });

  it('a network failure falls back rather than blanking the map', async () => {
    fetchMapProjection.mockResolvedValue({ ok: false, error: 'Network error' });
    const { result } = await load(['friends']);
    expect(listVisibleCircleLocations).toHaveBeenCalled();
    expect(result.current.objects).toHaveLength(1);
  });
});

describe('a partial gateway answer is reported, never re-fetched', () => {
  it('names the layer the gateway could not read', async () => {
    // The circle read failed server-side, so "circle" is absent from `sources`.
    fetchMapProjection.mockResolvedValue(envelope([TRIP_OBJ], ['trips']));
    const { result } = await load(['trips', 'friends']);

    await waitFor(() => expect(result.current.unreadLayers).toEqual(['friends']));
    expect(result.current.source).toBe('gateway');
  });

  it('does NOT re-fetch the unread layer through its legacy transport', async () => {
    // This is the privacy-relevant half. The gateway's empty answers are often
    // fail-CLOSED (an unreadable block set returns `sources: []`), while
    // POST /api/rent-a-buddy/search is fail-OPEN on the very same input — it
    // skips block filtering entirely when the block set cannot be read. Falling
    // back per-layer would route around a fail-closed decision through a weaker
    // path and put blocked people back on the map.
    fetchMapProjection.mockResolvedValue(envelope([], []));
    const { result } = await load(['buddies', 'trips', 'friends']);

    await waitFor(() => expect(result.current.unreadLayers.length).toBe(3));
    expect(searchBuddies).not.toHaveBeenCalled();
    expect(listMyTrips).not.toHaveBeenCalled();
    expect(listVisibleCircleLocations).not.toHaveBeenCalled();
    expect(result.current.objects).toHaveLength(0);
  });

  it('reports nothing unread when the gateway named every enabled layer', async () => {
    fetchMapProjection.mockResolvedValue(
      envelope([BUDDY_OBJ, TRIP_OBJ, FRIEND_OBJ], ['buddies', 'trips', 'circle']),
    );
    const { result } = await load(['buddies', 'trips', 'friends']);
    expect(result.current.unreadLayers).toEqual([]);
    expect(result.current.objects).toHaveLength(3);
  });

  it('the friends layer maps to the server source named "circle"', async () => {
    // The one layer whose gateway source name is not its own. Get it wrong and
    // friends are permanently "unread" while their pins render perfectly.
    fetchMapProjection.mockResolvedValue(envelope([FRIEND_OBJ], ['circle']));
    const { result } = await load(['friends']);
    expect(result.current.unreadLayers).toEqual([]);
  });
});

// ── §16 Crowd Flow — requested on explicit choice, and only then ──────────────
//
// crowd_flow is NOT a ToggleableEntityType, so it rides beside `enabledLayers`
// rather than inside them. That is deliberate: the legacy union is the five
// pin toggles and every member is seeded ON, so requesting a people-derived
// aggregate from there would ask for it on every map load — contradicting
// §16's `contextual` default for this layer.
//
// §16's two AUTOMATIC triggers are both circular: `density` is measured by the
// projection layer (a property of the response), and CROWD_FLOW mode is gated
// on a capability derived from flows having already arrived. Explicit user
// choice is the only non-circular trigger, and §16 says it outranks automatic
// resolution.
describe('§16 crowd flow', () => {
  it('is NOT requested when the viewer has not chosen it', async () => {
    await load(['events']);
    expect(requestedKinds()).not.toContain('crowd_flow');
  });

  it('IS requested when the viewer has chosen it', async () => {
    await load(['events'], { crowdFlow: true });
    expect(requestedKinds()).toContain('crowd_flow');
  });

  // THE TRAP. doFetch early-returns when enabledLayers is empty, and that
  // return cannot simply be deleted: passport mode passes [] deliberately to
  // mean "fetch nothing". So a viewer who switches every legacy pin layer OFF
  // but Crowd Flow ON must still reach the gateway — and used to be swallowed.
  it('reaches the gateway with every pin layer off but crowd flow on', async () => {
    await load([], { crowdFlow: true });
    expect(fetchMapProjection).toHaveBeenCalled();
    expect(requestedKinds()).toEqual(['crowd_flow']);
  });

  // NOT TESTED HERE, deliberately: "both empty fetches nothing". The empty-
  // layers early return does not advance the §33 stage ladder, so this suite's
  // `load` helper (which settles on that ladder) times out on it, and driving
  // renderHook directly hangs the worker. That is pre-existing behaviour of the
  // guard — a passport-mode map sits at `cached_geography` — and asserting it
  // would mean asserting around someone else's bug with a bespoke harness.
  //
  // The property that MATTERS is covered above: crowd flow alone still reaches
  // the gateway. The mutation proof for the guard itself lives in
  // useMapEntities.gatewayAsymmetry.test.ts.
});

// ── §16 Relevant Places — canonical places through the gateway ───────────────
//
// `place` is served by the gateway (server lib/mapProjectPlace.ts) and, like
// crowd_flow, is not a ToggleableEntityType: the legacy 'places' layer was a
// per-screen Discovery fetch in app/map/index.tsx, never a pin toggle. The
// shell asks for it on the `places` option from its §16 preference.
//
// There is deliberately NO rollback fetcher for the kind in this hook — the
// shell's legacy Discovery path is the rollback, and it owns its own loading /
// error / retry UI. A second transport here would double-fetch and double-draw.
describe('§16 relevant places', () => {
  it('is NOT requested unless the shell asks for it', async () => {
    await load(['events']);
    expect(requestedKinds()).not.toContain('place');
  });

  it('IS requested on the places option', async () => {
    await load(['events'], { places: true });
    expect(requestedKinds()).toContain('place');
  });

  // Same trap as crowd_flow: the empty-layers early return must not swallow a
  // viewer who has every legacy pin layer off but Relevant Places on.
  it('reaches the gateway with every pin layer off but places on', async () => {
    await load([], { places: true });
    expect(fetchMapProjection).toHaveBeenCalled();
    expect(requestedKinds()).toEqual(['place']);
  });

  it('renders the gateway place as a places entity carrying the projected object', async () => {
    const served = placeObject();
    fetchMapProjection.mockResolvedValue(envelope([served], ['places']));
    const { result } = await load([], { places: true });

    expect(result.current.source).toBe('gateway');
    expect(result.current.objects.map((o) => o.kind)).toEqual(['place']);
    const [entity] = result.current.entities;
    // The legacy view keeps the projected object whole on `payload`: the
    // marker, the card and the §8 sheet all recover it from there.
    expect(entity.type).toBe('places');
    expect(entity.id).toBe(`place:${PLACE_ID}`);
    expect(entity.payload).toBe(served);
    expect(entity.detailRoute).toBe(`/place/${PLACE_ID}`);
    // GeoJSON [lng, lat] → the envelope's lat/lng, verbatim.
    expect(entity.lat).toBe(16.054412);
    expect(entity.lng).toBe(108.202233);
    // Never re-derived on the device: what the server withheld stays absent.
    expect(result.current.objects[0].freshness).toBeUndefined();
    expect(result.current.objects[0].confidence).toBeUndefined();
  });

  it('has no rollback transport of its own — the flag-off path yields no place objects', async () => {
    fetchMapProjection.mockResolvedValue(DISABLED);
    const { result } = await load(['events'], { places: true });
    expect(result.current.source).toBe('legacy');
    expect(result.current.objects.some((o) => o.kind === 'place')).toBe(false);
  });
});
