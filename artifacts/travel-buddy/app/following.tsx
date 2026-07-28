import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useSocialVersion } from '../src/hooks/useSocialVersion';
import { UserPlus } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { OfficialBadge } from '../src/components/OfficialBadge';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getMyFollowing } from '../src/services/follows';
import type { FollowUser } from '../src/services/follows';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

export default function FollowingScreen() {
  const [users, setUsers] = useState<FollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyFollowing();
    if (res.ok && res.data) setUsers(res.data);
    else setUsers([]);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // Re-fetch whenever the social-version counter bumps (e.g. after onboarding
  // completes and the server-side @Portava auto-follow has been written), so
  // @Portava appears in the list without requiring a manual focus/refresh.
  const socialVersion = useSocialVersion();
  const versionMounted = useRef(false);
  useEffect(() => {
    if (!versionMounted.current) { versionMounted.current = true; return; }
    void load();
  }, [socialVersion, load]);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Following" onBack={router.back} />
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : users.length === 0 ? (
        <View style={s.center}>
          <UserPlus size={32} color={color.haze} />
          <Text style={s.empty}>Not following anyone yet</Text>
          <Text style={s.emptySub}>People you follow will appear here.</Text>
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
