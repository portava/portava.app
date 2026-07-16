import { useEffect, useCallback } from 'react';
import {
  fetchCompassFrontload,
  fetchCompassActiveReward,
  postCompassFrontloadEvent,
  type CompassFrontloadData,
} from '../../services/compass.ts';
import { useSession } from '../../context/SessionContext.tsx';
import { useCompassContext } from '../../context/CompassContext.tsx';

interface UseCompassFrontloadResult {
  frontload:       CompassFrontloadData | null;
  compassEnabled:  boolean;
  postNavEvent:    (screen: string, city?: string) => void;
}

/**
 * Fetches Compass Tier 0 data once after auth resolves and persists the result
 * into CompassContext so every screen can read it without refetching.
 *
 * Exposes `postNavEvent` for major tab screens to call on focus.
 */
export function useCompassFrontload(params: {
  city?: string | null;
  interests?: string[];
} = {}): UseCompassFrontloadResult {
  const { isAuthed } = useSession();
  const { feedTier0, setFeedTier0, reward, setReward } = useCompassContext();

  useEffect(() => {
    if (!isAuthed) return;

    // Load Tier-0 feed into context (warm-cache for ForYouTab)
    fetchCompassFrontload({ city: params.city ?? undefined, interests: params.interests })
      .then((r) => { if (r.ok && r.data) setFeedTier0(r.data); })
      .catch(() => {});

    // Also load active-reward tier so CompassStatusCard doesn't need its own fetch
    if (!reward) {
      fetchCompassActiveReward()
        .then((r) => { if (r.ok && r.data) setReward(r.data); })
        .catch(() => {});
    }
  }, [isAuthed]);

  const postNavEvent = useCallback((screen: string, city?: string) => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen, city }).catch(() => {});
  }, []);

  return {
    frontload:      feedTier0,
    compassEnabled: feedTier0?.compassEnabled !== false,
    postNavEvent,
  };
}
