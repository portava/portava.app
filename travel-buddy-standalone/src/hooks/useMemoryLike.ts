/**
 * useMemoryLike — the Memory like, as a StampButton controller.
 *
 * `GET /memories/:id` reads `likeCount` / `likedByMe` from `memory_likes`. The
 * Memory screen's StampButton used to write an entity STAMP instead (a different
 * table), so its count and the server's disagreed on the next load. This hook
 * has the same shape as `useStamp` (`UseStampReturn`) and writes through
 * `POST|DELETE /memories/:id/like`, so StampButton keeps its gesture and
 * animation and the write lands where the count is read from (HM-F09).
 *
 * Optimistic with rollback, like `useStamp`. The server's count wins when it
 * sends one; it sends `null` when it could not count after a successful write,
 * and then the optimistic count stands rather than a fabricated zero.
 */
import { useCallback, useEffect, useState } from 'react';
import { likeMemory, unlikeMemory } from '../services/memories.ts';
import type { UseStampReturn } from './useStamp.ts';

export function useMemoryLike(memoryId: string, initialCount: number, initialLiked: boolean): UseStampReturn {
  const [count, setCount] = useState(initialCount);
  const [isStamped, setIsStamped] = useState(initialLiked);
  const [isLoading, setIsLoading] = useState(false);

  // A reload of the Memory (focus refetch) brings the server's current values.
  useEffect(() => { setCount(initialCount); setIsStamped(initialLiked); }, [memoryId, initialCount, initialLiked]);

  const toggle = useCallback(async () => {
    if (isLoading) return { isStamped, count };
    setIsLoading(true);
    const wasLiked = isStamped;
    const prevCount = count;
    const nextLiked = !wasLiked;
    const optimisticCount = wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1;
    setIsStamped(nextLiked);
    setCount(optimisticCount);
    try {
      const res = wasLiked ? await unlikeMemory(memoryId) : await likeMemory(memoryId);
      if (!res.ok) {
        setIsStamped(wasLiked);
        setCount(prevCount);
        return { isStamped: wasLiked, count: prevCount };
      }
      const serverCount = typeof res.likeCount === 'number' ? res.likeCount : optimisticCount;
      setCount(serverCount);
      return { isStamped: nextLiked, count: serverCount };
    } catch {
      setIsStamped(wasLiked);
      setCount(prevCount);
      return { isStamped: wasLiked, count: prevCount };
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, isStamped, count, memoryId]);

  return { count, isStamped, isLoading, toggle };
}
