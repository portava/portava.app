import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { ShieldOff } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { Avatar } from '../src/components/ui/Avatar';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getBlockList, unblockUser } from '../src/services/blocks';
import type { BlockedUser } from '../src/services/blocks';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

export default function BlockedUsersScreen() {
  const [users, setUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getBlockList();
    if (res.ok && res.data) setUsers(res.data);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function confirmUnblock(user: BlockedUser) {
    Alert.alert(
      'Unblock user',
      `Unblock ${user.name ?? user.handle ?? 'this user'}? They will be able to follow you and send messages again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            setUnblocking(user.id);
            const res = await unblockUser(user.id);
            setUnblocking(null);
            if (res.ok) {
              setUsers((prev) => prev.filter((u) => u.id !== user.id));
            } else {
              Alert.alert('Error', res.error ?? 'Could not unblock user');
            }
          },
        },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Blocked accounts" onBack={router.back} />
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : users.length === 0 ? (
        <View style={s.center}>
          <ShieldOff size={32} color={color.haze} />
          <Text style={s.empty}>No blocked accounts</Text>
          <Text style={s.emptySub}>Users you block will appear here.</Text>
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
              <Avatar
                uri={item.avatarUrl}
                name={item.name ?? item.handle}
                size={44}
                style={s.avatarBox}
              />
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>
                  {item.name ?? item.handle ?? 'Unknown'}
                </Text>
                {item.handle ? (
                  <Text style={s.handle} numberOfLines={1}>@{item.handle}</Text>
                ) : null}
              </View>
              <Pressable
                style={[s.unblockBtn, unblocking === item.id && s.unblockBtnDisabled]}
                onPress={() => confirmUnblock(item)}
                disabled={unblocking === item.id}
              >
                {unblocking === item.id ? (
                  <ActivityIndicator size="small" color={color.signal} />
                ) : (
                  <Text style={s.unblockText}>Unblock</Text>
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
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute },
  unblockBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal,
    minWidth: 72,
    alignItems: 'center',
  },
  unblockBtnDisabled: { opacity: 0.5 },
  unblockText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
});
