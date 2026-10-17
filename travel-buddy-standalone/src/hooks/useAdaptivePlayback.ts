import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { AVPlaybackSource } from 'expo-av';
import { useSession } from '../context/SessionContext.tsx';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { resolveAdaptivePlayback } from '../services/media/adaptive.ts';

export function useAdaptivePlayback(original: string, fallbackUri: string, active = true) {
  const { userId } = useSession();
  const enabled = useFeatureFlags().isEnabled('media_transcoder_enabled') && Platform.OS !== 'web' && !!userId && active;
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [ready, setReady] = useState<{ identity: string; value: AVPlaybackSource } | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const identity = `${userId ?? ''}:${original}`;
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    setReady(null);
    if (!enabled || !foreground || rejected === identity) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    void resolveAdaptivePlayback(original, controller.signal).then(value => {
      if (!controller.signal.aborted && value) setReady({ identity, value });
    }).catch(() => {}).finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, foreground, rejected, identity, original]);
  const adaptive = enabled && foreground && rejected !== identity && ready?.identity === identity ? ready.value : null;
  const source = useMemo<AVPlaybackSource>(() => adaptive ?? { uri: fallbackUri }, [adaptive, fallbackUri]);
  const rejectAdaptive = useCallback(() => {
    if (!adaptive) return false;
    setRejected(identity);
    setReady(null);
    return true;
  }, [adaptive, identity]);
  return { source, rejectAdaptive };
}
