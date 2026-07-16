/**
 * LocationChip — reusable location label component.
 *
 * Variants:
 *   current_city      — "Cebu City"
 *   neighborhood      — "Lahug, Cebu City"
 *   near_me           — "Near me"
 *   trip_city         — "Going to Tokyo"
 *   approx_distance   — "~3 km"
 *   location_hidden   — "Location hidden"
 *   exact_private     — "Exact location private"
 *   no_location       — (renders nothing)
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin, Navigation, EyeOff, Lock } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';

export type LocationChipVariant =
  | 'current_city'
  | 'neighborhood'
  | 'near_me'
  | 'trip_city'
  | 'approx_distance'
  | 'location_hidden'
  | 'exact_private'
  | 'no_location';

export interface LocationChipProps {
  variant: LocationChipVariant;
  /** Primary label text (city name, distance string, etc.) */
  label?: string;
  /** Secondary label (district for neighborhood variant) */
  sublabel?: string;
  /** Chip size */
  size?: 'sm' | 'md';
  /** Muted style for secondary contexts */
  muted?: boolean;
}

export function LocationChip({
  variant,
  label,
  sublabel,
  size = 'sm',
  muted = false,
}: LocationChipProps) {
  if (variant === 'no_location') return null;

  const isSm = size === 'sm';
  const iconSize = isSm ? 11 : 13;
  const fontSize = isSm ? 11 : 12;

  const { Icon, text, iconColor, textColor } = resolveAppearance(variant, label, sublabel, muted);

  return (
    <View style={[styles.chip, isSm ? styles.chipSm : styles.chipMd]}>
      <Icon size={iconSize} color={iconColor} />
      <Text style={[styles.label, { fontSize, color: textColor }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

// ── Appearance resolver ───────────────────────────────────────────────────────

function resolveAppearance(
  variant: LocationChipVariant,
  label?: string,
  sublabel?: string,
  muted?: boolean,
) {
  const muteColor = muted ? color.faint : color.mute;

  switch (variant) {
    case 'current_city':
      return {
        Icon: MapPin,
        text: label ?? 'Unknown city',
        iconColor: muted ? color.faint : color.signal,
        textColor: muted ? color.faint : color.mute,
      };

    case 'neighborhood':
      return {
        Icon: MapPin,
        text: sublabel && label ? `${sublabel}, ${label}` : (label ?? sublabel ?? 'Neighborhood'),
        iconColor: muted ? color.faint : color.deep,
        textColor: muted ? color.faint : color.mute,
      };

    case 'near_me':
      return {
        Icon: Navigation,
        text: 'Near me',
        iconColor: muted ? color.faint : color.signal,
        textColor: muted ? color.faint : color.mute,
      };

    case 'trip_city':
      return {
        Icon: MapPin,
        text: label ? `Going to ${label}` : 'Trip destination',
        iconColor: muted ? color.faint : color.deep,
        textColor: muted ? color.faint : color.mute,
      };

    case 'approx_distance':
      return {
        Icon: Navigation,
        text: label ?? 'Nearby',
        iconColor: muteColor,
        textColor: muteColor,
      };

    case 'location_hidden':
      return {
        Icon: EyeOff,
        text: 'Location hidden',
        iconColor: color.faint,
        textColor: color.faint,
      };

    case 'exact_private':
      return {
        Icon: Lock,
        text: 'Exact location private',
        iconColor: color.faint,
        textColor: color.faint,
      };

    default:
      return {
        Icon: MapPin,
        text: label ?? '',
        iconColor: muteColor,
        textColor: muteColor,
      };
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  chipSm: {
    paddingVertical: 0,
  },
  chipMd: {
    paddingVertical: 2,
  },
  label: {
    fontFamily: 'Courier',
    letterSpacing: 0.2,
    flexShrink: 1,
  },
});
