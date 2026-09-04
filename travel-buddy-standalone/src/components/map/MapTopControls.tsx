/**
 * MapTopControls — floating top control bar for the full-screen map.
 *
 * Absolute-positioned, safe-area-aware. Contains three buttons:
 *   ← Back    — closes the full-screen map (router.back())
 *   ◎ Recenter — re-centers the camera on the user's location or city fallback
 *   ⊞ Filters  — placeholder; expanded in a later task
 *
 * ## Dark chrome (map spec §4)
 *
 * This card used to be `#fff` with `color.ink` glyphs — correct against the
 * old bright OpenFreeMap Liberty base, and unreadable against the near-black
 * navy base the map now renders (see constants/mapStyle.ts). §4 asks for
 * "near-black/navy interface chrome" and "rounded translucent cards", so the
 * card is now a translucent dark surface with a hairline edge: it reads as
 * chrome floating over geography rather than as a white slab punched into it.
 *
 * All colours come from theme/mapChrome.ts — the shared map palette — so this
 * bar restyles with every other map surface rather than drifting on its own.
 *
 * Each touch target is at least 44 px (`avatar.s44`) per HIG guidelines; §4
 * calls for "large mobile touch targets", so that floor is the one number here
 * that must not shrink.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Navigation, SlidersHorizontal } from 'lucide-react-native';
import { radius, space, avatar, icon, type as t } from '../../theme/tokens.ts';
import { mapChrome } from '../../theme/mapChrome.ts';

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
  /**
   * §30 RECENTER. Called when the user taps Recenter, so the shell can return
   * camera control to the machine (FOLLOW_USER). Fired ALONGSIDE the easeTo
   * below, not instead of it: easeTo is the actual camera move, this is the
   * machine's record of the intent behind it. Omitted ⇒ recenter still moves
   * the camera, it just does not update a machine (surfaces without one).
   */
  onRecenter?: () => void;
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
  onRecenter,
  topInset = 0,
}: MapTopControlsProps) {
  const hasUser = userLat != null && userLng != null;
  const hasFallback = fallbackLat != null && fallbackLng != null;

  const handleRecenter = () => {
    // §30 RECENTER first, so the machine records FOLLOW_USER even if there is
    // no camera ref to move (a not-yet-mounted Camera): the intent is real
    // regardless of whether this frame can act on it.
    onRecenter?.();
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
    <View style={[s.container, { top: topInset + space.sm }]} pointerEvents="box-none">
      <View style={s.card}>
        {/* ← Back */}
        <Pressable
          style={s.btn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Back"
          accessibilityRole="button"
        >
          <ArrowLeft size={icon.s18} color={mapChrome.textOnDark} />
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
            <Navigation size={icon.s18} color={mapChrome.signal} />
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
          <SlidersHorizontal size={icon.s18} color={mapChrome.textOnDarkMute} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    zIndex: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: mapChrome.surfaceTranslucent,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairline,
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    ...mapChrome.float,
    gap: 2,
  },
  btn: {
    // §4 "large mobile touch targets" — this is the HIG 44px floor, expressed
    // as a token so it moves with the rest of the sizing scale.
    minHeight: avatar.s44,
    minWidth: avatar.s44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  title: {
    ...t.bodyStrong,
    color: mapChrome.textOnDark,
    fontSize: 14,
    flex: 1,
    textAlign: 'center',
  },
  titleSpacer: {
    flex: 1,
  },
});
