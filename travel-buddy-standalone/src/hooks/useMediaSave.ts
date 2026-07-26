/**
 * useMediaSave — optimistic save/unsave state for media items.
 *
 * - Maintains a per-item saved state.
 * - Optimistically updates before the API call; rolls back on error.
 * - `seed` pre-populates state from feed items (skips items already known).
 * - `toggleSave(id)` fires the API and handles rollback.
 */
import { useState, useCallback, useRef } from 'react';
import { saveMedia, unsaveMedia } from '../services/mediaInteractions.ts';

export interface MediaSaveState {
  /** Pre-seed from feed items — skips items already tracked. */
  seed: (items: ReadonlyArray<{ id: string; savedByMe: boolean }>) => void;
  /** Toggle save for the given item id. */
  toggleSave: (id: string) => Promise<void>;
  isSaved: (id: string) => boolean;
  /** Direct access for spreading into WatchFeedList props. */
  savedSet: Record<string, boolean>;
}

export function useMediaSave(): MediaSaveState {
  const [savedSet, setSavedSet] = useState<Record<string, boolean>>({});
  const inFlightRef = useRef(new Set<string>());

  const seed = useCallback(
    (items: ReadonlyArray<{ id: string; savedByMe: boolean }>) => {
      setSavedSet((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const item of items) {
          if (!(item.id in next)) {
            next[item.id] = item.savedByMe;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const toggleSave = useCallback(async (id: string): Promise<void> => {
    if (inFlightRef.current.has(id)) return;
    inFlightRef.current.add(id);

    const wasSaved = savedSet[id] ?? false;

    // Optimistic update
    setSavedSet((prev) => ({ ...prev, [id]: !wasSaved }));

    try {
      const result = wasSaved ? await unsaveMedia(id) : await saveMedia(id);
      if (!result.ok) {
        // Rollback
        setSavedSet((prev) => ({ ...prev, [id]: wasSaved }));
      }
    } catch {
      // Rollback on unexpected error
      setSavedSet((prev) => ({ ...prev, [id]: wasSaved }));
    } finally {
      inFlightRef.current.delete(id);
    }
  }, [savedSet]);

  const isSaved = useCallback((id: string) => savedSet[id] ?? false, [savedSet]);

  return { seed, toggleSave, isSaved, savedSet };
}
