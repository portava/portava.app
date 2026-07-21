import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { VolumeX } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getMuteList, unmuteUser } from '../src/services/mutes';
import type { MutedUser } from '../src/services/mutes';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

function muteTypeLabel(types: string[]): string {
  if (!types || types.length === 0) return '';
  if (types.includes('all')) return 'All activity muted';
  return types.map((t) => t.replace(/_/g, ' ')).join(', ');
}

export default function MutedUsersScreen() {
  const [users, setUsers] = useState<MutedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unmuting, setUnmuting] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMuteList();
    if (res.ok && res.data) setUsers(res.data);
    else setUsers([]);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  function confirmUnmute(user: MutedUser) {
    Alert.alert(
      'Unmute user',
      `Unmute ${user.name ?? user.handle ?? 'this user'}? They will be able to reach you again based on your privacy settings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unmute',
          onPress: async () => {
            setUnmuting(user.id);
            const res = await unmuteUser(user.id);
            setUnmuting(null);
            if (res.ok) {
              setUsers((prev) => prev.filter((u) => u.id !== user.id));
            } else {
              Alert.alert('Error', res.error ?? 'Could not unmute user');
            }
          },
        },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Muted accounts" back />

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : users.length === 0 ? (
        <View style={s.center}>
          <VolumeX size={32} color={color.haze} />
          <Text style={s.empty}>No muted accounts</Text>
          <Text style={s.emptySub}>
            Users you mute will appear here. Muting is private — they won't be notified.
          </Text>
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
          renderItem={({ item }) => (
            <View style={s.row}>
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
                {item.muteTypes && item.muteTypes.length > 0 ? (
                  <Text style={s.muteType} numberOfLines={1}>
                    {muteTypeLabel(item.muteTypes)}
                  </Text>
                ) : null}
              </View>
              <Pressable
                style={s.unmuteBtn}
                onPress={() => confirmUnmute(item)}
                disabled={unmuting === item.id}
                hitSlop={8}
              >
                {unmuting === item.id ? (
                  <ActivityIndicator size="small" color={color.mute} />
                ) : (
                  <Text style={s.unmuteBtnText}>Unmute</Text>
                )}
              </Pressable>
            </View>
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
  empty: { ...t.bodyStrong, fontSize: 16, color: color.ink, textAlign: 'center' },
  emptySub: { fontSize: 13, color: color.mute, textAlign: 'center' },
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
  name: { ...t.bodyStrong, fontSize: 14, color: color.ink },
  handle: { fontSize: 12, color: color.mute, fontFamily: 'Courier' },
  muteType: { fontSize: 11, color: color.faint, marginTop: 1 },
  unmuteBtn: {
    paddingHorizontal: space.md, paddingVertical: 7,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, minWidth: 68, alignItems: 'center',
  },
  unmuteBtnText: { ...t.bodyStrong, fontSize: 13, color: color.mute },
});
