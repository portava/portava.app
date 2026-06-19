import React from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { userByHandle } from '../../src/data/cebu';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function Profile() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const u = userByHandle(handle);
  if (!u) return <View style={{ flex: 1, backgroundColor: color.paper }}><ScreenHeader title="Profile" back /></View>;
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title={`@${u.handle}`} back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Image source={{ uri: u.avatarUrl }} style={styles.avatar} />
        <Text style={styles.name}>{u.name}{u.verified ? ' ✓' : ''}</Text>
        <Text style={styles.meta}>{u.homeCity}, {u.homeCountry}{u.currentCity ? ` · now in ${u.currentCity}` : ''}</Text>
        {u.bio && <Text style={styles.bio}>{u.bio}</Text>}
        <View style={styles.stampRow}>
          {u.openToMeet && <Stamp label="open to meet" tone="signal" />}
          <Stamp label={u.travelStyle} tone="deep" rotate={2} />
          {u.interests.slice(0,3).map((i) => <Stamp key={i} label={i} rotate={-2} />)}
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.follow}><Text style={styles.followText}>Follow</Text></Pressable>
          <Pressable style={styles.msg}><Text style={styles.msgText}>Message</Text></Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: color.haze },
  name: { ...t.title, color: color.ink },
  meta: { ...t.small, color: color.mute },
  bio: { ...t.body, color: color.ink },
  stampRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  follow: { flex: 1, backgroundColor: color.ink, paddingVertical: space.md, borderRadius: radius.pill, alignItems: 'center' },
  followText: { ...t.small, fontWeight: '700', color: color.onInk },
  msg: { flex: 1, borderWidth: 1, borderColor: color.haze, paddingVertical: space.md, borderRadius: radius.pill, alignItems: 'center' },
  msgText: { ...t.small, fontWeight: '700', color: color.ink },
});
