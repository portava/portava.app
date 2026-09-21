/**
 * UserPositionMarker — §6's "blue dot = current user" (census-map M43).
 *
 * WHY A COMPONENT AND NOT FOUR LINES INSIDE THE MAP VIEW
 * =====================================================
 * M43 has sat at BUILT-BUT-WRONG on one piece of evidence: `LayersSheet`'s
 * legend carries a `blue_dot` row (§6's own vocabulary) and nothing in the tree
 * could be shown to draw it. The dot itself was four lines of JSX inline in
 * `DiscoveryMapView`, keyed `me-marker`, with no identity of its own — so:
 *
 *   - nothing could assert it was mounted,
 *   - the legend's colour and the marker's colour were two independent
 *     literals that had already drifted apart ('#3B82F6' vs '#2D7FF9'), and
 *   - the SDK's own `UserLocation` puck — which is what gives a real device a
 *     heading cone and an accuracy halo — was never reachable from that call
 *     site at all.
 *
 * Giving the dot a module makes all three answerable. `USER_POSITION_COLOR` is
 * the one source the legend and the renderer both quote; `USER_POSITION_TEST_ID`
 * is the node a component test can find; and `followDeviceFix` selects the
 * SDK puck when the platform is providing the fix.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ================================
 * It never asks for a position. §19 keeps location acquisition and permission
 * state out of renderers, and a marker that could start a GPS session would be
 * a permission prompt hiding inside a draw call. The position arrives as props;
 * with no usable position this renders NOTHING rather than a dot at 0,0 — the
 * null island is a real coordinate off the coast of Ghana and a map that
 * cheerfully puts the viewer there is worse than a map that admits it does not
 * know.
 *
 * MOUNTING
 * ========
 * It returns MapLibre children (`UserLocation` / `Marker`), so it must be
 * rendered INSIDE the MapLibre Map element, and it must be mounted
 * UNCONDITIONALLY — not inside an `entities.length > 0` branch. Where the
 * viewer is does not depend on how many other pins the projection returned;
 * that coupling is the defect M43 names. The component fails closed on its own
 * (see `hasViewerPosition`), so an unconditional mount is safe.
 *
 * This file renders no Map of its own, so it is not a "map surface" and has no
 * `onDidFailLoadingMap` to offer. The element name is deliberately written in
 * prose above rather than in angle brackets: `mapStyleUsage.test.ts`'s
 * `RENDERS_MAP` regex is applied to the raw file, comments included, so writing
 * it as markup would classify this component as a surface that owns a basemap.
 * (`EntityMarkers.tsx` is on that guard's known-missing list for exactly this
 * reason — see the note in the lane report.)
 *
 * SDK NOTE
 * ========
 * Same safe-require pattern as every other map component here: v11 exposes
 * `Marker` and `UserLocation`. The repo's jest stub mirrors both, so the
 * component is mountable under jest-expo without the native GL modules.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Marker, UserLocation } = _ml as typeof import('@maplibre/maplibre-react-native');

import { dot, icon } from '../../theme/tokens.ts';

/**
 * §6's blue dot, as ONE literal.
 *
 * `LayersSheet`'s legend imports this rather than restating it, so the swatch
 * in the legend and the dot on the map cannot drift again. The value is the
 * one the map has actually been drawing.
 */
export const USER_POSITION_COLOR = '#2D7FF9';

/** The halo around the dot — the same blue at 25% alpha. */
export const USER_POSITION_HALO_COLOR = 'rgba(45,127,249,0.25)';

/**
 * The node a test (and an accessibility tree) finds. Exported so no test has to
 * restate the string and silently pass against a renamed marker.
 */
export const USER_POSITION_TEST_ID = 'user-position-marker';

/**
 * The inner dot, separately addressable.
 *
 * Exported so a test can read the swatch the map actually drew without
 * reaching into `children[0]` and casting a renderer-internal node — a cast
 * `check-test-typecheck` correctly refuses, and which would also silently start
 * reading the wrong node the day the marker gains a heading cone.
 */
export const USER_POSITION_DOT_TEST_ID = 'user-position-dot';

/** Human-readable name for the same node. §39: every object answers something. */
export const USER_POSITION_LABEL = 'Your position';

export interface UserPositionMarkerProps {
  /** The viewer's latitude. */
  lat?: number | null;
  /** The viewer's longitude. */
  lng?: number | null;
  /**
   * Render the SDK's own user-location puck (live fix, heading cone, accuracy
   * halo) instead of a static dot at `lat`/`lng`.
   *
   * OFF by default, and the default is the load-bearing choice: the puck draws
   * wherever the PLATFORM thinks the device is, which is not necessarily the
   * position the screen is reasoning about. A screen that has a cached or
   * fallback fix and hands it in as props must see THAT point drawn, or the dot
   * and the camera disagree.
   */
  followDeviceFix?: boolean;
  /** Escape hatch for a screen that wants the dot suppressed (e.g. a capture). */
  visible?: boolean;
}

/**
 * Is this a position that may be drawn?
 *
 * Exported so a caller can explain a missing dot instead of leaving a silent
 * hole — the same reason `eligibleFlows` is exported from `CrowdFlowLine`.
 *
 * `0, 0` is rejected on purpose. It is the value a missing fix degrades to in
 * every numeric pipeline in this app, and it is also a real place; drawing it
 * would put the viewer in the Gulf of Guinea with full confidence.
 */
export function hasViewerPosition(
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

export function UserPositionMarker({
  lat,
  lng,
  followDeviceFix = false,
  visible = true,
}: UserPositionMarkerProps) {
  if (!visible) return null;

  // The SDK puck, when the platform owns the fix. Rendered INSTEAD of the
  // static dot, never alongside it — two blue dots a few metres apart read as
  // two people.
  if (followDeviceFix && UserLocation) {
    return (
      <UserLocation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ testID: USER_POSITION_TEST_ID } as any)}
        visible
        showsUserHeadingIndicator
      />
    );
  }

  if (!Marker) return null;
  if (!hasViewerPosition(lat, lng)) return null;

  return (
    <Marker key="user-position" lngLat={[lng as number, lat as number]}>
      <View
        testID={USER_POSITION_TEST_ID}
        accessibilityLabel={USER_POSITION_LABEL}
        style={s.halo}
        pointerEvents="none"
      >
        <View testID={USER_POSITION_DOT_TEST_ID} style={s.dot} />
      </View>
    </Marker>
  );
}

const s = StyleSheet.create({
  halo: {
    width: icon.s22,
    height: icon.s22,
    borderRadius: icon.s22 / 2,
    backgroundColor: USER_POSITION_HALO_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    backgroundColor: USER_POSITION_COLOR,
    borderWidth: 2,
    borderColor: '#fff',
  },
});
