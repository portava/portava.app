/**
 * useCommunityDiscovery — fetches traveler-submitted hidden gems and picks
 * from /api/discovery/community for a given city.
 *
 * Returns items in the shapes expected by HiddenGemsSection (DiscoveryItem)
 * and TravelerPicksSection (TravelerPick) from DiscoveryWall. The submitted_by
 * profile id is a real Supabase UUID so HighlightRing activates correctly.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import type { DiscoveryItem, TravelerPick } from '../data/discovery.ts';
import { getCommunityPlaces } from '../services/discovery.ts';
import type { CommunityPlaceItem, DiscoveryPlace } from '../services/discovery.ts';
import { communityBylineText } from '../features/discovery/communityByline.ts';

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

/**
 * The served submitter, mapped to the byline shape the wall cards take.
 * census-discovery C19 / §6 D2 — this is `useCommunityDiscovery.ts:37` and
 * `:59`, the two lines D2 names.
 *
 * `name` is now DERIVED, not copied: it is resolved from the canonical
 * (`displayName`, `handle`) pair, so the legacy wire field — which bakes
 * `@username` in when the server withheld the name — is never read and can be
 * retired server-side without blanking a byline. `displayName` is carried
 * through unchanged so the card can re-resolve the same decision rather than
 * trust a string it was handed.
 *
 * Returned as a standalone value rather than an inline literal because the
 * legacy fixture type (`src/__fixtures__/discovery.ts`, another lane's file)
 * has no `displayName` member yet; a fresh literal would trip the
 * excess-property check while the wire genuinely carries the field.
 */
function toByline(
  by: CommunityPlaceItem['submittedBy'],
): { id: string; name: string; displayName: string | null; avatarUrl: string; handle: string | null } | null {
  if (!by) return null;
  return {
    id:          by.id,
    name:        communityBylineText(by),
    displayName: by.displayName ?? null,
    avatarUrl:   by.avatarUrl ?? `https://i.pravatar.cc/120?u=${by.id}`,
    handle:      by.handle ?? null,
  };
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
    submittedBy:  toByline(item.submittedBy) ?? undefined,
    savedCount:   item.savedCount,
    rating:       item.rating ?? null,
    source:       (item.source ?? 'traveler') as DiscoveryItem['source'],
    status:       (item.status ?? 'provisional') as DiscoveryItem['status'],
    verified:     item.verified,
    worthItCount: item.worthItCount ?? null,
    avgRating:    item.avgRating ?? null,
    reviewCount:  item.reviewCount ?? null,
  };
}

function toTravelerPick(item: CommunityPlaceItem): TravelerPick {
  return {
    id:     item.id,
    user:   toByline(item.submittedBy)
      ?? { name: 'Traveler', avatarUrl: 'https://i.pravatar.cc/120' },
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
  /**
   * The server REFUSED the community read and served nothing.
   *
   * Owner ruling, 2026-09-14: "A distinguishable response body alone is
   * insufficient if consumers still treat it as successful empty data." A
   * refusal reaches this hook as `ok: true` with `items: []` — identical, to
   * every line below, to a city with no hidden gems in it. This flag is the
   * only thing that keeps the two apart, and the cache decision below is the
   * first consumer of it.
   */
  refused: boolean;
}

const EMPTY: CommunityDiscoveryState = { gems: [], picks: [], places: [], loading: false, refused: false };

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
    if (city) return { gems: [], picks: [], places: [], loading: true, refused: false };
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

      // `coverage: "nothing"` means the server did not read the table. The empty
      // arrays above are padding, not a result.
      const refused = result.data.refusal?.coverage === 'nothing';
      const fresh: CommunityDiscoveryState = { gems, picks, places, loading: false, refused };
      setState(fresh);
      // Update the module cache for the next mount — BUT NEVER WITH A REFUSAL.
      //
      // Owner ruling, 2026-09-14: "Do not cache rate limits or outages as 'this
      // location does not exist.'" This cache is that sentence's shape on the
      // client: it is module-level, it survives navigation, the mount effect
      // below serves from it without a network call for five minutes, and a
      // refused read used to enter it as an ordinary empty result. One failed
      // request therefore emptied the city's hidden gems for five minutes from
      // the device's own memory — and because nothing re-fetched, nothing could
      // notice the server had recovered.
      //
      // A `partial` refusal IS cached: the items it carries are real.
      if (cKey && !refused) _communityCache.set(cKey, { state: fresh, at: Date.now() });
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
