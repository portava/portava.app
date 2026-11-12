/**
 * useMediaSave — optimistic save/unsave state for media items.
 *
 * - Maintains a per-item saved state.
 * - Optimistically updates before the API call; rolls back on error.
 * - `seed` pre-populates state from feed items (skips items already known).
 * - `toggleSave(id)` fires the API and handles rollback.
 */
import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { saveMedia, unsaveMedia } from '../services/mediaInteractions.ts';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { usePrivateSurfaceKey } from './usePrivateSurfaceKey.ts';

export interface MediaSaveState {
  /** Pre-seed from feed items — skips items already tracked. */
  seed: (items: ReadonlyArray<{ id: string; savedByMe: boolean | null }>) => void; // null (unread, §47) is not stored
  /** Toggle save for the given item id. */
  toggleSave: (id: string) => Promise<void>;
  isSaved: (id: string) => boolean;
  /** Direct access for spreading into WatchFeedList props. */
  savedSet: Record<string, boolean>;
  /** Apply an authoritative result from the collection picker. */
  setSaved: (id: string, saved: boolean) => void;
}

export function useMediaSave(): MediaSaveState {
  const scope = usePrivateSurfaceKey();
  const lifetime = useMemo(() => ({ scope, owner: captureMessagingOwnerRequest(), active: true,
    saved: {} as Record<string, boolean>, pending: new Set<string>(), revisions: new Map<string, number>() }), [scope]);
  const latest = useRef(lifetime);
  latest.current = lifetime;
  const [snapshot, setSnapshot] = useState({ lifetime, saved: lifetime.saved });
  const current = useCallback(() => lifetime === latest.current && lifetime.active && !!lifetime.owner?.isCurrent(), [lifetime]);
  useEffect(() => { lifetime.active = true; return () => { lifetime.active = false; }; }, [lifetime]);
  const publish = useCallback(() => {
    if (current()) setSnapshot({ lifetime, saved: { ...lifetime.saved } });
  }, [current, lifetime]);
  const setSaved = useCallback((id: string, saved: boolean) => {
    if (!current()) return;
    lifetime.saved[id] = saved;
    lifetime.revisions.set(id, (lifetime.revisions.get(id) ?? 0) + 1);
    publish();
  }, [current, lifetime, publish]);

  const seed = useCallback(
    (items: ReadonlyArray<{ id: string; savedByMe: boolean | null }>) => {
      if (!current()) return;
      let changed = false;
      for (const item of items) {
        if (!(item.id in lifetime.saved) && typeof item.savedByMe === 'boolean') {
          lifetime.saved[item.id] = item.savedByMe;
          changed = true;
        }
      }
      if (changed) publish();
    },
    [current, lifetime, publish],
  );

  const toggleSave = useCallback(async (id: string): Promise<void> => {
    if (!current() || lifetime.pending.has(id)) return;
    lifetime.pending.add(id);

    const wasSaved = lifetime.saved[id] ?? false;
    const revision = lifetime.revisions.get(id) ?? 0;

    // Optimistic update
    lifetime.saved[id] = !wasSaved;
    publish();

    try {
      const result = wasSaved ? await unsaveMedia(id) : await saveMedia(id);
      if (current() && !result.ok && revision === (lifetime.revisions.get(id) ?? 0)) {
        // Rollback
        lifetime.saved[id] = wasSaved;
        publish();
      }
    } catch {
      // Rollback on unexpected error
      if (current() && revision === (lifetime.revisions.get(id) ?? 0)) { lifetime.saved[id] = wasSaved; publish(); }
    } finally {
      lifetime.pending.delete(id);
    }
  }, [current, lifetime, publish]);

  const savedSet = snapshot.lifetime === lifetime && current() ? snapshot.saved : {};
  const isSaved = useCallback((id: string) => savedSet[id] ?? false, [savedSet]);

  return { seed, toggleSave, isSaved, savedSet, setSaved };
}
