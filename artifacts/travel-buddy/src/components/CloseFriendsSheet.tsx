/**
 * CloseFriendsSheet — bottom sheet for managing the Close Friends / Trusted Crew list.
 * Shows current members with remove option. Add by user ID via text input.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Heart, Search } from 'lucide-react-native';
import { color, radius, space, type as t } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import {
  getCloseFriends, addCloseFriend, removeCloseFriend,
  type CloseFriend,
} from '../services/stories.ts';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function CloseFriendsSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [friends, setFriends] = useState<CloseFriend[]>([]);
  const [loading, setLoading] = useState(true);
  const [addInput, setAddInput] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getCloseFriends();
    setLoading(false);
    if (res.ok) setFriends(res.closeFriends);
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  async function handleAdd() {
    const userId = addInput.trim();
    if (!userId) return;
    setAdding(true);
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
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={s.handle} />

        <View style={s.headerRow}>
          <Heart size={18} color={color.signal} fill={color.signal} />
          <Text style={s.title}>Close Friends</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>

        <Text style={s.sub}>Only people on this list can see your Close Friends stories. They are not notified.</Text>

        {/* Add by user ID */}
        <View style={s.addRow}>
          <Search size={16} color={color.mute} style={{ flexShrink: 0 }} />
          <TextInput
            style={s.addInput}
            placeholder="Enter user ID to add..."
            placeholderTextColor={color.faint}
            value={addInput}
            onChangeText={setAddInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleAdd}
          />
          <Pressable onPress={handleAdd} disabled={!addInput.trim() || adding} style={[s.addBtn, (!addInput.trim() || adding) && { opacity: 0.4 }]}>
            {adding ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.addBtnText}>Add</Text>}
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator color={color.deep} style={{ marginVertical: 32 }} />
        ) : friends.length === 0 ? (
          <View style={s.empty}>
            <Heart size={32} color={color.haze} />
            <Text style={s.emptyText}>No Close Friends yet</Text>
            <Text style={s.emptySub}>Add people above to share your Close Friends stories with them.</Text>
          </View>
        ) : (
          <FlatList
            data={friends}
            keyExtractor={(item) => item.userId}
            style={{ maxHeight: 360 }}
            renderItem={({ item }) => (
              <View style={s.friendRow}>
                <View style={s.avatar} />
                <View style={{ flex: 1 }}>
                  <Text style={s.friendName}>{item.name ?? item.handle ?? 'Traveler'}</Text>
                  {item.handle ? <Text style={s.friendHandle}>@{item.handle}</Text> : null}
                </View>
                <Pressable
                  onPress={() => handleRemove(item.userId, item.name ?? item.handle ?? 'Traveler')}
                  hitSlop={8}
                  style={s.removeBtn}
                >
                  <X size={16} color={color.mute} />
                </Pressable>
              </View>
            )}
          />
        )}
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: space.lg, paddingTop: space.md,
  },
  handle: { width: 36, height: 4, backgroundColor: color.haze, borderRadius: 2, alignSelf: 'center', marginBottom: space.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  title: { flex: 1, ...t.heading, color: color.ink },
  sub: { ...t.small, color: color.mute, marginBottom: space.md, lineHeight: 18 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, marginBottom: space.md },
  addInput: { flex: 1, ...t.body, color: color.ink, paddingVertical: 0 },
  addBtn: { backgroundColor: color.signal, paddingHorizontal: space.md, paddingVertical: space.xs ?? 4, borderRadius: radius.pill },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  emptyText: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center', maxWidth: 260 },
  friendRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  friendName: { ...t.bodyStrong, color: color.ink },
  friendHandle: { ...t.small, color: color.mute },
  removeBtn: { padding: 4 },
});
