/**
 * Close Friends screen — full-page view of the Trusted Crew list.
 * Accessible from Settings → Privacy → Close Friends.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Heart, Search, X } from 'lucide-react-native';
import { color, radius, space, type as t, avatar } from '../src/theme/tokens';
import {
  getCloseFriends, addCloseFriend, removeCloseFriend,
  type CloseFriend,
} from '../src/services/stories';
import { searchUsers } from '../src/services/follows';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function CloseFriendsScreen() {
  const insets = useSafeAreaInsets();
  const [friends, setFriends] = useState<CloseFriend[]>([]);
  const [loading, setLoading] = useState(true);
  const [addInput, setAddInput] = useState('');
  const [adding, setAdding] = useState(false);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getCloseFriends();
    setLoading(false);
    if (res.ok) setFriends(res.closeFriends);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAdd() {
    const raw = addInput.trim().replace(/^@/, '');
    if (!raw) return;
    setAdding(true);

    // Resolve @handle → UUID if needed
    let userId = raw;
    if (!UUID_RE.test(raw)) {
      const sr = await searchUsers(raw, 1);
      if (!sr.ok || !sr.data?.length) {
        setAdding(false);
        Alert.alert('Not found', `No traveler found with username "@${raw}". Make sure you follow them first.`);
        return;
      }
      userId = sr.data[0].id;
    }

    const res = await addCloseFriend(userId);
    setAdding(false);
    if (res.ok) {
      setAddInput('');
      await load();
    } else {
      Alert.alert('Could not add', res.message ?? 'User not found or you must follow them first.');
    }
  }

  async function handleRemove(userId: string, name: string) {
    Alert.alert(
      'Remove from Close Friends?',
      `${name} will no longer see your Close Friends stories.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive', onPress: async () => {
            await removeCloseFriend(userId);
            setFriends((f) => f.filter((x) => x.userId !== userId));
          },
        },
      ],
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.headerRow}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={[s.headerTitle]}>Trusted Crew</Text>
      </View>

      <View style={s.hero}>
        <Heart size={32} color={color.signal} fill={color.signal} />
        <Text style={s.heroTitle}>Trusted Crew</Text>
        <Text style={s.heroSub}>
          Only people on this list see your Close Friends stories.
          They are never notified that they are on the list.
        </Text>
      </View>

      {/* Add input */}
      <View style={s.addRow}>
        <Search size={16} color={color.mute} />
        <TextInput
          style={s.addInput}
          placeholder="Add by @username"
          placeholderTextColor={color.faint}
          value={addInput}
          onChangeText={setAddInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={handleAdd}
        />
        <Pressable
          onPress={handleAdd}
          disabled={!addInput.trim() || adding}
          style={[s.addBtn, (!addInput.trim() || adding) && { opacity: 0.4 }]}
        >
          {adding
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={s.addBtnText}>Add</Text>}
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={color.deep} style={{ flex: 1 }} />
      ) : friends.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No Close Friends yet</Text>
          <Text style={s.emptySub}>Add a traveler by their @username above to build your Trusted Crew.</Text>
        </View>
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(item) => item.userId}
          renderItem={({ item }) => (
            <View style={s.row}>
              <View style={s.avatar} />
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name ?? item.handle ?? 'Traveler'}</Text>
                {item.handle ? <Text style={s.handle}>@{item.handle}</Text> : null}
              </View>
              <Pressable
                onPress={() => handleRemove(item.userId, item.name ?? item.handle ?? 'Traveler')}
                hitSlop={8}
              >
                <X size={18} color={color.mute} />
              </Pressable>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          contentContainerStyle={{ paddingHorizontal: space.md }}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: 4 },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, paddingHorizontal: space.lg },
  heroTitle: { ...t.heading, color: color.ink, fontSize: 20 },
  heroSub: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18, maxWidth: 280 },
  addRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.md, marginBottom: space.md,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
  },
  addInput: { flex: 1, ...t.body, color: color.ink, paddingVertical: 0 },
  addBtn: { backgroundColor: color.signal, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl },
  emptyText: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  avatar: { width: avatar.lgXl, height: avatar.lgXl, borderRadius: avatar.lgXl / 2, backgroundColor: color.haze },
  name: { ...t.bodyStrong, color: color.ink },
  handle: { ...t.small, color: color.mute },
  sep: { height: 1, backgroundColor: color.haze },
});
