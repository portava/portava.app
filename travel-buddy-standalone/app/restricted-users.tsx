import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { AppHeader } from '../src/components/ui/AppHeader';
import { ErrorState } from '../src/components/ui/ErrorState';
import { Avatar } from '../src/components/ui/Avatar';
import { getRestrictList, unrestrictUser, type RestrictedUser } from '../src/services/restrict';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

export default function RestrictedUsersScreen() {
  const [restricted, setRestricted] = useState<RestrictedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unrestricting, setUnrestricting] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const navBarScrollHandler = useNavBarScrollHandler();

  // A failed read used to say "No restricted accounts", and a failed
  // Unrestrict left the row with no word: both now say what happened.
  const load = useCallback(async () => {
    setLoading(true);
    const res = await getRestrictList();
    if (res.ok && res.data) setRestricted(res.data);
    setLoadFailed(!res.ok);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleUnrestrict(userId: string) {
    setUnrestricting(userId);
    const res = await unrestrictUser(userId);
    setUnrestricting(null);
    if (res.ok) setRestricted((prev) => prev.filter((u) => u.id !== userId));
    else Alert.alert('Could not unrestrict', 'This account is still restricted. Please try again.');
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Restricted Accounts" onBack={router.back} />
      <View style={s.content}>
        {loading ? (
          <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />
        ) : loadFailed && restricted.length === 0 ? (
          <View testID="restricted-users-load-error">
            <ErrorState message="Your restricted accounts could not be loaded. Everyone you restricted is still restricted." onRetry={() => { void load(); }} />
          </View>
        ) : restricted.length === 0 ? (
          <View style={{ alignItems: 'center' }}>
            <Text style={s.empty}>No restricted accounts</Text>
            <Text style={[s.empty, { fontSize: 12, marginTop: 4 }]}>
              Restricting someone limits what they can see on your profile without blocking them.
            </Text>
          </View>
        ) : (
          <FlatList
            data={restricted}
            keyExtractor={(item) => item.id}
            onScroll={navBarScrollHandler}
            scrollEventThrottle={16}
            ListFooterComponent={<NavBarFiller />}
            renderItem={({ item }) => (
              <View style={s.row}>
                <Avatar
                  uri={item.avatarUrl}
                  name={item.name ?? item.handle}
                  size={40}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{item.name ?? item.handle ?? 'Unknown'}</Text>
                  {item.handle ? <Text style={s.handle}>@{item.handle}</Text> : null}
                </View>
                <Pressable
                  style={[s.actionBtn, unrestricting === item.id && { opacity: 0.5 }]}
                  onPress={() => handleUnrestrict(item.id)}
                  disabled={unrestricting === item.id}
                >
                  <Text style={s.actionText}>{unrestricting === item.id ? '…' : 'Unrestrict'}</Text>
                </Pressable>
              </View>
            )}
          />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  content: { flex: 1, padding: space.lg },
  empty: { fontSize: 14, color: color.mute, textAlign: 'center', marginTop: space.xl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  name: { ...t.bodyStrong, fontSize: 14, color: color.ink },
  handle: { fontSize: 12, color: color.mute, fontFamily: 'Courier' },
  actionBtn: {
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.haze, borderRadius: radius.pill,
  },
  actionText: { ...t.bodyStrong, fontSize: 13, color: color.ink },
});
