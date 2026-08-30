/**
 * useMapEntities — fetches data for each toggleable entity layer on the
 * full-screen map (Buddies, Events, Hidden Gems, Trips, Friends/Circle).
 *
 * Design goals:
 *   - Each layer fetches independently; a single layer failure never blocks others.
 *   - Results are merged into a flat `MapEntity[]` keyed by type so the map
 *     can cluster and render them uniformly.
 *   - Friends layer: server already enforces privacy opt-in; client adds
 *     deterministic ±0.01° area-level jitter so exact coords are never exposed.
 *   - Re-fetches when `enabledLayers`, `city`, or `lat`/`lng` change.
 *   - Battery-aware: pauses background fetches when layers are disabled.
 *   - Each entity is stamped with `actionCapabilities` and `detailRoute`
 *     so preview cards know what actions to offer without re-fetching.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapEntity, MapActionCapability, ToggleableEntityType } from '../types/mapTypes.ts';
import { searchBuddies, type BuddyProfile } from '../services/rentABuddy.ts';
import { listEvents, type EventListItem } from '../services/events.ts';
import { listGems, type HiddenGem } from '../services/hiddenGems.ts';
import { listMyTrips, type TripRow } from '../services/trips.ts';
import { listVisibleCircleLocations, type CircleMemberLocation } from '../services/map.ts';
import { coarsenForFriend, isMapVisibleEvent, isMapVisibleTrip } from './mapEntityFilters.ts';

// ── Action capability maps ─────────────────────────────────────────────────────

/** Default action capabilities per entity type. */
const LAYER_CAPABILITIES: Record<ToggleableEntityType, MapActionCapability[]> = {
  buddies: ['book', 'message', 'report'],
  events:  ['join', 'share', 'report'],
  gems:    ['save', 'share', 'directions'],
  trips:   ['share'],
  friends: ['message', 'follow', 'report', 'block'],
};

// Privacy / visibility helpers (coarsenForFriend, isMapVisibleEvent,
// isMapVisibleTrip) live in ./mapEntityFilters.ts so they can be unit-tested
// without loading this hook's React + service imports.

// ── Layer fetchers ─────────────────────────────────────────────────────────────

async function fetchBuddies(
  city: string,
  lat: number | null,
  lng: number | null,
): Promise<MapEntity<BuddyProfile>[]> {
  const coordParams =
    lat != null && lng != null
      ? ({ lat, lng } as { lat: number; lng: number })
      : ({} as Record<string, never>);

  const result = await searchBuddies({ city, perPage: 50, ...coordParams });
  if (!result.ok || !result.data) return [];

  const out: MapEntity<BuddyProfile>[] = [];
  for (const buddy of result.data.buddies) {
    const bLat = buddy.meetupBaseLat ?? null;
    const bLng = buddy.meetupBaseLng ?? null;
    if (bLat == null || bLng == null) continue; // no pin without coords
    out.push({
      id: `buddy:${buddy.id}`,
      type: 'buddies',
      lat: bLat,
      lng: bLng,
      payload: buddy,
      actionCapabilities: LAYER_CAPABILITIES.buddies,
      detailRoute: `/(rent-a-buddy)/buddy/${buddy.id}`,
    });
  }
  return out;
}

async function fetchEvents(
  lat: number,
  lng: number,
): Promise<MapEntity<EventListItem>[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const result = await listEvents({
    nearLat: lat,
    nearLng: lng,
    nearRadiusKm: 50,
    dateFrom: now.toISOString(),
    dateTo: cutoff.toISOString(),
    limit: 60,
  });
  if (!result.ok || !result.data) return [];

  const out: MapEntity<EventListItem>[] = [];
  for (const ev of result.data.events) {
    // Coordinate + visibility guard: only located public / friends_only events
    // may appear as public map pins (see isMapVisibleEvent).
    if (!isMapVisibleEvent(ev)) continue;
    out.push({
      id: `event:${ev.id}`,
      type: 'events',
      lat: ev.locationLat!,
      lng: ev.locationLng!,
      payload: ev,
      actionCapabilities: LAYER_CAPABILITIES.events,
      detailRoute: `/event/${ev.id}`,
    });
  }
  return out;
}

async function fetchGems(city: string): Promise<MapEntity<HiddenGem>[]> {
  let gems: HiddenGem[];
  try {
    gems = await listGems({ city, limit: 100 });
  } catch {
    return [];
  }
  const out: MapEntity<HiddenGem>[] = [];
  for (const gem of gems) {
    if (gem.lat == null || gem.lng == null) continue;
    if (gem.status !== 'active') continue;
    out.push({
      id: `gem:${gem.id}`,
      type: 'gems',
      lat: gem.lat,
      lng: gem.lng,
      payload: gem,
      actionCapabilities: LAYER_CAPABILITIES.gems,
      detailRoute: `/gems/${gem.id}`,
    });
  }
  return out;
}

async function fetchTrips(): Promise<MapEntity<TripRow>[]> {
  let trips: TripRow[];
  try {
    trips = await listMyTrips();
  } catch {
    return [];
  }
  const out: MapEntity<TripRow>[] = [];
  for (const trip of trips) {
    // Private trips and coordinate-less trips never appear on the map
    // (see isMapVisibleTrip).
    if (!isMapVisibleTrip(trip)) continue;
    out.push({
      id: `trip:${trip.id}`,
      type: 'trips',
      lat: trip.destinationLat!,
      lng: trip.destinationLng!,
      payload: trip,
      actionCapabilities: LAYER_CAPABILITIES.trips,
      detailRoute: `/trip/${trip.id}`,
    });
  }
  return out;
}

async function fetchFriends(): Promise<MapEntity<CircleMemberLocation>[]> {
  let locs: CircleMemberLocation[];
  try {
    locs = await listVisibleCircleLocations();
  } catch {
    return [];
  }
  const out: MapEntity<CircleMemberLocation>[] = [];
  for (const loc of locs) {
    if (loc.lat == null || loc.lng == null) continue;
    // Apply area-level jitter so exact server coords are never rendered.
    const { lat, lng } = coarsenForFriend(loc.userId, loc.lat, loc.lng);
    out.push({
      id: `friend:${loc.userId}`,
      type: 'friends',
      lat,
      lng,
      payload: { ...loc, lat, lng }, // replace coords with coarsened values
      actionCapabilities: LAYER_CAPABILITIES.friends,
      detailRoute: undefined, // friends navigate via thread resolution, not a static route
      // All circle-member actions are permitted by default; the server already
      // enforces the privacy opt-in before including the entity in the response.
      permissions: { canMessage: true, canFollow: true, canBlock: true, canReport: true },
    });
  }
  return out;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export interface UseMapEntitiesResult {
  entities: MapEntity[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMapEntities(opts: {
  enabledLayers: ToggleableEntityType[];
  city: string | null;
  lat: number | null;
  lng: number | null;
}): UseMapEntitiesResult {
  const { enabledLayers, city, lat, lng } = opts;

  const [entities, setEntities] = useState<MapEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);
  const hasLoaded = useRef(false);

  // Tracks whether another fetch was requested while one was in-flight, so
  // the hook re-runs once the active fetch resolves rather than silently
  // dropping the update (e.g. when persisted layer prefs load mid-fetch).
  const pendingRefetch = useRef(false);

  const doFetch = useCallback(async () => {
    if (inFlight.current) {
      // Queue a follow-up so the in-flight result isn't the last word.
      pendingRefetch.current = true;
      return;
    }
    if (enabledLayers.length === 0) {
      setEntities([]);
      return;
    }
    inFlight.current = true;
    pendingRefetch.current = false;
    if (!hasLoaded.current) setLoading(true);

    const fetches: Promise<MapEntity[]>[] = [];

    if (enabledLayers.includes('buddies') && city) {
      fetches.push(fetchBuddies(city, lat, lng).catch(() => []));
    }
    if (enabledLayers.includes('events') && lat != null && lng != null) {
      fetches.push(fetchEvents(lat, lng).catch(() => []));
    }
    if (enabledLayers.includes('gems') && city) {
      fetches.push(fetchGems(city).catch(() => []));
    }
    if (enabledLayers.includes('trips')) {
      fetches.push(fetchTrips().catch(() => []));
    }
    if (enabledLayers.includes('friends')) {
      fetches.push(fetchFriends().catch(() => []));
    }

    try {
      const results = await Promise.all(fetches);
      const merged: MapEntity[] = ([] as MapEntity[]).concat(...results);
      setEntities(merged);
      setError(null);
      hasLoaded.current = true;
    } catch (err: any) {
      if (!hasLoaded.current) setError(err?.message ?? 'Failed to load map entities');
    } finally {
      inFlight.current = false;
      setLoading(false);
      // If another fetch was requested while we were in-flight, run it now.
      if (pendingRefetch.current) {
        pendingRefetch.current = false;
        void doFetch();
      }
    }
  }, [enabledLayers, city, lat, lng]);

  const refresh = useCallback(() => { void doFetch(); }, [doFetch]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  return { entities, loading: loading && !hasLoaded.current, error, refresh };
}
