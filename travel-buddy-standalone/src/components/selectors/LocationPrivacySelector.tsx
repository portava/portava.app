/**
 * LocationPrivacySelector — inline chip row for choosing location visibility.
 *
 * Options: Hidden / City only / Neighborhood / Exact place
 * Default: City only
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Eye, EyeOff, MapPin, Navigation } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import type { LocationPrivacy } from '../../lib/location/placeTypes';

interface Option {
  value: LocationPrivacy;
  label: string;
  sub: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
}

const OPTIONS: Option[] = [
  { value: 'hidden', label: 'Hidden', sub: 'No location', Icon: EyeOff },
  { value: 'city', label: 'City', sub: 'City only', Icon: MapPin },
  { value: 'neighborhood', label: 'Area', sub: 'Neighborhood', Icon: MapPin },
  { value: 'exact', label: 'Exact', sub: 'Full place', Icon: Navigation },
];

interface Props {
  value: LocationPrivacy;
  onChange: (v: LocationPrivacy) => void;
  label?: string;
}

export function LocationPrivacySelector({ value, onChange, label }: Props) {
  return (
    <View>
      {label && <Text style={s.label}>{label}</Text>}
      <View style={s.row}>
        {OPTIONS.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              style={[s.chip, selected && s.chipSelected]}
              onPress={() => onChange(opt.value)}
            >
              <opt.Icon size={12} color={selected ? color.signal : color.mute} />
              <Text style={[s.chipText, selected && s.chipTextSelected]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm, fontSize: 11 },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipSelected: { borderColor: color.signal, backgroundColor: `${color.signal}15` },
  chipText: { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextSelected: { color: color.signal },
});
