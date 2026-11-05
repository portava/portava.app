import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useSession } from '../context/SessionContext.tsx';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { newClientEventId } from '../services/discoveryDwell.ts';
import { DISCOVERY_TRAIL_OPEN_FLAG, sendTrailOpen, type TrailOpenEmission } from '../services/discoveryTrailOpen.ts';

/** Send only a loaded, foreground, focused visit. Disabled means zero token/network work. */
export function useDiscoveryTrailOpen(trailId: string, loaded: boolean, visible: boolean) {
  const { userId } = useSession();
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled(DISCOVERY_TRAIL_OPEN_FLAG);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const allowed = enabled && !!userId && loaded && visible && foreground;
  const current = useRef({ allowed, userId, trailId });
  current.current = { allowed, userId, trailId };
  const visited = useRef<{ key: string; emission: TrailOpenEmission; sent: boolean } | null>(null);

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);

  useEffect(() => { if (!visible) visited.current = null; }, [visible]);

  useEffect(() => {
    if (!allowed || !userId) return;
    const key = `${userId}:${trailId}`;
    if (visited.current?.key !== key) visited.current = {
      key, emission: { trail_id: trailId, client_event_id: newClientEventId() }, sent: false,
    };
    const visit = visited.current;
    if (visit.sent) return;
    const controller = new AbortController();
    void sendTrailOpen(visit.emission, {
      ownerId: userId,
      signal: controller.signal,
      isAllowed: () => current.current.allowed && current.current.userId === userId && current.current.trailId === trailId,
    }).then((result) => { if (result === 'sent') visit.sent = true; });
    return () => controller.abort();
  }, [allowed, userId, trailId]);
}
