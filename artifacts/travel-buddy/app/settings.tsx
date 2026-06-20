import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Switch, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Zap } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { useSession } from '../src/context/SessionContext';
import { color, space, type as t, radius, layout } from '../src/theme/tokens';
import { updateTelegraphChatSettings } from '../src/services/telegraphChat';

export default function Settings() {
  const { signOut, isAuthed, configured } = useSession();

  const [telegraphDM, setTelegraphDM] = useState(true);
  const [telegraphTrip, setTelegraphTrip] = useState(true);
  const [telegraphCircle, setTelegraphCircle] = useState(true);

  async function onItem(label: string) {
    if (label === 'Log out') {
      await signOut();
      router.replace('/(auth)/sign-in');
    }
  }

  async function handleTelegraphToggle(
    key: 'show_telegraph_dm' | 'show_telegraph_trip' | 'show_telegraph_circle',
    value: boolean,
  ) {
    if (key === 'show_telegraph_dm') setTelegraphDM(value);
    if (key === 'show_telegraph_trip') setTelegraphTrip(value);
    if (key === 'show_telegraph_circle') setTelegraphCircle(value);
    await updateTelegraphChatSettings({ [key]: value }).catch(() => {});
  }

  const BASIC_GROUPS = [
    { h: 'Privacy', items: ['Hide current location', 'Hide upcoming trips', 'Private account', 'Nearby visibility', 'Message permissions'] },
    { h: 'Safety', items: ['Blocked accounts', 'Report history', 'Muted words'] },
    { h: 'Account', items: ['Edit profile', 'Notifications', 'Log out'] },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Settings" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: space.xxxl }}>

        {/* Telegraph suggestions section */}
        <View style={{ gap: space.sm }}>
          <View style={styles.sectionHeader}>
            <Zap size={13} color={color.signal} fill={color.signal} />
            <Text style={styles.h}>Telegraph</Text>
          </View>
          <Text style={styles.sectionDesc}>
            Smart suggestions appear above the composer when Telegraph detects travel planning in your chats.
          </Text>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Direct messages</Text>
              <Text style={styles.toggleSub}>Show suggestions in 1-on-1 chats</Text>
            </View>
            <Switch
              value={telegraphDM}
              onValueChange={(v) => handleTelegraphToggle('show_telegraph_dm', v)}
              trackColor={{ true: color.signal }}
              thumbColor={color.onInk}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Trip chats</Text>
              <Text style={styles.toggleSub}>Show suggestions in trip group chats</Text>
            </View>
            <Switch
              value={telegraphTrip}
              onValueChange={(v) => handleTelegraphToggle('show_telegraph_trip', v)}
              trackColor={{ true: color.signal }}
              thumbColor={color.onInk}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Circle chats</Text>
              <Text style={styles.toggleSub}>Show suggestions in circle group chats</Text>
            </View>
            <Switch
              value={telegraphCircle}
              onValueChange={(v) => handleTelegraphToggle('show_telegraph_circle', v)}
              trackColor={{ true: color.signal }}
              thumbColor={color.onInk}
            />
          </View>
        </View>

        {/* Standard settings groups */}
        {BASIC_GROUPS.map((g) => (
          <View key={g.h} style={{ gap: space.sm }}>
            <Text style={styles.h}>{g.h}</Text>
            {g.items.map((i) => {
              const isLogout = i === 'Log out';
              if (isLogout && !(configured && isAuthed)) return null;
              return (
                <Pressable
                  key={i}
                  style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                  onPress={() => onItem(i)}
                >
                  <Text style={[styles.item, isLogout && styles.logout]}>{i}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  h: { ...t.stamp, fontFamily: 'Courier', color: color.mute },
  sectionDesc: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 17 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  toggleLabel: { ...t.body, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  row: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.lg,
  },
  item: { ...t.body, color: color.ink },
  logout: { color: color.signal, fontWeight: '700' },
});
