import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { ScreenHeader } from '../ScreenHeader.tsx';
import { getBlockList, unblockUser, type BlockedUser } from '../../services/blocks.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useNavBarScrollHandler } from '../../hooks/useNavBarCollapse.ts';
import { PlainBottomFiller } from '../../hooks/useBottomInset.ts';

export function SocialSafetyControlsScreen() {
  const { removeBlock } = useBlockedIds();
  const navBarScrollHandler = useNavBarScrollHandler();
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await getBlockList();
      setLoading(false);
      if (res.ok && res.data) setBlocked(res.data);
    })();
  }, []);

  async function handleUnblock(userId: string) {
    setUnblocking(userId);
    const res = await unblockUser(userId);
    setUnblocking(null);
    if (res.ok) {
      removeBlock(userId);
      setBlocked((prev) => prev.filter((u) => u.id !== userId));
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Safety & Privacy" back />
      <View style={s.section}>
        <Text style={s.sectionTitle}>Blocked accounts</Text>
        {loading ? (
          <ActivityIndicator color={color.signal} style={{ marginTop: space.lg }} />
        ) : blocked.length === 0 ? (
          <Text style={s.empty}>No blocked accounts</Text>
        ) : (
          <FlatList
            data={blocked}
            keyExtractor={(item) => item.id}
            onScroll={navBarScrollHandler}
            scrollEventThrottle={16}
            ListFooterComponent={<PlainBottomFiller />}
            renderItem={({ item }) => (
              <View style={s.row}>
                {item.avatarUrl ? (
                  <Image source={{ uri: item.avatarUrl }} style={s.avatar} />
                ) : (
                  <View style={[s.avatar, s.avatarEmpty]}>
                    <Text style={{ fontSize: 18 }}>👤</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{item.name ?? item.handle ?? 'Unknown'}</Text>
                  {item.handle ? <Text style={s.handle}>@{item.handle}</Text> : null}
                </View>
                <Pressable
                  style={[s.unblockBtn, unblocking === item.id && { opacity: 0.5 }]}
                  onPress={() => handleUnblock(item.id)}
                  disabled={unblocking === item.id}
                >
                  <Text style={s.unblockText}>{unblocking === item.id ? '…' : 'Unblock'}</Text>
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
  section: { padding: space.lg, gap: space.md },
  sectionTitle: { ...t.heading, fontSize: 16, color: color.ink },
  empty: { fontSize: 14, color: color.mute, textAlign: 'center', marginTop: space.xl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center' },
  name: { ...t.bodyStrong, fontSize: 14, color: color.ink },
  handle: { fontSize: 12, color: color.mute, fontFamily: 'Courier' },
  unblockBtn: {
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.haze, borderRadius: radius.pill,
  },
  unblockText: { ...t.bodyStrong, fontSize: 13, color: color.ink },
});
