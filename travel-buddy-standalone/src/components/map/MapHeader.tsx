/**
 * MapHeader — the §3 Live Map / Map Home header.
 *
 * §3, verbatim: "Header: menu, current city/area selector, search, layers."
 *
 * Four affordances, in that order, on one row that floats over the map canvas.
 * §3 also says "Map canvas dominates the screen", so this is a translucent bar
 * rather than an opaque navigation chrome that eats the top of the viewport.
 *
 * DARK-MODE-FIRST (§4)
 * ====================
 * "Near-black/navy interface chrome and subdued geographic base." The tokens in
 * theme/tokens.ts are the app's light editorial palette; the map is the one
 * surface that inverts, and its dark values live in theme/mapChrome.ts. This
 * component takes them from there rather than retyping hex codes, so the header
 * restyles with the rest of the map chrome instead of drifting away from it.
 *
 * WHAT THIS COMPONENT DOES NOT DO
 * ===============================
 * Nothing. It is presentational to the point of being boring, on purpose:
 *   - no navigation (every affordance is a callback prop),
 *   - no API calls, no geocoding, no "which city am I in" resolution,
 *   - no storage, no AsyncStorage, no layer preferences,
 *   - no state beyond React's own press feedback.
 *
 * The city name is RESOLVED ELSEWHERE and passed in. When it is null the header
 * says so honestly ("Choose a city") rather than inventing a placeholder that
 * reads like a real answer — §39's rule for map objects applies just as much to
 * chrome: do not display a claim you cannot support.
 *
 * STACKING (see the header of MapTopControls.tsx)
 * ==============================================
 * MapHeader owns the top strip; MapTopControls floats BELOW it. Both are
 * absolutely positioned and both take an explicit inset rather than calling
 * useSafeAreaInsets themselves, so the screen decides the ladder in one place:
 *
 *     <MapHeader topInset={insets.top} />
 *     <MapFilterChips topInset={mapHeaderStackOffset(insets.top)} />
 *     <MapTopControls topInset={mapHeaderStackOffset(insets.top) + MAP_FILTER_CHIPS_HEIGHT} />
 *
 * `mapHeaderStackOffset` is exported for exactly that sum. This component sits at
 * zIndex 30, one rung above MapTopControls' 20, because a header must never be
 * overlapped by the controls that hang beneath it.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, Layers, Menu, Search } from 'lucide-react-native';
import { dot, icon, radius, space, type as t } from '../../theme/tokens.ts';
import { mapChrome } from '../../theme/mapChrome.ts';

/**
 * The bar's own height, excluding the safe-area inset and the gap beneath it.
 * Exported so the screen can offset whatever floats below without measuring.
 */
export const MAP_HEADER_HEIGHT = 52;

/** Gap between the bar and the next floating row. */
export const MAP_HEADER_GAP = 8;

/**
 * What the screen should pass as MapTopControls' `topInset` so the controls
 * clear this header instead of drawing over it.
 */
export function mapHeaderStackOffset(safeAreaTop: number): number {
  return safeAreaTop + MAP_HEADER_HEIGHT + MAP_HEADER_GAP;
}

/** Shown in place of the city name when nothing has resolved yet. */
export const CITY_PLACEHOLDER_LABEL = 'Choose a city';

export interface MapHeaderProps {
  /**
   * The current city / area, already resolved by the screen. `null` means "not
   * known yet" — the selector renders an honest placeholder and stays tappable
   * so the user can pick one.
   */
  city: string | null;
  /**
   * Optional finer-grained area within the city (a district, a neighbourhood).
   * Shown as a second line only when it is present AND differs from the city.
   */
  area?: string | null;
  /** Safe-area top inset. The screen owns useSafeAreaInsets, not this bar. */
  topInset?: number;
  /** Tap the hamburger. */
  onMenuPress?: () => void;
  /** Tap the city/area selector. */
  onCityPress?: () => void;
  /** Tap search. */
  onSearchPress?: () => void;
  /** Tap layers — opens the §16 Layers / Legend sheet. */
  onLayersPress?: () => void;
  /**
   * How many layers are currently switched on by an explicit user choice.
   * Renders a small dot on the Layers button so a user who has customised
   * their map can see that at a glance. Omit or 0 for no dot.
   */
  customisedLayerCount?: number;
}

function IconButton({
  label,
  onPress,
  children,
  badge,
}: {
  label: string;
  onPress?: () => void;
  children: React.ReactNode;
  badge?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
    >
      {children}
      {badge ? <View style={s.badgeDot} /> : null}
    </Pressable>
  );
}

export function MapHeader({
  city,
  area,
  topInset = 0,
  onMenuPress,
  onCityPress,
  onSearchPress,
  onLayersPress,
  customisedLayerCount = 0,
}: MapHeaderProps) {
  const hasCity = typeof city === 'string' && city.trim() !== '';
  const cityLabel = hasCity ? (city as string).trim() : CITY_PLACEHOLDER_LABEL;
  const areaLabel =
    typeof area === 'string' && area.trim() !== '' && area.trim() !== cityLabel
      ? area.trim()
      : null;

  return (
    <View style={[s.container, { top: topInset }]} pointerEvents="box-none">
      <View style={s.bar}>
        {/* ☰ Menu */}
        <IconButton label="Open menu" onPress={onMenuPress}>
          <Menu size={icon.s20} color={mapChrome.textOnDark} />
        </IconButton>

        {/* Current city / area selector */}
        <Pressable
          onPress={onCityPress}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={
            hasCity ? `Current area: ${cityLabel}. Change city or area` : 'Choose a city or area'
          }
          style={({ pressed }) => [s.citySelector, pressed && s.pressed]}
        >
          <View style={s.cityText}>
            <Text
              style={[s.cityName, !hasCity && s.cityNamePlaceholder]}
              numberOfLines={1}
            >
              {cityLabel}
            </Text>
            {areaLabel ? (
              <Text style={s.areaName} numberOfLines={1}>
                {areaLabel}
              </Text>
            ) : null}
          </View>
          <ChevronDown size={icon.s16} color={mapChrome.textOnDarkMute} />
        </Pressable>

        {/* Search */}
        <IconButton label="Search the map" onPress={onSearchPress}>
          <Search size={icon.s20} color={mapChrome.textOnDark} />
        </IconButton>

        {/* Layers */}
        <IconButton
          label="Layers and legend"
          onPress={onLayersPress}
          badge={customisedLayerCount > 0}
        >
          <Layers size={icon.s20} color={mapChrome.textOnDark} />
        </IconButton>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    // Above MapTopControls (20) so the controls hang beneath the header
    // rather than over it.
    zIndex: 30,
  },
  bar: {
    height: MAP_HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: mapChrome.surfaceTranslucent,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairlineStrong,
    paddingHorizontal: space.xs,
    gap: space.xs,
  },
  iconBtn: {
    // 44 is the HIG minimum touch target — deliberately not an `icon` token,
    // which sizes glyphs (14-26), not touch targets.
    minWidth: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  pressed: {
    backgroundColor: mapChrome.surfaceInset,
  },
  citySelector: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    minHeight: 44,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  cityText: {
    flexShrink: 1,
  },
  cityName: {
    ...t.bodyStrong,
    fontSize: 15,
    color: mapChrome.textOnDark,
    textAlign: 'center',
  },
  cityNamePlaceholder: {
    color: mapChrome.textOnDarkFaint,
    fontWeight: '600',
  },
  areaName: {
    ...t.stamp,
    color: mapChrome.textOnDarkMute,
    textAlign: 'center',
    marginTop: 1,
  },
  badgeDot: {
    position: 'absolute',
    top: 9,
    right: 10,
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
    backgroundColor: mapChrome.signal,
  },
});
