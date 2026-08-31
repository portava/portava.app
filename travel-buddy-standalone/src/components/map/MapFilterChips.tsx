/**
 * MapFilterChips — the §3 Live Map / Map Home filter chip row.
 *
 * §3, verbatim: "Filter chips: For You, Live, People, Events, Gems."
 *
 * A horizontally scrollable row of five single-select chips with badge counts,
 * sitting under MapHeader and over the map canvas.
 *
 * EVERY DECISION LIVES IN features/map/home/homeFilters.ts
 * =======================================================
 * The chip list, their order, their labels, their counts, their empty states
 * and — critically — the rule that a chip FILTERS the already-layer-filtered
 * set rather than widening it, are all in the pure module. This file renders
 * them. It does not define a sixth chip, does not compute a count, does not
 * decide what "Live" means, and never touches `LayerPreferences`.
 *
 * That is why the component takes `counts` rather than the objects: the screen
 * calls `homeChipCounts(projection, layerPrefs, layerContext)` once, which runs
 * layers-then-chip in the correct order, and hands the answer down. A component
 * that took the raw projection could compute a count that disagreed with the
 * map, and a component that took `LayerPreferences` could be tempted to change
 * them.
 *
 * SINGLE-SELECT
 * =============
 * `active` is one `HomeFilterId`, never a set — see the homeFilters header for
 * why the five chips do not compose. Tapping the active chip is a no-op rather
 * than a deselect: §3 makes Map Home "the default map state", and a state with
 * no lens at all is not one of the five.
 *
 * COMPACT, BECAUSE §3 SAYS THE CANVAS WINS
 * ========================================
 * "Map canvas dominates the screen; cards should not permanently consume half
 * the viewport." The row is 36pt of chrome with a transparent background — the
 * chips themselves are the only painted surface, so most of this strip is still
 * map. Touch targets stay at 44pt via hitSlop rather than by growing the row.
 *
 * Dark-mode-first (§4): colours come from theme/mapChrome.ts, the shared map
 * palette, so the chips restyle with the header and the sheets rather than
 * drifting into their own near-identical greys.
 *
 * Selection is an INVERSION — light pill, dark text — not a brand-coloured
 * pill, because §4 reserves bright saturated colour for "Portava overlays above
 * geography". A vermilion chip would compete with the live-activity accent it
 * is meant to be a control for. That inversion is also why the active chip's
 * badge is the one hardcoded colour in this file (see `badgeActive`).
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { radius, space, type as t } from '../../theme/tokens.ts';
import { mapChrome } from '../../theme/mapChrome.ts';
import {
  HOME_FILTERS,
  type HomeFilterId,
} from '../../features/map/home/homeFilters.ts';

/** The row's own height, so the screen can stack whatever floats beneath it. */
export const MAP_FILTER_CHIPS_HEIGHT = 36;

export interface MapFilterChipsProps {
  /** The one active chip. Single-select by construction. */
  active: HomeFilterId;
  /**
   * Badge counts, keyed by chip. Produced by
   * `homeChipCounts(objects, layerPrefs, layerContext)` so they already obey
   * the §16 layers and can never disagree with what the map draws.
   *
   * A missing entry renders no badge, which is the honest state before the
   * first projection arrives — a "0" would assert that there is nothing here,
   * which is a different claim from "we have not looked yet".
   */
  counts?: Partial<Record<HomeFilterId, number>>;
  /** Tapping a chip. Tapping the already-active chip does not fire. */
  onSelect?: (filter: HomeFilterId) => void;
  /** Top offset, normally `mapHeaderStackOffset(insets.top)`. */
  topInset?: number;
  /**
   * True while the projection is in flight. Suppresses badges (see `counts`)
   * without collapsing the row, so the chips do not jump when data lands.
   */
  loading?: boolean;
}

function Chip({
  label,
  hint,
  count,
  isActive,
  onPress,
}: {
  label: string;
  hint: string;
  count: number | null;
  isActive: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={count == null ? label : `${label}, ${count}`}
      accessibilityHint={hint}
      style={({ pressed }) => [
        s.chip,
        isActive && s.chipActive,
        pressed && !isActive && s.chipPressed,
      ]}
    >
      <Text style={[s.chipLabel, isActive && s.chipLabelActive]} numberOfLines={1}>
        {label}
      </Text>
      {count != null ? (
        <View style={[s.badge, isActive && s.badgeActive]}>
          <Text style={[s.badgeText, isActive && s.badgeTextActive]} numberOfLines={1}>
            {count > 99 ? '99+' : String(count)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function MapFilterChips({
  active,
  counts,
  onSelect,
  topInset = 0,
  loading = false,
}: MapFilterChipsProps) {
  return (
    <View style={[s.container, { top: topInset }]} pointerEvents="box-none">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.row}
        keyboardShouldPersistTaps="handled"
      >
        {HOME_FILTERS.map((meta) => {
          const raw = counts?.[meta.id];
          const count = loading || typeof raw !== 'number' ? null : raw;
          return (
            <Chip
              key={meta.id}
              label={meta.label}
              hint={meta.description}
              count={count}
              isActive={meta.id === active}
              onPress={() => {
                // Single-select: re-tapping the active chip is a no-op, not a
                // deselect. There is no "no lens" state on Map Home.
                if (meta.id === active) return;
                onSelect?.(meta.id);
              }}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: MAP_FILTER_CHIPS_HEIGHT,
    // Between MapHeader (30) and MapTopControls (20): the chips belong to the
    // header cluster, but the header itself must win any overlap.
    zIndex: 25,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    height: MAP_FILTER_CHIPS_HEIGHT - 4,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: mapChrome.surfaceTranslucent,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairlineStrong,
  },
  chipPressed: {
    borderColor: mapChrome.textOnDarkMute,
  },
  chipActive: {
    backgroundColor: mapChrome.textOnDark,
    borderColor: mapChrome.textOnDark,
  },
  chipLabel: {
    ...t.small,
    fontWeight: '600',
    color: mapChrome.textOnDark,
  },
  chipLabelActive: {
    color: mapChrome.surface,
    fontWeight: '700',
  },
  badge: {
    minWidth: 20,
    paddingHorizontal: space.xs,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: mapChrome.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeActive: {
    // The active chip inverts to a light fill, so its badge needs a DARK
    // translucent well. Every `hairline*` token in mapChrome is white-on-dark
    // and would vanish here — this is the one value the shared palette has no
    // token for, because nothing else in the map chrome inverts.
    backgroundColor: 'rgba(14,18,22,0.12)',
  },
  badgeText: {
    ...t.stamp,
    color: mapChrome.textOnDarkMute,
  },
  badgeTextActive: {
    color: mapChrome.surface,
  },
});
