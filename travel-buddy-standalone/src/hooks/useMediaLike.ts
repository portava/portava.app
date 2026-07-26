/**
 * useMediaLike — optimistic like/unlike state for media items.
 *
 * - Maintains a per-item liked state and like count.
 * - Optimistically updates before the API call; rolls back on error.
 * - `seed` pre-populates state from feed items (skips items already known).
 * - `toggleLike(id)` fires the API and handles rollback.
 */
import { useState, useCallback, useRef } from 'react';
import { likeMedia, unlikeMedia } from '../services/mediaInteractions.ts';

export interface MediaLikeState {
  /** Pre-seed from feed items — skips items already tracked. */
  seed: (items: ReadonlyArray<{ id: string; likedByMe: boolean; likeCount: number }>) => void;
  /** Toggle like for the given item id. */
  toggleLike: (id: string) => Promise<void>;
  isLiked: (id: string) => boolean;
  getLikeCount: (id: string) => number;
  /** Direct access for spreading into WatchFeedList props. */
  likedSet: Record<string, boolean>;
  likeCounts: Record<string, number>;
}

export function useMediaLike(): MediaLikeState {
  const [likedSet, setLikedSet] = useState<Record<string, boolean>>({});
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({});
  // Track in-flight toggles to prevent duplicate calls.
  const inFlightRef = useRef(new Set<string>());

  const seed = useCallback(
    (items: ReadonlyArray<{ id: string; likedByMe: boolean; likeCount: number }>) => {
      setLikedSet((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const item of items) {
          if (!(item.id in next)) {
            next[item.id] = item.likedByMe;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setLikeCounts((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const item of items) {
          if (!(item.id in next)) {
            next[item.id] = item.likeCount;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const toggleLike = useCallback(async (id: string): Promise<void> => {
    if (inFlightRef.current.has(id)) return;
    inFlightRef.current.add(id);

    const wasLiked = likedSet[id] ?? false;

    // Optimistic update
    setLikedSet((prev) => ({ ...prev, [id]: !wasLiked }));
    setLikeCounts((prev) => ({
      ...prev,
      [id]: Math.max(0, (prev[id] ?? 0) + (wasLiked ? -1 : 1)),
    }));

    try {
      const result = wasLiked ? await unlikeMedia(id) : await likeMedia(id);
      if (!result.ok) {
        // Rollback
        setLikedSet((prev) => ({ ...prev, [id]: wasLiked }));
        setLikeCounts((prev) => ({
          ...prev,
          [id]: Math.max(0, (prev[id] ?? 0) + (wasLiked ? 1 : -1)),
        }));
      }
    } catch {
      // Rollback on unexpected error
      setLikedSet((prev) => ({ ...prev, [id]: wasLiked }));
      setLikeCounts((prev) => ({
        ...prev,
        [id]: Math.max(0, (prev[id] ?? 0) + (wasLiked ? 1 : -1)),
      }));
    } finally {
      inFlightRef.current.delete(id);
    }
  }, [likedSet]);

  const isLiked = useCallback((id: string) => likedSet[id] ?? false, [likedSet]);
  const getLikeCount = useCallback((id: string) => likeCounts[id] ?? 0, [likeCounts]);

  return { seed, toggleLike, isLiked, getLikeCount, likedSet, likeCounts };
}
