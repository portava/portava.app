/**
 * MapTopControls — floating top control bar for the full-screen map.
 *
 * Absolute-positioned, safe-area-aware. Contains three buttons:
 *   ← Back    — closes the full-screen map (router.back())
 *   ◎ Recenter — re-centers the camera on the user's location or city fallback
 *   ⊞ Filters  — placeholder; expanded in a later task
 *
 * Each touch target is at least 44 px tall per HIG guidelines.
 * The card background is white with a subtle shadow so the controls stay
 * legible over any map tile.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Navigation, SlidersHorizontal } from 'lucide-react-native';
import { color, radius, type as t } from '../../theme/tokens.ts';

export interface MapTopControlsProps {
  /** Camera ref forwarded from the map screen so Recenter can call setCamera. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cameraRef?: React.RefObject<any>;
  /** User's current latitude — used for recenter. */
  userLat?: number | null;
  /** User's current longitude — used for recenter. */
  userLng?: number | null;
  /** City-level fallback latitude — used for recenter when no GPS. */
  fallbackLat?: number | null;
  /** City-level fallback longitude — used for recenter when no GPS. */
  fallbackLng?: number | null;
  /** Optional label shown in the header (e.g. city name). */
  title?: string | null;
  /** Called when the user taps the Filter button. */
  onFiltersPress?: () => void;
  /** Additional top inset to position below the status bar / notch. */
  topInset?: number;
}

export function MapTopControls({
  cameraRef,
  userLat,
  userLng,
  fallbackLat,
  fallbackLng,
  title,
  onFiltersPress,
  topInset = 0,
}: MapTopControlsProps) {
  const hasUser = userLat != null && userLng != null;
  const hasFallback = fallbackLat != null && fallbackLng != null;

  const handleRecenter = () => {
    if (!cameraRef?.current) return;
    const lat = hasUser ? (userLat as number) : (fallbackLat as number);
    const lng = hasUser ? (userLng as number) : (fallbackLng as number);
    if (lat == null || lng == null) return;
    // Guard: easeTo is the v11 replacement for setCamera; check existence so
    // a future API change fails soft (no crash) rather than throwing a TypeError.
    if (typeof cameraRef.current.easeTo === 'function') {
      cameraRef.current.easeTo({
        center: [lng, lat],
        zoom: hasUser ? 14 : 11,
        duration: 600,
      });
    }
  };

  return (
    <View style={[s.container, { top: topInset + 8 }]} pointerEvents="box-none">
      <View style={s.card}>
        {/* ← Back */}
        <Pressable
          style={s.btn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Back"
          accessibilityRole="button"
        >
          <ArrowLeft size={18} color={color.ink} />
        </Pressable>

        {/* Title */}
        {title ? (
          <Text style={s.title} numberOfLines={1}>{title}</Text>
        ) : (
          <View style={s.titleSpacer} />
        )}

        {/* ◎ Recenter */}
        {(hasUser || hasFallback) && (
          <Pressable
            style={s.btn}
            onPress={handleRecenter}
            hitSlop={8}
            accessibilityLabel="Recenter map"
            accessibilityRole="button"
          >
            <Navigation size={18} color={color.signal} />
          </Pressable>
        )}

        {/* ⊞ Filters */}
        <Pressable
          style={s.btn}
          onPress={onFiltersPress}
          hitSlop={8}
          accessibilityLabel="Open filters"
          accessibilityRole="button"
        >
          <SlidersHorizontal size={18} color={color.mute} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: radius.md,
    paddingHorizontal: 4,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    gap: 2,
  },
  btn: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
    flex: 1,
    textAlign: 'center',
  },
  titleSpacer: {
    flex: 1,
  },
});
