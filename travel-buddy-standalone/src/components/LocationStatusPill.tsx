/**
 * LocationStatusPill — compact pill showing the active city.
 *
 * Tapping opens the ManualCityPicker (or requests GPS if no city yet).
 * Used in Pulse header and wherever the current city context is shown.
 */
import React from 'react';
import { Pressable, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { MapPin, ChevronDown } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { useLocationContext } from '../context/LocationContext.tsx';

interface Props {
  fallbackLabel?: string;
  compact?: boolean;
}

export function LocationStatusPill({ fallbackLabel = 'Choose city', compact = false }: Props) {
  const { locationState, isLoading, openCityPicker, requireLocation } = useLocationContext();

  const city = locationState.place.city;
  const label = city ?? fallbackLabel;
  const hasCity = !!city;

  function handlePress() {
    if (!hasCity) {
      requireLocation('pulse');
    } else {
      openCityPicker();
    }
  }

  return (
    <Pressable
      style={({ pressed }) => [s.pill, compact && s.compact, pressed && s.pressed]}
      onPress={handlePress}
      hitSlop={8}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color={color.signal} />
      ) : (
        <MapPin size={compact ? 11 : 13} color={hasCity ? color.signal : color.mute} />
      )}
      <Text
        style={[s.label, compact && s.labelCompact, !hasCity && s.labelFaint]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronDown size={compact ? 11 : 13} color={color.mute} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    maxWidth: 160,
  },
  compact: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  pressed: {
    opacity: 0.75,
  },
  label: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
    flex: 1,
  },
  labelCompact: {
    fontSize: 12,
  },
  labelFaint: {
    color: color.mute,
    fontWeight: '400',
  },
});
