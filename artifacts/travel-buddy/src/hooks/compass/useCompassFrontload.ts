import { useState, useEffect, useCallback } from 'react';
import {
  fetchCompassFrontload,
  postCompassFrontloadEvent,
  type CompassFrontloadData,
} from '../../services/compass';
import { useSession } from '../../context/SessionContext';

interface UseCompassFrontloadResult {
  frontload:       CompassFrontloadData | null;
  compassEnabled:  boolean;
  postNavEvent:    (screen: string, city?: string) => void;
}

/**
 * Fetches Compass Tier 0 data once after auth resolves.
 * Exposes `postNavEvent` for major tab screens to call on focus.
 */
export function useCompassFrontload(params: {
  city?: string | null;
  interests?: string[];
} = {}): UseCompassFrontloadResult {
  const { isAuthed } = useSession();
  const [frontload, setFrontload] = useState<CompassFrontloadData | null>(null);

  useEffect(() => {
    if (!isAuthed) return;
    fetchCompassFrontload({ city: params.city ?? undefined, interests: params.interests }).then((r) => {
      if (r.ok && r.data) setFrontload(r.data);
    }).catch(() => {});
  }, [isAuthed]);

  const postNavEvent = useCallback((screen: string, city?: string) => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen, city }).catch(() => {});
  }, []);

  return {
    frontload,
    compassEnabled: frontload?.compassEnabled !== false,
    postNavEvent,
  };
}
