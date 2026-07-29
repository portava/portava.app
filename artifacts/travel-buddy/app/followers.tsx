import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { Users } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { OfficialBadge } from '../src/components/OfficialBadge';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getMyFollowers, getUserFollowers } from '../src/services/follows';
import type { FollowUser } from '../src/services/follows';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

export default function FollowersScreen() {
  const { userId, title } = useLocalSearchParams<{ userId?: string; title?: string }>();
  const [users, setUsers] = useState<FollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = userId ? await getUserFollowers(userId) : await getMyFollowers();
    if (res.ok && res.data) setUsers(res.data);
    else setUsers([]);
    setLoading(false);
  }, [userId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title={title ? `${title}'s Followers` : 'Followers'} onBack={router.back} />
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : users.length === 0 ? (
        <View style={s.center}>
          <Users size={32} color={color.haze} />
          <Text style={s.empty}>No followers yet</Text>
          <Text style={s.emptySub}>People who follow you will appear here.</Text>
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
            <Pressable
              style={s.row}
              onPress={() => router.push(`/u/${item.handle}` as any)}
            >
              {item.avatarUrl ? (
                <Image source={{ uri: item.avatarUrl }} style={s.avatar} />
              ) : (
                <View style={[s.avatar, s.avatarPlaceholder]}>
                  <Text style={s.avatarInitial}>
                    {(item.name?.[0] ?? item.handle?.[0] ?? '?').toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <View style={s.nameRow}>
                  <Text style={s.name} numberOfLines={1}>
                    {item.name ?? item.handle ?? 'Unknown'}
                  </Text>
                  {item.isOfficial ? <OfficialBadge size="sm" /> : null}
                </View>
                {item.handle ? (
                  <Text style={s.handle} numberOfLines={1}>@{item.handle}</Text>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm },
  empty: { ...t.body, color: color.mute, fontWeight: '600' },
  emptySub: { ...t.small, color: color.faint },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.haze, flexShrink: 0 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.body, color: color.mute, fontWeight: '700' },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute },
});
