/**
 * useMemoryViewedTelemetry — emits §32 `memory_viewed` once per memory, once
 * the memory has actually loaded on the detail screen (`/memory/:id`).
 *
 * The detail screen is the ONE place a memory is "viewed": every entry path —
 * the Passport Home memories strip, the viewer Memories tab, the Timeline and
 * People views, a deep link — lands here, so emitting here (and only here)
 * counts a view exactly once instead of once per thumbnail press plus once per
 * load. Payload is the opaque memory id only (§32 privacy rules).
 */
import { useEffect, useRef } from 'react';
import { trackMemoryViewed } from './passportTelemetry.ts';

export function useMemoryViewedTelemetry(memoryId: string | null | undefined, loaded: boolean): void {
  const emittedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = (memoryId ?? '').trim();
    if (!loaded || !id) return;
    if (emittedFor.current === id) return;
    emittedFor.current = id;
    trackMemoryViewed(id);
  }, [memoryId, loaded]);
}
