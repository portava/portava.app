/**
 * PlaceQuickActions — compact 3-chip row for any surface that has a tagged place.
 *
 * Chips:
 *   + Trip     → PlanPickerController (existing trip-plan flow)
 *   + Event    → AddToEventSheet (pick from user's upcoming events)
 *   Navigate   → openMapsNavigation (Apple/Google Maps deep-link)
 *
 * Variants:
 *   'dark'  (default) — white text on semi-transparent dark background; use on
 *            full-screen overlays (Watch, Gems, MediaViewer).
 *   'light' — dark text/border on white/light card backgrounds.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Navigation, Calendar, Plus } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../theme/tokens.ts';
import { usePlanPicker } from './PlanPickerController.tsx';
import { AddToEventSheet } from './AddToEventSheet.tsx';
import { openMapsNavigation, type MapsPlace } from '../lib/maps.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuickActionsPlace extends MapsPlace {
  /** Canonical place ID — used as the PlanPicker sourceId (falls back to sourceId prop). */
  id?: string;
}

export interface PlaceQuickActionsProps {
  place: QuickActionsPlace;
  /**
   * ID used for PlanPicker / AddToEventSheet when place.id is absent.
   * Typically the post / item ID.
   */
  sourceId?: string;
  /**
   * 'dark'  — white chips on semi-transparent dark bg (overlay surfaces)
   * 'light' — dark chips on light card bg
   */
  variant?: 'dark' | 'light';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlaceQuickActions({
  place,
  sourceId,
  variant = 'dark',
}: PlaceQuickActionsProps) {
  const { open: openPlanPicker } = usePlanPicker();
  const [eventSheetOpen, setEventSheetOpen] = useState(false);

  const resolvedSourceId = place.id ?? sourceId ?? '';

  const handleAddToTrip = useCallback(() => {
    const locationParts = [place.name, place.city].filter(Boolean);
    openPlanPicker({
      id: resolvedSourceId,
      type: 'place',
      title: place.name,
      city: place.city ?? undefined,
      locationName: locationParts.join(', ') || undefined,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
    });
  }, [place, resolvedSourceId, openPlanPicker]);

  const handleNavigate = useCallback(() => {
    openMapsNavigation(place);
  }, [place]);

  const chipStyle = variant === 'light' ? s.chipLight : s.chipDark;
  const chipTextStyle = variant === 'light' ? s.chipTextLight : s.chipTextDark;

  return (
    <>
      <View style={s.row}>
        {/* + Trip */}
        <Pressable
          style={({ pressed }) => [chipStyle, pressed && s.pressed]}
          onPress={handleAddToTrip}
          accessibilityRole="button"
          accessibilityLabel="Add to trip"
          hitSlop={layout.hitSlop}
        >
          <Plus size={11} color={variant === 'light' ? color.signal : 'rgba(255,255,255,0.9)'} strokeWidth={2.5} />
          <Text style={[chipTextStyle, variant === 'light' && { color: color.signal }]}>
            Trip
          </Text>
        </Pressable>

        {/* + Event */}
        <Pressable
          style={({ pressed }) => [chipStyle, pressed && s.pressed]}
          onPress={() => setEventSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Add to event"
          hitSlop={layout.hitSlop}
        >
          <Calendar size={11} color={variant === 'light' ? color.signal : 'rgba(255,255,255,0.9)'} strokeWidth={2} />
          <Text style={[chipTextStyle, variant === 'light' && { color: color.signal }]}>
            Event
          </Text>
        </Pressable>

        {/* Navigate */}
        <Pressable
          style={({ pressed }) => [chipStyle, pressed && s.pressed]}
          onPress={handleNavigate}
          accessibilityRole="button"
          accessibilityLabel="Navigate to this place"
          hitSlop={layout.hitSlop}
        >
          <Navigation size={11} color={variant === 'light' ? color.deep : 'rgba(255,255,255,0.9)'} strokeWidth={2} />
          <Text style={[chipTextStyle, variant === 'light' && { color: color.deep }]}>
            Navigate
          </Text>
        </Pressable>
      </View>

      {eventSheetOpen && (
        <AddToEventSheet
          visible={eventSheetOpen}
          place={place}
          onClose={() => setEventSheetOpen(false)}
        />
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const chipBase = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 4,
  paddingHorizontal: 9,
  paddingVertical: 5,
  borderRadius: radius.pill,
};

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  chipDark: {
    ...chipBase,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  chipLight: {
    ...chipBase,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  chipTextDark: {
    ...t.stamp,
    color: 'rgba(255,255,255,0.92)',
    fontWeight: '700',
    fontSize: 11,
  },
  chipTextLight: {
    ...t.stamp,
    color: color.ink,
    fontWeight: '700',
    fontSize: 11,
  },
  pressed: {
    opacity: 0.68,
  },
});
