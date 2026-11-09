import React, { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewToken } from 'react-native';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { useReducedMotionSetting } from '../../wall/hooks/useReducedMotionSetting.ts';
import { getCompactPlayback, subscribeCompactPlayback } from '../media/compactPlaybackStore.ts';

interface ThreadSharePlayback {
  playing: string | null;
  muted: boolean;
  paused: ReadonlySet<string>;
  togglePause: (id: string) => void;
  setMuted: (muted: boolean) => void;
  register: (id: string, video: boolean) => void;
  expand: (id: string | null) => void;
}
export const ThreadSharePlaybackContext = React.createContext<ThreadSharePlayback | null>(null);
export function useThreadSharePlayer() { return useContext(ThreadSharePlaybackContext); }

export function useThreadSharePlayback(enabled: boolean) {
  const [visible, setVisible] = useState<string[]>([]);
  const [videos, setVideos] = useState<Set<string>>(() => new Set());
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState<ReadonlySet<string>>(() => new Set());
  const togglePause = useCallback((id: string) => setPaused(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const [expanded, expand] = useState<string | null>(null);
  const compact = useSyncExternalStore(subscribeCompactPlayback, getCompactPlayback, getCompactPlayback);
  const activity = useMediaSurfaceActivity(() => expand(null));
  const reduceMotion = useReducedMotionSetting();
  const register = useCallback((id: string, video: boolean) => setVideos(previous => {
    if (previous.has(id) === video) return previous;
    const next = new Set(previous);
    if (video) next.add(id); else next.delete(id);
    return next;
  }), []);
  const onViewableItemsChanged = useCallback(({viewableItems}: {viewableItems: ViewToken[]}) => {
    const ids = viewableItems.filter(v => v.isViewable && v.item?.data?.id).map(v => v.item.data.id as string);
    // Prefer the middle of the viewport when two videos are both mostly visible.
    const midpoint = (ids.length - 1) / 2;
    setVisible(ids.map((id, index) => ({id, distance: Math.abs(index - midpoint)})).sort((a, b) => a.distance - b.distance).map(item => item.id));
  }, []);
  const playing = enabled && activity.active && !reduceMotion && !compact && !expanded ? visible.find(id => videos.has(id)) ?? null : null;
  const playback = useMemo(() => ({playing, register, expand, muted, setMuted, paused, togglePause}), [playing, register, muted, paused, togglePause]);
  return {playback, onViewableItemsChanged};
}
export const SHARED_MEDIA_VIEWABILITY = { itemVisiblePercentThreshold: 65, minimumViewTime: 200 };
