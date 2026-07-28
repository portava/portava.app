import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { Users } from 'lucide-react-native';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { getMutualFollows, type MutualFollowUser } from '../../src/services/follows';
import { VerifiedStamp } from '../../src/components/ui/VerifiedStamp';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

export default function MutualConnectionsScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [users, setUsers] = useState<MutualFollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    setLoading(true);
    const result = await getMutualFollows(userId);
    setUsers(result);
    setLoading(false);
  }, [userId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Mutual Connections" onBack={router.back} />
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : users.length === 0 ? (
        <View style={s.center}>
          <Users size={32} color={color.haze} />
          <Text style={s.empty}>No mutual connections</Text>
          <Text style={s.emptySub}>People you both follow will appear here.</Text>
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
                    {((item.displayName ?? item.handle ?? '?')[0] ?? '?').toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <View style={s.nameRow}>
                  <Text style={s.name} numberOfLines={1}>
                    {item.displayName ?? item.handle ?? 'Unknown'}
                  </Text>
                  {item.verified ? <VerifiedStamp size="sm" /> : null}
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
  nameRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 3 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14, flexShrink: 1 },
  handle: { ...t.small, color: color.mute },
});
