/**
 * useStamp — optimistic stamp/unstamp hook with rollback.
 *
 * Wraps the entity-stamp API. On tap the count and isStamped flip
 * immediately; if the API call fails they roll back silently.
 *
 * Shared between StampButton and any custom stamp surface.
 */
import { useState, useCallback } from 'react';
import { stampEntity, unstampEntity } from '../services/stamps.ts';

export interface UseStampOptions {
  entityType: string;
  entityId: string;
  initialCount: number;
  initialIsStamped: boolean;
}

export interface UseStampReturn {
  count: number;
  isStamped: boolean;
  /** True while the API call is in-flight (prevents double-taps). */
  isLoading: boolean;
  /**
   * Toggle stamp state. Resolves after the API call completes (or fails)
   * with the FINAL confirmed { isStamped, count } — callers that need the
   * authoritative post-toggle state (e.g. an animation's onComplete) should
   * use this return value rather than re-reading component state via a ref,
   * which can race ahead of a still-in-flight request.
   */
  toggle: () => Promise<{ isStamped: boolean; count: number }>;
}

export function useStamp({
  entityType,
  entityId,
  initialCount,
  initialIsStamped,
}: UseStampOptions): UseStampReturn {
  const [count, setCount]       = useState(initialCount);
  const [isStamped, setIsStamped] = useState(initialIsStamped);
  const [isLoading, setIsLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (isLoading) return { isStamped, count };
    setIsLoading(true);

    const wasStamped = isStamped;
    const prevCount  = count;
    const optimisticIsStamped = !wasStamped;
    const optimisticCount = wasStamped ? Math.max(0, prevCount - 1) : prevCount + 1;

    // Optimistic update
    setIsStamped(optimisticIsStamped);
    setCount(optimisticCount);

    try {
      const result = wasStamped
        ? await unstampEntity(entityType, entityId)
        : await stampEntity(entityType, entityId);

      if (result.ok) {
        setIsStamped(result.data.isStamped);
        setCount(result.data.count);
        return result.data;
      } else {
        // Server rejected — roll back silently
        setIsStamped(wasStamped);
        setCount(prevCount);
        return { isStamped: wasStamped, count: prevCount };
      }
    } catch {
      setIsStamped(wasStamped);
      setCount(prevCount);
      return { isStamped: wasStamped, count: prevCount };
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, isStamped, count, entityType, entityId]);

  return { count, isStamped, isLoading, toggle };
}
