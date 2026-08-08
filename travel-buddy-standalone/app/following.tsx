import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { useSocialVersion } from '../src/hooks/useSocialVersion';
import { UserPlus } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { Avatar } from '../src/components/ui/Avatar';
import { OfficialBadge } from '../src/components/OfficialBadge';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getMyFollowing, getUserFollowing } from '../src/services/follows';
import type { FollowUser } from '../src/services/follows';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

export default function FollowingScreen() {
  const { userId, title } = useLocalSearchParams<{ userId?: string; title?: string }>();
  const [users, setUsers] = useState<FollowUser[]>([]);
  const [loading, setLoading] = useState(true);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = userId ? await getUserFollowing(userId) : await getMyFollowing();
    if (res.ok && res.data) setUsers(res.data);
    else setUsers([]);
    setLoading(false);
  }, [userId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // Re-fetch whenever the social-version counter bumps (e.g. after onboarding
  // completes and the server-side @Portava auto-follow has been written), so
  // @Portava appears in the list without requiring a manual focus/refresh.
  // Only relevant to the viewer's own "following" list.
  const socialVersion = useSocialVersion();
  const versionMounted = useRef(false);
  useEffect(() => {
    if (userId) return;
    if (!versionMounted.current) { versionMounted.current = true; return; }
    void load();
  }, [socialVersion, load, userId]);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title={title ? `${title}'s Following` : 'Following'} onBack={router.back} />
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
              <Avatar
                uri={item.avatarUrl}
                name={item.name ?? item.handle}
                size={44}
                style={s.avatarBox}
              />
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
  // Sizing/shape now come from <Avatar size>; this carries layout only.
  avatarBox: { flexShrink: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute },
});
