/**
 * useWatchPlayback — manages Watch-mode video playback lifecycle.
 *
 * Handles:
 *   - Tab blur (useFocusEffect) → pause all, resume active on refocus.
 *   - AppState background transition → pause all.
 *   - MEDIA_PAUSE_ALL event from mediaEvents emitter → pause all.
 *
 * Usage:
 *   const { registerRef, unregisterRef, setActiveId } = useWatchPlayback();
 *   // In each WatchVideoCell:
 *   useEffect(() => { registerRef(id, videoRef); return () => unregisterRef(id); }, []);
 */

import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { Video } from 'expo-av';
import { mediaEvents } from '../lib/mediaEvents.ts';

type VideoRef = React.RefObject<Video | null>;

export interface WatchPlaybackManager {
  /** Register a video ref under a stable item ID. */
  registerRef: (id: string, ref: VideoRef) => void;
  /** Remove a ref when the cell unmounts. */
  unregisterRef: (id: string) => void;
  /** Declare which item is currently active. Only that item will play. */
  setActiveId: (id: string | null) => void;
}

export function useWatchPlayback(): WatchPlaybackManager {
  const refsMap = useRef<Map<string, VideoRef>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  // Track whether the screen is currently focused.
  const focusedRef = useRef(true);

  // ── Pause all currently registered videos ──────────────────────────────────

  const pauseAll = useCallback(async () => {
    for (const [, ref] of refsMap.current) {
      try {
        await ref.current?.pauseAsync();
      } catch {
        // Best-effort
      }
    }
  }, []);

  // ── Resume the active video (if any) ───────────────────────────────────────

  const resumeActive = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    const ref = refsMap.current.get(id);
    try {
      await ref?.current?.playAsync();
    } catch {
      // Best-effort
    }
  }, []);

  // ── Tab focus / blur ────────────────────────────────────────────────────────

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      resumeActive();
      return () => {
        focusedRef.current = false;
        pauseAll();
      };
    }, [pauseAll, resumeActive]),
  );

  // ── AppState: pause when app goes to background ────────────────────────────

  useEffect(() => {
    const handleAppState = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        pauseAll();
      } else if (next === 'active' && focusedRef.current) {
        resumeActive();
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [pauseAll, resumeActive]);

  // ── MEDIA_PAUSE_ALL event ──────────────────────────────────────────────────

  useEffect(() => {
    const unsub = mediaEvents.on('MEDIA_PAUSE_ALL', pauseAll);
    return unsub;
  }, [pauseAll]);

  // ── Public API ──────────────────────────────────────────────────────────────

  const registerRef = useCallback((id: string, ref: VideoRef) => {
    refsMap.current.set(id, ref);
  }, []);

  const unregisterRef = useCallback((id: string) => {
    refsMap.current.delete(id);
  }, []);

  const setActiveId = useCallback(
    async (id: string | null) => {
      if (activeIdRef.current === id) return;

      // Pause the previous active item.
      const prevId = activeIdRef.current;
      if (prevId) {
        const prevRef = refsMap.current.get(prevId);
        try {
          await prevRef?.current?.pauseAsync();
        } catch {
          // Best-effort
        }
      }

      activeIdRef.current = id;

      // Play the new active item (only if the screen is focused).
      if (id && focusedRef.current) {
        const ref = refsMap.current.get(id);
        try {
          await ref?.current?.playAsync();
        } catch {
          // Best-effort
        }
      }
    },
    [],
  );

  return { registerRef, unregisterRef, setActiveId };
}
