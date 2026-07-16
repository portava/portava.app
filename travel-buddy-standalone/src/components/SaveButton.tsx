/**
 * SaveButton — bookmark icon that toggles save state.
 *
 * Usage:
 *   <SaveButton entityType="post" entityId={post.id} />
 *
 * Long-press opens the SaveToCollectionSheet so the user can pick a
 * specific collection (or create one).
 *
 * For posts the savedPostsCache is consulted first so re-mounts during
 * feed navigation show the correct bookmark state instantly, without
 * waiting for an API round-trip.  Non-post entity types fall through to
 * the existing initialSaved prop / checkSaved() hydration path.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { Bookmark } from 'lucide-react-native';
import type { EntityType } from '../services/collections.ts';
import { saveItem, unsaveItem, checkSaved } from '../services/collections.ts';
import { color } from '../theme/tokens.ts';
import { SaveToCollectionSheet } from './SaveToCollectionSheet.tsx';
import { useSession } from '../context/SessionContext.tsx';
import { getSaved, setSaved as writeSavedCache } from '../services/savedPostsCache.ts';

interface SaveButtonProps {
  entityType: EntityType;
  entityId: string;
  /** Controlled initial saved state (avoids an extra round-trip if parent knows it). */
  initialSaved?: boolean;
  size?: number;
  tint?: string;
  onSavedChange?: (saved: boolean) => void;
}

export function SaveButton({
  entityType,
  entityId,
  initialSaved,
  size = 20,
  tint,
  onSavedChange,
}: SaveButtonProps) {
  const { userId } = useSession();

  // For posts: read from the pre-warmed cache first so the bookmark renders
  // correctly from the first paint without a round-trip.  Non-post types
  // fall through to the initialSaved prop as before.
  const cachedSaved = (entityType === 'post' && userId)
    ? getSaved(userId, entityId)
    : undefined;

  const [saved, setSaved]           = useState(cachedSaved ?? initialSaved ?? false);
  const [loading, setLoading]       = useState(cachedSaved === undefined && initialSaved === undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const mounted = useRef(true);

  // Prevent incoming prop/cache updates from overwriting an explicit tap.
  const hasInteracted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Hydrate saved state on mount or when key props change.
  // Priority: cache (posts only) → initialSaved prop → checkSaved() round-trip.
  useEffect(() => {
    // Posts: prefer cache so preloaded saved state takes effect immediately.
    if (entityType === 'post' && userId) {
      const cached = getSaved(userId, entityId);
      if (cached !== undefined) {
        if (!hasInteracted.current) setSaved(cached);
        setLoading(false);
        return;
      }
    }
    // Prop provided by parent (e.g. from feed API response).
    if (initialSaved !== undefined) {
      if (!hasInteracted.current) setSaved(initialSaved);
      setLoading(false);
      return;
    }
    // Last resort: ask the server (non-post types always land here when no prop).
    let cancelled = false;
    setLoading(true);
    checkSaved(entityType, entityId)
      .then(({ saved: s }) => {
        if (!cancelled && mounted.current) {
          if (!hasInteracted.current) setSaved(s);
          // Prime the cache so subsequent re-mounts skip the round-trip.
          if (entityType === 'post' && userId) writeSavedCache(userId, entityId, s);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled && mounted.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, initialSaved, userId]);

  // Sync when the feed refreshes a new initialSaved prop (e.g. after pull-to-
  // refresh).  Prefer the cache if populated; skip entirely if the user has
  // already tapped in this component instance so their action takes precedence.
  useEffect(() => {
    if (hasInteracted.current) return;
    const cached = (entityType === 'post' && userId) ? getSaved(userId, entityId) : undefined;
    setSaved(cached ?? initialSaved ?? false);
  }, [initialSaved, userId, entityId, entityType]);

  const toggle = async () => {
    hasInteracted.current = true;
    const next = !saved;
    // Optimistic update: write to cache immediately so re-mounts during the
    // API call already show the correct state.
    setSaved(next);
    if (entityType === 'post' && userId) writeSavedCache(userId, entityId, next);
    onSavedChange?.(next);
    const ok = next
      ? await saveItem(entityType, entityId)
      : await unsaveItem(entityType, entityId);
    if (!ok && mounted.current) {
      // Revert on failure.
      setSaved(!next);
      if (entityType === 'post' && userId) writeSavedCache(userId, entityId, !next);
      onSavedChange?.(!next);
    }
  };

  const iconColor = tint ?? (saved ? color.signal : color.mute);

  return (
    <>
      <Pressable
        onPress={loading ? undefined : toggle}
        onLongPress={loading ? undefined : () => setPickerOpen(true)}
        hitSlop={8}
        style={({ pressed }) => [s.btn, pressed && { opacity: 0.65 }]}
        accessibilityLabel={saved ? 'Unsave' : 'Save'}
        accessibilityRole="button"
      >
        {loading ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <Bookmark
            size={size}
            color={iconColor}
            fill={saved ? iconColor : 'none'}
            strokeWidth={saved ? 0 : 1.8}
          />
        )}
      </Pressable>

      <SaveToCollectionSheet
        visible={pickerOpen}
        entityType={entityType}
        entityId={entityId}
        onClose={() => setPickerOpen(false)}
        onSaved={(colId) => {
          setSaved(true);
          if (entityType === 'post' && userId) writeSavedCache(userId, entityId, true);
          onSavedChange?.(true);
          setPickerOpen(false);
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS !== 'web' ? { minWidth: 32, minHeight: 32 } : {}),
  },
});
