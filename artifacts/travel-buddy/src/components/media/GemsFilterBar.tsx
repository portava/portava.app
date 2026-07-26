/**
 * GemsFilterBar — area mode + category filter bar for the Gems feed.
 *
 * Top row: area chips — Near Me · This City · My Trip · All
 * Bottom row: scrollable category chips
 *
 * Feature flag behaviour:
 *   - nearMeEnabled=false  → Near Me chip is hidden
 *   - Requesting Near Me for the first time triggers location permission prompt
 *     via the onRequestNearMe callback (caller handles the permission flow).
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { GeoAreaMode, GemCategory } from '../../stores/mediaStore.ts';

// ── Area mode ─────────────────────────────────────────────────────────────────

interface AreaChip {
  key: GeoAreaMode;
  label: string;
}

const AREA_CHIPS: AreaChip[] = [
  { key: 'near_me',   label: 'Near Me'   },
  { key: 'this_city', label: 'This City' },
  { key: 'my_trip',   label: 'My Trip'   },
  { key: 'all',       label: 'All'       },
];

// ── Category chips ────────────────────────────────────────────────────────────

interface CategoryChip {
  key: GemCategory;
  label: string;
}

const CATEGORY_CHIPS: CategoryChip[] = [
  { key: 'food',       label: '🍜 Food'       },
  { key: 'nightlife',  label: '🍸 Nightlife'  },
  { key: 'nature',     label: '🌿 Nature'     },
  { key: 'beaches',    label: '🏖 Beaches'    },
  { key: 'waterfalls', label: '💧 Waterfalls' },
  { key: 'views',      label: '🌅 Views'      },
  { key: 'culture',    label: '🏛 Culture'    },
  { key: 'shopping',   label: '🛍 Shopping'   },
  { key: 'wellness',   label: '🧘 Wellness'   },
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GemsFilterBarProps {
  areaMode: GeoAreaMode;
  category: GemCategory | null;
  onAreaModeChange: (mode: GeoAreaMode) => void;
  onCategoryChange: (cat: GemCategory | null) => void;
  /**
   * When false, the Near Me chip is hidden entirely.
   * Driven by MEDIA_HIDDEN_GEMS_NEARBY_ENABLED feature flag.
   */
  nearMeEnabled?: boolean;
  /**
   * Called when the user taps Near Me for the first time (or when no location
   * permission has been granted yet). The parent should trigger the permission
   * flow and, on success, update its own location state.
   */
  onRequestNearMe?: () => void;
  /** True while location is being resolved (shows an inline spinner on the chip). */
  nearMeLoading?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GemsFilterBar({
  areaMode,
  category,
  onAreaModeChange,
  onCategoryChange,
  nearMeEnabled = true,
  onRequestNearMe,
  nearMeLoading = false,
}: GemsFilterBarProps) {
  const visibleAreaChips = nearMeEnabled
    ? AREA_CHIPS
    : AREA_CHIPS.filter((c) => c.key !== 'near_me');

  const handleAreaPress = useCallback((key: GeoAreaMode) => {
    if (key === 'near_me' && onRequestNearMe) {
      onRequestNearMe();
    }
    onAreaModeChange(key);
  }, [onAreaModeChange, onRequestNearMe]);

  const handleCategoryPress = useCallback((key: GemCategory) => {
    onCategoryChange(category === key ? null : key);
  }, [category, onCategoryChange]);

  return (
    <View style={styles.root}>
      {/* Area mode chips */}
      <View style={styles.areaRow}>
        {visibleAreaChips.map(({ key, label }) => {
          const active = key === areaMode;
          const showSpinner = key === 'near_me' && nearMeLoading;
          return (
            <Pressable
              key={key}
              style={({ pressed }) => [
                styles.areaChip,
                active && styles.areaChipActive,
                pressed && styles.chipPressed,
              ]}
              onPress={() => handleAreaPress(key)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
            >
              {showSpinner ? (
                <ActivityIndicator size="small" color={color.onInk} style={styles.chipSpinner} />
              ) : null}
              <Text style={[styles.areaChipLabel, active && styles.areaChipLabelActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Category chips — horizontal scroll */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.categoryRow}
        keyboardShouldPersistTaps="handled"
      >
        {CATEGORY_CHIPS.map(({ key, label }) => {
          const active = key === category;
          return (
            <Pressable
              key={key}
              style={({ pressed }) => [
                styles.catChip,
                active && styles.catChipActive,
                pressed && styles.chipPressed,
              ]}
              onPress={() => handleCategoryPress(key)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.catChipLabel, active && styles.catChipLabelActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CHIP_HEIGHT = 34;

const styles = StyleSheet.create({
  root: {
    gap: space.sm,
    paddingTop: space.sm,
  },
  areaRow: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.lg,
    flexWrap: 'wrap',
  },
  areaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    height: CHIP_HEIGHT,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  areaChipActive: {
    backgroundColor: color.onInk,
    borderColor: color.onInk,
  },
  areaChipLabel: {
    ...t.stamp,
    color: color.onInkMute,
  },
  areaChipLabelActive: {
    color: color.ink,
    fontWeight: '700',
  },
  categoryRow: {
    paddingHorizontal: space.lg,
    gap: space.xs,
    flexDirection: 'row',
    alignItems: 'center',
  },
  catChip: {
    height: CHIP_HEIGHT,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  catChipActive: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  catChipLabel: {
    ...t.small,
    color: color.onInkMute,
  },
  catChipLabelActive: {
    color: color.onInk,
    fontWeight: '700',
  },
  chipPressed: {
    opacity: 0.72,
  },
  chipSpinner: {
    marginRight: space.xs,
  },
});
