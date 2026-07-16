import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Users, PlaneTakeoff } from 'lucide-react-native';
import type { SharedContext } from '../../services/interactionContext.ts';
import { color } from '../../theme/tokens.ts';

interface Props {
  context: SharedContext;
}

export function KnownFromRow({ context }: Props) {
  const items: { icon: React.ReactNode; label: string }[] = [];
  if (context.sharedTrip) {
    items.push({ icon: <PlaneTakeoff size={12} color={color.signal} />, label: 'Shared trip' });
  }
  if (context.sharedCircle) {
    items.push({ icon: <Users size={12} color={color.deep} />, label: 'In your circle' });
  }
  if (!items.length) return null;
  return (
    <View style={s.row}>
      {items.map((item, i) => (
        <View key={i} style={s.chip}>
          {item.icon}
          <Text style={s.label}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: color.haze, borderRadius: 12,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  label: { fontSize: 11, color: color.mute },
});
