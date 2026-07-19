import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Bookmark } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getSaveList, unsaveProfile } from '../src/services/saves';
import type { SavedUser } from '../src/services/saves';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

export default function SavedProfilesScreen() {
  const [users, setUsers] = useState<SavedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unsaving, setUnsaving] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getSaveList();
    if (res.ok && res.data) setUsers(res.data);
    else setUsers([]);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  function confirmUnsave(user: SavedUser) {
    Alert.alert(
      'Remove from saved',
      `Remove ${user.name ?? user.handle ?? 'this user'} from your saved profiles?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setUnsaving(user.id);
            const res = await unsaveProfile(user.id);
            setUnsaving(null);
            if (res.ok) {
              setUsers((prev) => prev.filter((u) => u.id !== user.id));
            } else {
              Alert.alert('Error', res.error ?? 'Could not remove saved profile');
            }
          },
        },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Saved profiles" back />

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : users.length === 0 ? (
        <View style={s.center}>
          <Bookmark size={32} color={color.haze} />
          <Text style={s.empty}>No saved profiles</Text>
          <Text style={s.emptySub}>
            Tap the bookmark icon on any profile to save them here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<PlainBottomFiller />}
          renderItem={({ item }) => (
            <Pressable
              style={s.row}
              onPress={() => item.handle && router.push(`/u/${item.handle}`)}
            >
              {item.avatarUrl ? (
                <Image source={{ uri: item.avatarUrl }} style={s.avatar} />
              ) : (
                <View style={[s.avatar, s.avatarPlaceholder]}>
                  <Text style={s.avatarInitial}>
                    {(item.name ?? item.handle ?? '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={s.info}>
                <Text style={s.name} numberOfLines={1}>
                  {item.name ?? item.handle ?? 'Unknown'}
                </Text>
                {item.handle ? (
                  <Text style={s.handle} numberOfLines={1}>@{item.handle}</Text>
                ) : null}
              </View>
              <Pressable
                style={s.unsaveBtn}
                onPress={() => confirmUnsave(item)}
                disabled={unsaving === item.id}
                hitSlop={8}
              >
                {unsaving === item.id ? (
                  <ActivityIndicator size="small" color={color.signal} />
                ) : (
                  <Bookmark size={16} color={color.signal} fill={color.signal} />
                )}
              </Pressable>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    gap: space.md, paddingHorizontal: space.xl,
  },
  empty: {
    fontSize: 16, fontWeight: '700', color: color.ink, textAlign: 'center',
  },
  emptySub: {
    fontSize: 13, color: color.mute, textAlign: 'center',
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarPlaceholder: {
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  avatarInitial: { fontSize: 18, fontWeight: '700', color: color.mute },
  info: { flex: 1, gap: 2 },
  name: { fontSize: 14, fontWeight: '700', color: color.ink },
  handle: { fontSize: 12, color: color.mute },
  unsaveBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center', justifyContent: 'center',
  },
});
