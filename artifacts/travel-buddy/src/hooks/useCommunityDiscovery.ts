/**
 * useCommunityDiscovery — fetches traveler-submitted hidden gems and picks
 * from /api/discovery/community for a given city.
 *
 * Returns items in the shapes expected by HiddenGemsSection (DiscoveryItem)
 * and TravelerPicksSection (TravelerPick) from DiscoveryWall. The submitted_by
 * profile id is a real Supabase UUID so HighlightRing activates correctly.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import type { DiscoveryItem, TravelerPick } from '../data/discovery';
import { getCommunityPlaces } from '../services/discovery';
import type { CommunityPlaceItem, DiscoveryPlace } from '../services/discovery';

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function toDiscoveryItem(item: CommunityPlaceItem): DiscoveryItem {
  return {
    id:           item.id,
    name:         item.name,
    category:     (item.category ?? 'hidden_gem') as DiscoveryItem['category'],
    neighborhood: item.neighborhood ?? '',
    city:         item.city,
    blurb:        item.blurb ?? '',
    imageUrl:     item.imageUrl ?? undefined,
    submittedBy:  item.submittedBy
      ? {
          id:        item.submittedBy.id,
          name:      item.submittedBy.name,
          avatarUrl: item.submittedBy.avatarUrl ?? `https://i.pravatar.cc/120?u=${item.submittedBy.id}`,
          handle:    item.submittedBy.handle ?? null,
        }
      : undefined,
    savedCount:   item.savedCount,
    rating:       item.rating ?? null,
    source:       (item.source ?? 'traveler') as DiscoveryItem['source'],
    status:       (item.status ?? 'provisional') as DiscoveryItem['status'],
    verified:     item.verified,
  };
}

function toTravelerPick(item: CommunityPlaceItem): TravelerPick {
  return {
    id:     item.id,
    user:   item.submittedBy
      ? {
          id:        item.submittedBy.id,
          name:      item.submittedBy.name,
          avatarUrl: item.submittedBy.avatarUrl ?? `https://i.pravatar.cc/120?u=${item.submittedBy.id}`,
          handle:    item.submittedBy.handle ?? null,
        }
      : { name: 'Traveler', avatarUrl: 'https://i.pravatar.cc/120' },
    place:  item.name,
    note:   item.note ?? '',
    city:   item.city,
    rating: item.rating ?? undefined,
    tag:    item.tag ?? item.category ?? 'Place',
    timeAgo: timeAgo(item.createdAt),
    source:  (item.source ?? 'traveler') as TravelerPick['source'],
    status:  (item.status ?? 'provisional') as TravelerPick['status'],
    verified: item.verified,
  };
}

/** All community items converted to DiscoveryPlace[] for use with DiscoveryMapView.
 *
 * IDs are prefixed with "comm/" so DiscoveryMapView can render them as gold star
 * pins (the same treatment as merged-API DB places prefixed "db/").
 * ForYouTab strips the prefix before passing a selected place to PlaceDetailSheet
 * so that save/bookmark calls use the correct bare UUID.
 */
function toDiscoveryPlace(item: CommunityPlaceItem): DiscoveryPlace {
  return {
    id:           `comm/${item.id}`,
    name:         item.name,
    category:     item.placeType === 'traveler_pick' ? 'for_you' : (item.category ?? 'for_you'),
    type:         item.tag ?? null,
    description:  item.blurb ?? null,
    distanceKm:   null,
    lat:          item.lat ?? null,
    lng:          item.lng ?? null,
    tags:         item.tag ? [item.tag] : [],
    address:      item.neighborhood ?? item.city ?? null,
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       item.rating ?? null,
    isOpenNow:    null,
  };
}

interface CommunityDiscoveryState {
  gems: DiscoveryItem[];
  picks: TravelerPick[];
  /** All community items as DiscoveryPlace[] for DiscoveryMapView. */
  places: DiscoveryPlace[];
  loading: boolean;
}

const EMPTY: CommunityDiscoveryState = { gems: [], picks: [], places: [], loading: false };

// ── Module-level stale-while-revalidate cache ─────────────────────────────────
// Persists across navigation so returning to the Explore tab shows content
// instantly from the previous fetch while a background refresh runs.
const COMM_CACHE_TTL = 5 * 60 * 1_000; // 5 minutes
interface CommCacheEntry { state: CommunityDiscoveryState; at: number }
const _communityCache = new Map<string, CommCacheEntry>();

function commCacheKey(city: string, sortBy?: string | null) {
  return `${city.toLowerCase().trim()}:${sortBy ?? ''}`;
}

export function useCommunityDiscovery(city: string | null, sortBy?: string | null): CommunityDiscoveryState {
  const cKey = city ? commCacheKey(city, sortBy) : null;
  const cachedEntry = cKey ? _communityCache.get(cKey) : null;

  // Initialise directly from the module cache so the very first render can show
  // previously-seen content without waiting for any network call.
  const [state, setState] = useState<CommunityDiscoveryState>(() => {
    if (cachedEntry) return { ...cachedEntry.state, loading: false };
    if (city) return { gems: [], picks: [], places: [], loading: true };
    return EMPTY;
  });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (c: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true }));

    try {
      const result = await getCommunityPlaces(c, 'all', 20, sortBy);
      if (ctrl.signal.aborted) return;

      if (!result.ok) {
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }

      const gems: DiscoveryItem[] = [];
      const picks: TravelerPick[] = [];
      const places: DiscoveryPlace[] = [];

      for (const item of result.data.items) {
        places.push(toDiscoveryPlace(item));
        if (item.placeType === 'traveler_pick') {
          picks.push(toTravelerPick(item));
        } else {
          gems.push(toDiscoveryItem(item));
        }
      }

      const fresh: CommunityDiscoveryState = { gems, picks, places, loading: false };
      setState(fresh);
      // Update module cache for the next mount
      if (cKey) _communityCache.set(cKey, { state: fresh, at: Date.now() });
    } catch {
      if (!ctrl.signal.aborted) {
        setState((prev) => ({ ...prev, loading: false }));
      }
    }
  }, [sortBy, cKey]);

  useEffect(() => {
    if (!city) {
      setState(EMPTY);
      return;
    }
    // Skip the network call if the cache is still fresh
    const hit = cKey ? _communityCache.get(cKey) : null;
    if (hit && Date.now() - hit.at < COMM_CACHE_TTL) {
      setState({ ...hit.state, loading: false });
      return;
    }
    load(city);
    return () => { abortRef.current?.abort(); };
  }, [city, load, cKey]);

  return state;
}
