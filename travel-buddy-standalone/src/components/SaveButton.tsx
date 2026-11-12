/**
 * SaveButton — bookmark icon that opens the collection picker.
 *
 * Usage:
 *   <SaveButton entityType="post" entityId={post.id} />
 *
 * A tap lets users pick or create collections, including additional
 * collections for an already-saved item. Removal is explicit in the sheet.
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
import { checkSaved } from '../services/collections.ts';
import { color } from '../theme/tokens.ts';
import { SaveToCollectionSheet } from './SaveToCollectionSheet.tsx';
import { useSession } from '../context/SessionContext.tsx';
import { getSaved, setSaved as writeSavedCache } from '../services/savedPostsCache.ts';
import { fireRankOutcome } from '../hooks/useRankOutcome.ts';

interface SaveButtonProps {
  entityType: EntityType;
  entityId: string;
  /** Controlled initial saved state (avoids an extra round-trip if parent knows it). */
  initialSaved?: boolean;
  size?: number;
  tint?: string;
  onSavedChange?: (saved: boolean) => void;
  /** Feed session ID forwarded to the rank-outcome endpoint so saves are attributed to the session. */
  sessionId?: string | null;
  /** Other surfaces can record their own outcome instead of attributing to Pulse. */
  recordRankOutcome?: boolean;
}

export function SaveButton(props: SaveButtonProps) {
  const { userId } = useSession();
  return <SaveButtonForItem key={`${userId}:${props.entityType}:${props.entityId}`} {...props} userId={userId} />;
}

function SaveButtonForItem({
  entityType,
  entityId,
  initialSaved,
  size = 20,
  tint,
  onSavedChange,
  sessionId,
  recordRankOutcome = true,
  userId,
}: SaveButtonProps & { userId: ReturnType<typeof useSession>['userId'] }) {

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
      .then(({ saved: s, ok }) => {
        if (!cancelled && mounted.current) {
          if (!hasInteracted.current && ok !== false) {
            setSaved(s);
            // A late read must not replace a completed save in the cache.
            if (entityType === 'post' && userId) writeSavedCache(userId, entityId, s);
          }
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

  const updateSaved = (next: boolean) => {
    hasInteracted.current = true;
    setSaved(next);
    if (entityType === 'post' && userId) writeSavedCache(userId, entityId, next);
    onSavedChange?.(next);
    if (recordRankOutcome && next && !saved) fireRankOutcome(entityId, 'pulse', 'save', sessionId ?? null);
  };

  const iconColor = tint ?? (saved ? color.signal : color.mute);

  return (
    <>
      <Pressable
        onPress={loading ? undefined : () => setPickerOpen(true)}
        onLongPress={loading ? undefined : () => setPickerOpen(true)}
        hitSlop={12}
        style={({ pressed }) => [s.btn, pressed && { opacity: 0.65 }]}
        accessibilityLabel={saved ? 'Manage saved collections' : 'Save to collection'}
        accessibilityHint="Choose a collection or create a new one"
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
        onStatusRead={(value) => {
          if (!mounted.current) return;
          setSaved(value);
          if (entityType === 'post' && userId) writeSavedCache(userId, entityId, value);
        }}
        visible={pickerOpen}
        entityType={entityType}
        entityId={entityId}
        isSaved={saved}
        onClose={() => setPickerOpen(false)}
        onSaved={() => updateSaved(true)}
        onUnsaved={() => {
          updateSaved(false);
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
