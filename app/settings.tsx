import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { useSession } from '../src/context/SessionContext';
import { color, space, type as t, radius, layout } from '../src/theme/tokens';

const GROUPS = [
  { h: 'Privacy', items: ['Hide current location', 'Hide upcoming trips', 'Private account', 'Nearby visibility', 'Message permissions'] },
  { h: 'Safety', items: ['Blocked accounts', 'Report history', 'Muted words'] },
  { h: 'Account', items: ['Edit profile', 'Notifications', 'Log out'] },
];

export default function Settings() {
  const { signOut, isAuthed, configured } = useSession();

  async function onItem(label: string) {
    if (label === 'Log out') {
      await signOut();
      router.replace('/(auth)/sign-in');
      return;
    }
    // other items: placeholders for now
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Settings" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: space.xxxl }}>
        {GROUPS.map((g) => (
          <View key={g.h} style={{ gap: space.sm }}>
            <Text style={styles.h}>{g.h}</Text>
            {g.items.map((i) => {
              const isLogout = i === 'Log out';
              if (isLogout && !(configured && isAuthed)) return null;
              return (
                <Pressable key={i} style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]} onPress={() => onItem(i)}>
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
  h: { ...t.stamp, fontFamily: 'Courier', color: color.mute },
  row: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.lg },
  item: { ...t.body, color: color.ink },
  logout: { color: color.signal, fontWeight: '700' },
});
