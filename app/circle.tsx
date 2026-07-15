import React, { useState } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { Chip, Stamp } from '../src/components/ui';
import { usePassport } from '../src/hooks/usePassport';
import { color, space, radius, type as t } from '../src/theme/tokens';

/** Circle page — Travel Circle (buddies) + Met Travelers (crossed paths). */
export default function Circle() {
  const { data } = usePassport();
  const [tab, setTab] = useState<'circle' | 'met'>('circle');
  const buddies = data?.buddies ?? [];
  const met = [...buddies].reverse();
  const list = tab === 'circle' ? buddies : met;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Circle" back />
      <View style={styles.tabBar}>
        <Pressable style={[styles.tab, tab === 'circle' && styles.tabActive]} onPress={() => setTab('circle')}>
          <Text style={[styles.tabText, tab === 'circle' && styles.tabTextActive]}>Travel Circle</Text>
        </Pressable>
        <Pressable style={[styles.tab, tab === 'met' && styles.tabActive]} onPress={() => setTab('met')}>
          <Text style={[styles.tabText, tab === 'met' && styles.tabTextActive]}>Met Travelers</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Text style={styles.note}>
          {tab === 'circle' ? 'Buddies you’re connected with.' : 'Travelers you’ve crossed paths with.'}
        </Text>
        {list.map((u) => (
          <Pressable key={u.id} style={styles.row} onPress={() => router.push(`/profile/${u.handle}`)}>
            <Image source={{ uri: u.avatarUrl }} style={styles.avatar} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{u.name}{u.verified ? ' ✓' : ''}</Text>
              <Text style={styles.meta}>{u.homeCity} → {u.currentCity ?? '—'}</Text>
            </View>
            {u.openToMeet && <Stamp label="open to meet" tone="signal" />}
          </Pressable>
        ))}
        {list.length === 0 && <Text style={styles.note}>No one here yet.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: { flexDirection: 'row', gap: space.sm, margin: space.lg, marginBottom: 0, padding: 4, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.bodyStrong, color: color.mute, fontSize: 13 },
  tabTextActive: { color: color.onInk },
  note: { ...t.small, color: color.mute },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.haze },
  name: { ...t.bodyStrong, color: color.ink },
  meta: { ...t.small, color: color.mute, marginTop: 2 },
});
