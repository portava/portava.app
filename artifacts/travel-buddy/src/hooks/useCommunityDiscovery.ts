/**
 * useCommunityDiscovery — fetches traveler-submitted hidden gems and picks
 * from /api/discovery/community for a given city.
 *
 * Returns items in the shapes expected by HiddenGemsSection (DiscoveryItem)
 * and TravelerPicksSection (TravelerPick) from DiscoveryWall2. The submitted_by
 * profile id is a real Supabase UUID so HighlightRing activates correctly.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import type { DiscoveryItem, TravelerPick } from '../data/discovery';
import { getCommunityPlaces } from '../services/discovery';
import type { CommunityPlaceItem } from '../services/discovery';

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
        }
      : undefined,
    savedCount:   item.savedCount,
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

interface CommunityDiscoveryState {
  gems: DiscoveryItem[];
  picks: TravelerPick[];
  loading: boolean;
}

const EMPTY: CommunityDiscoveryState = { gems: [], picks: [], loading: false };

export function useCommunityDiscovery(city: string | null): CommunityDiscoveryState {
  const [state, setState] = useState<CommunityDiscoveryState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (c: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true }));

    try {
      const result = await getCommunityPlaces(c, 'all', 20);
      if (ctrl.signal.aborted) return;

      if (!result.ok) {
        setState({ gems: [], picks: [], loading: false });
        return;
      }

      const gems: DiscoveryItem[] = [];
      const picks: TravelerPick[] = [];

      for (const item of result.data.items) {
        if (item.placeType === 'traveler_pick') {
          picks.push(toTravelerPick(item));
        } else {
          gems.push(toDiscoveryItem(item));
        }
      }

      setState({ gems, picks, loading: false });
    } catch {
      if (!ctrl.signal.aborted) {
        setState({ gems: [], picks: [], loading: false });
      }
    }
  }, []);

  useEffect(() => {
    if (!city) {
      setState(EMPTY);
      return;
    }
    load(city);
    return () => { abortRef.current?.abort(); };
  }, [city, load]);

  return state;
}
