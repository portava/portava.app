import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { X } from 'lucide-react-native';
import type { OwnProfile } from '../types/models';
import { color, space, radius, type as t } from '../theme/tokens';

const DISMISSED_KEY = '@passport_completion_dismissed';

interface CheckItem { label: string; done: boolean; }

function checks(profile: OwnProfile): CheckItem[] {
  return [
    { label: 'Add profile photo', done: Boolean(profile.avatarUrl) },
    { label: 'Choose username', done: Boolean(profile.username) },
    { label: 'Add bio', done: Boolean(profile.bio?.trim()) },
    { label: 'Add home base', done: Boolean(profile.homeCity) },
  ];
}

export function ProfileCompletionCard({
  profile,
  onOpenSettings,
}: {
  profile: OwnProfile;
  onOpenSettings: () => void;
}) {
  const [dismissed, setDismissed] = useState(true); // hidden until async check

  useEffect(() => {
    AsyncStorage.getItem(DISMISSED_KEY).then((val) => {
      if (!val) setDismissed(false);
    });
  }, []);

  const items = checks(profile);
  const done = items.filter((i) => i.done).length;
  const total = items.length;

  const dismiss = async () => {
    setDismissed(true);
    await AsyncStorage.setItem(DISMISSED_KEY, '1');
  };

  if (dismissed || done === total) return null;

  return (
    <View style={cc.card}>
      <View style={cc.top}>
        <View style={{ flex: 1 }}>
          <Text style={cc.title}>Complete your Passport</Text>
          <Text style={cc.sub}>{done}/{total} done</Text>
        </View>
        <Pressable onPress={dismiss} hitSlop={8}><X size={16} color={color.mute} /></Pressable>
      </View>
      <View style={cc.track}>
        <View style={[cc.fill, { width: `${(done / total) * 100}%` }]} />
      </View>
      <View style={cc.items}>
        {items.filter((i) => !i.done).slice(0, 2).map((item) => (
          <Text key={item.label} style={cc.item}>· {item.label}</Text>
        ))}
      </View>
      <Pressable style={cc.btn} onPress={onOpenSettings}>
        <Text style={cc.btnText}>Finish setup</Text>
      </Pressable>
    </View>
  );
}

const cc = StyleSheet.create({
  card: {
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze,
    padding: space.md, gap: space.sm,
  },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  title: { ...t.bodyStrong, color: color.ink },
  sub: { ...t.small, color: color.mute },
  track: { height: 4, backgroundColor: color.haze, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: color.signal, borderRadius: 2 },
  items: { gap: 2 },
  item: { ...t.small, color: color.mute },
  btn: {
    alignSelf: 'flex-start', backgroundColor: color.ink,
    borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6,
  },
  btnText: { ...t.small, color: color.onInk, fontWeight: '700' },
});
