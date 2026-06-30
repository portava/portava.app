/**
 * SaveButton — bookmark icon that toggles save state.
 *
 * Usage:
 *   <SaveButton entityType="post" entityId={post.id} />
 *
 * Long-press opens the SaveToCollectionSheet so the user can pick a
 * specific collection (or create one).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { Bookmark } from 'lucide-react-native';
import type { EntityType } from '../services/collections';
import { saveItem, unsaveItem, checkSaved } from '../services/collections';
import { color } from '../theme/tokens';
import { SaveToCollectionSheet } from './SaveToCollectionSheet';

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
  const [saved, setSaved]           = useState(initialSaved ?? false);
  const [loading, setLoading]       = useState(initialSaved === undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Hydrate saved state if not provided
  useEffect(() => {
    if (initialSaved !== undefined) { setSaved(initialSaved); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    checkSaved(entityType, entityId)
      .then(({ saved: s }) => { if (!cancelled && mounted.current) { setSaved(s); setLoading(false); } })
      .catch(() => { if (!cancelled && mounted.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, initialSaved]);

  const toggle = async () => {
    const next = !saved;
    setSaved(next);
    onSavedChange?.(next);
    const ok = next
      ? await saveItem(entityType, entityId)
      : await unsaveItem(entityType, entityId);
    if (!ok && mounted.current) {
      setSaved(!next);
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
