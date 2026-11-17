/**
 * useStamp — optimistic stamp/unstamp hook with rollback.
 *
 * Wraps the entity-stamp API. On tap the count and isStamped flip
 * immediately; if the API call fails they roll back silently.
 *
 * Shared between StampButton and any custom stamp surface.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { stampEntity, unstampEntity } from '../services/stamps.ts'; import { stepCount } from '../lib/unreadCount.ts';

export interface UseStampOptions {
  entityType: string;
  entityId: string;
  initialCount: number | null; // null = the server could not read it (census-media §47)
  initialIsStamped: boolean;
}

export interface UseStampReturn {
  count: number | null; // null = unread; an optimistic step keeps it unread
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
  toggle: () => Promise<{ isStamped: boolean; count: number | null }>;
}

export function useStamp({
  entityType,
  entityId,
  initialCount,
  initialIsStamped,
}: UseStampOptions): UseStampReturn {
  const [count, setCount]       = useState<number | null>(initialCount);
  const [isStamped, setIsStamped] = useState(initialIsStamped);
  const [isLoading, setIsLoading] = useState(false);

  const key = `${entityType}:${entityId}`;
  const active = useRef({ key, generation: 0 });
  const inFlight = useRef<Promise<{ isStamped: boolean; count: number | null }> | null>(null);
  if (active.current.key !== key) {
    active.current = { key, generation: active.current.generation + 1 };
    inFlight.current = null;
  }
  useEffect(() => {
    setCount(initialCount); setIsStamped(initialIsStamped); setIsLoading(false);
    // Reset only when the entity changes; an optimistic count owns this entity until settled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => { active.current.generation += 1; inFlight.current = null; }, []);

  const toggle = useCallback(() => {
    // The ref closes the same-render double-tap gap before React commits loading.
    if (inFlight.current) return inFlight.current;
    const generation = active.current.generation;
    const current = () => active.current.key === key && active.current.generation === generation;
    const wasStamped = isStamped;
    const prevCount = count;
    setIsLoading(true);
    setIsStamped(!wasStamped);
    setCount(stepCount(prevCount, !wasStamped));
    const work = (async () => {
      try {
        const result = wasStamped
          ? await unstampEntity(entityType, entityId)
          : await stampEntity(entityType, entityId);
        if (result.ok) {
          if (current()) { setIsStamped(result.data.isStamped); setCount(result.data.count); }
          return result.data;
        }
        if (current()) { setIsStamped(wasStamped); setCount(prevCount); }
        return { isStamped: wasStamped, count: prevCount };
      } catch {
        if (current()) { setIsStamped(wasStamped); setCount(prevCount); }
        return { isStamped: wasStamped, count: prevCount };
      } finally {
        if (current()) { setIsLoading(false); inFlight.current = null; }
      }
    })();
    inFlight.current = work;
    return work;
  }, [isStamped, count, entityType, entityId, key]);

  return { count, isStamped, isLoading, toggle };
}
