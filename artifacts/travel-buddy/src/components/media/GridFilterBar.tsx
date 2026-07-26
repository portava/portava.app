/**
 * GridFilterBar — horizontal scrollable chip row for the Grid feed.
 *
 * Chips: All · Videos · Photos · Following · Saved · Nearby
 *
 * Behaviour:
 *   - Tapping a chip calls onFilterChange and resets the feed cursor.
 *   - The Nearby chip is hidden when location permission has not been granted
 *     (checked via expo-location on mount).
 *   - The whole bar is hidden when MEDIA_VIEW_MODE_GRID_ENABLED is false
 *     (the parent GridFeed handles that gate, but the chip is still listed here
 *     in case a tighter per-chip gate is needed later).
 *
 * Does not fetch data — it is a pure controlled component.
 */

import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { MapPin } from 'lucide-react-native';
import type { GridFilter } from '../../types/media.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

// ── Chip definitions ──────────────────────────────────────────────────────────

interface ChipDef {
  key: GridFilter;
  label: string;
  /** When true the chip is only shown after a runtime check passes. */
  requiresLocationPermission?: boolean;
}

const ALL_CHIPS: ChipDef[] = [
  { key: 'all',       label: 'All' },
  { key: 'videos',    label: 'Videos' },
  { key: 'photos',    label: 'Photos' },
  { key: 'following', label: 'Following' },
  { key: 'saved',     label: 'Saved' },
  { key: 'nearby',    label: 'Nearby', requiresLocationPermission: true },
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GridFilterBarProps {
  selectedFilter: GridFilter;
  /**
   * Called when the user selects a chip.
   * For filter=nearby the caller also receives the viewer's current coordinates
   * so it can forward them to the API. Coordinates are omitted for all other
   * filters and when the position fetch fails (callers should fall back to
   * showing all public posts).
   */
  onFilterChange: (filter: GridFilter, coords?: { lat: number; lng: number }) => void;
}

// ── Hook: location permission ─────────────────────────────────────────────────

/**
 * Returns true once the viewer has granted foreground location permission.
 * Falls back to false on any error or on platforms where the API is unavailable.
 */
function useLocationPermissionGranted(): boolean {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Lazy import so the module is never loaded if unused at import time.
        const Location = await import('expo-location');
        const { status } = await Location.getForegroundPermissionsAsync();
        if (!cancelled) setGranted(status === 'granted');
      } catch {
        // expo-location unavailable or permission API not ready — leave false.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return granted;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GridFilterBar({ selectedFilter, onFilterChange }: GridFilterBarProps) {
  const locationGranted = useLocationPermissionGranted();

  const visibleChips = ALL_CHIPS.filter(
    (c) => !c.requiresLocationPermission || locationGranted,
  );

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {visibleChips.map((chip) => {
          const active = selectedFilter === chip.key;

          const handlePress = async () => {
            if (chip.key === 'nearby') {
              try {
                const Location = await import('expo-location');
                const pos = await Location.getCurrentPositionAsync({
                  accuracy: Location.Accuracy.Balanced,
                });
                onFilterChange('nearby', {
                  lat: pos.coords.latitude,
                  lng: pos.coords.longitude,
                });
              } catch {
                // Position unavailable — fall back to server-side all-public behaviour.
                onFilterChange('nearby');
              }
            } else {
              onFilterChange(chip.key);
            }
          };

          return (
            <Pressable
              key={chip.key}
              style={[styles.chip, active && styles.chipActive]}
              onPress={handlePress}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={chip.label}
            >
              {chip.key === 'nearby' && (
                <MapPin
                  size={11}
                  color={active ? color.paper : color.mute}
                  strokeWidth={2.5}
                />
              )}
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: color.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  chipActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  chipText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  chipTextActive: {
    color: color.onInk,
  },
});
