/**
 * MapFloatingControls — the §3 floating map controls: zoom in / out and an
 * orientation reset (compass → north).
 *
 * ## What §3 asks for
 *
 * "Floating controls: recenter, navigation/orientation, zoom where appropriate."
 * Recenter lives in MapTopControls (it needs the user/city fallback the top bar
 * already holds and dispatches §30 RECENTER). This component owns the other two:
 * a vertical zoom stack and a compass that snaps the map back to north.
 *
 * ## Camera primitives, not machine events
 *
 * Zoom and orientation are camera PRIMITIVES — they change the viewport without
 * changing the §30 camera AXIS (FOLLOW_USER / FREE_EXPLORE / FOCUS_*). The state
 * machine has no ZOOM or ORIENT event, and inventing one would be modelling a
 * lens adjustment as a navigation decision. So these operate the shared camera
 * ref directly (the same pattern MapTopControls' Recenter uses for its easeTo),
 * and the re-query they cause rides useMapEntities' §34 camera-settle path like
 * any other camera move. A button-driven zoom is a PROGRAMMATIC camera change,
 * so DiscoveryMapView's userInteraction gate never mistakes it for USER_PANNED.
 *
 * ## Why step from the live zoom
 *
 * Zoom in/out step from `zoom` — the camera's REAL current zoom (the shell's
 * `activeZoom`) — not from a control-local counter. Off a stale counter, two
 * taps after the user had pinched would fight the camera; off the live value
 * each tap is exactly one level from where the map actually is.
 *
 * ## Dark chrome (§4)
 *
 * Same translucent dark surface + hairline as MapTopControls, from the shared
 * `mapChrome` palette, and the same 44 px (`avatar.s44`) touch-target floor §4
 * calls for.
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Plus, Minus, Compass } from 'lucide-react-native';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { radius, space, avatar, icon } from '../../theme/tokens.ts';
import { mapChrome } from '../../theme/mapChrome.ts';

/** One zoom level per tap. */
export const ZOOM_STEP = 1;
/** Clamp so a tap can never drive the camera past a usable range. */
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 20;

export interface MapFloatingControlsProps {
  /**
   * Shared camera ref (the same one MapTopControls / DiscoveryMapView hold).
   * Typed as the v11 imperative handle; null until the Camera mounts.
   */
  cameraRef?: React.RefObject<CameraRef | null>;
  /** The camera's live zoom, so +/- steps from where the map actually is. */
  zoom: number;
  /** Bottom offset so the stack clears the carousel / action rail. */
  bottomInset?: number;
  /** Telemetry / test hooks — fired only when the control actually acted. */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onOrientationReset?: () => void;
}

export function MapFloatingControls({
  cameraRef,
  zoom,
  bottomInset = 0,
  onZoomIn,
  onZoomOut,
  onOrientationReset,
}: MapFloatingControlsProps) {
  const stepZoom = (delta: number, onDone?: () => void) => {
    const base = Number.isFinite(zoom) ? zoom : 12;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base + delta));
    // Already at the clamp — do nothing (and do not report an action that had
    // no effect).
    if (next === base) return;
    const cam = cameraRef?.current;
    // Guard existence: zoomTo is the v11 imperative method; a future API change
    // fails soft rather than throwing under the user's thumb.
    if (cam && typeof cam.zoomTo === 'function') {
      cam.zoomTo(next, { duration: 250 });
    }
    onDone?.();
  };

  const resetNorth = () => {
    const cam = cameraRef?.current;
    // setStop (not easeTo) because easeTo requires a centre; setStop accepts a
    // centre-less stop, so bearing can be reset without moving the map.
    if (cam && typeof cam.setStop === 'function') {
      void cam.setStop({ bearing: 0, duration: 300 });
    }
    onOrientationReset?.();
  };

  return (
    <View style={[s.container, { bottom: bottomInset }]} pointerEvents="box-none">
      <View style={s.card}>
        <Pressable
          style={s.btn}
          onPress={() => stepZoom(ZOOM_STEP, onZoomIn)}
          hitSlop={8}
          accessibilityLabel="Zoom in"
          accessibilityRole="button"
        >
          <Plus size={icon.s18} color={mapChrome.textOnDark} />
        </Pressable>
        <View style={s.divider} />
        <Pressable
          style={s.btn}
          onPress={() => stepZoom(-ZOOM_STEP, onZoomOut)}
          hitSlop={8}
          accessibilityLabel="Zoom out"
          accessibilityRole="button"
        >
          <Minus size={icon.s18} color={mapChrome.textOnDark} />
        </Pressable>
      </View>

      <Pressable
        style={[s.card, s.compassBtn]}
        onPress={resetNorth}
        hitSlop={8}
        accessibilityLabel="Reset orientation to north"
        accessibilityRole="button"
      >
        <Compass size={icon.s18} color={mapChrome.signal} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute',
    right: space.md,
    alignItems: 'center',
    gap: space.sm,
    zIndex: 20,
  },
  card: {
    backgroundColor: mapChrome.surfaceTranslucent,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairline,
    ...mapChrome.float,
    overflow: 'hidden',
  },
  btn: {
    // §4 "large mobile touch targets" — the HIG 44 px floor as a token.
    minHeight: avatar.s44,
    minWidth: avatar.s44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: mapChrome.hairline,
  },
  compassBtn: {
    minHeight: avatar.s44,
    minWidth: avatar.s44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
