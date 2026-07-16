import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { RelationshipLabel } from '../../hooks/useRelationshipLabel.ts';
import { color, radius } from '../../theme/tokens.ts';

const CONFIG: Record<RelationshipLabel, { label: string; bg: string; text: string } | null> = {
  blocked_by_you: { label: 'Blocked', bg: '#FEE2E2', text: '#DC2626' },
  blocked_you: { label: 'Blocked you', bg: '#FEE2E2', text: '#DC2626' },
  mutual: { label: 'Mutual', bg: color.signal + '20', text: color.signal },
  following: { label: 'Following', bg: color.deep + '20', text: color.deep },
  follower: { label: 'Follows you', bg: color.haze, text: color.mute },
  friend: { label: 'Friend', bg: '#F0FFF4', text: '#16A34A' },
  restricted: { label: 'Restricted', bg: '#FEF9C3', text: '#92400E' },
  muted: { label: 'Muted', bg: color.haze, text: color.mute },
  none: null,
};

interface Props {
  label: RelationshipLabel;
}

export function RelationshipBadge({ label }: Props) {
  const cfg = CONFIG[label];
  if (!cfg) return null;
  return (
    <View style={[s.badge, { backgroundColor: cfg.bg }]}>
      <Text style={[s.text, { color: cfg.text }]}>{cfg.label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  text: { fontSize: 11, fontWeight: '600' },
});
