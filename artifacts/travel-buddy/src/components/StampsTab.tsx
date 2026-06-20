import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';
import type { PassportStamp } from '../types/models';
import { StampBadge } from './PassportStamps';
import { color, space, radius, type as t } from '../theme/tokens';

/** Shows only GPS-verified stamps (location_verified + stamp_eligible). */
export function StampsTab({ stamps }: { stamps: PassportStamp[] }) {
  const verified = stamps.filter((s) => !s.locked);

  if (verified.length === 0) {
    return (
      <View style={st.empty}>
        <Text style={st.emptyIcon}>🔖</Text>
        <Text style={st.emptyTitle}>No verified stamps yet</Text>
        <Text style={st.emptySub}>GPS-verified posts can earn stamps when you check in at your tagged location.</Text>
      </View>
    );
  }

  return (
    <View style={st.wrap}>
      <View style={st.grid}>
        {verified.map((s, i) => (
          <View key={s.id} style={st.cell}>
            <StampBadge stamp={s} size={80} rotate={((i % 3) - 1) * 4} onPress={() => router.push('/stamps')} />
          </View>
        ))}
      </View>
      <Pressable style={st.viewAll} onPress={() => router.push('/stamps')}>
        <Text style={st.viewAllText}>View full stamp collection</Text>
      </Pressable>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, justifyContent: 'flex-start' },
  cell: { alignItems: 'center' },
  viewAll: { marginTop: space.xl, alignItems: 'center', borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.md },
  viewAllText: { ...t.bodyStrong, color: color.ink },
  empty: { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center' },
});
