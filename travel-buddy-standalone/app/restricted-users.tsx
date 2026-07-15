import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { getRestrictList, unrestrictUser, type RestrictedUser } from '../src/services/restrict';
import { color, space, radius, type as t } from '../src/theme/tokens';

export default function RestrictedUsersScreen() {
  const [restricted, setRestricted] = useState<RestrictedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [unrestricting, setUnrestricting] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await getRestrictList();
      setLoading(false);
      if (res.ok && res.data) setRestricted(res.data);
    })();
  }, []);

  async function handleUnrestrict(userId: string) {
    setUnrestricting(userId);
    const res = await unrestrictUser(userId);
    setUnrestricting(null);
    if (res.ok) setRestricted((prev) => prev.filter((u) => u.id !== userId));
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Restricted Accounts" back />
      <View style={s.content}>
        {loading ? (
          <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />
        ) : restricted.length === 0 ? (
          <Text style={s.empty}>No restricted accounts</Text>
        ) : (
          <FlatList
            data={restricted}
            keyExtractor={(item) => item.id}
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
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center' },
  name: { ...t.bodyStrong, fontSize: 14, color: color.ink },
  handle: { fontSize: 12, color: color.mute, fontFamily: 'Courier' },
  actionBtn: {
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.haze, borderRadius: radius.pill,
  },
  actionText: { ...t.bodyStrong, fontSize: 13, color: color.ink },
});
