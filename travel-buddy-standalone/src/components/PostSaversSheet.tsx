/**
 * PostSaversSheet — bottom sheet listing users who saved a post or gem.
 * Only rendered/fetched when the current user is the post author.
 * Privacy-opted-out users are already excluded by the API.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { X, Bookmark } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import { fetchPostSavers, type PostSaver } from '../services/postViewers.ts';

interface Props {
  visible: boolean;
  postId: string;
  onClose: () => void;
}

export function PostSaversSheet({ visible, postId, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [savers, setSavers] = useState<PostSaver[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !postId) return;
    setLoading(true);
    fetchPostSavers(postId).then((r) => {
      setSavers(r.ok && r.data ? r.data : []);
      setLoading(false);
    });
  }, [visible, postId]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={s.grab} />
        <View style={s.head}>
          <Bookmark size={16} color={color.signal} />
          <Text style={s.title}>
            {savers.length > 0
              ? `Saved by ${savers.length}`
              : 'Saved by'}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.loading}>
            <ActivityIndicator size="small" color={color.signal} />
          </View>
        ) : savers.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyText}>No saves yet.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {savers.map((sv) => (
              <View key={sv.userId} style={s.row}>
                <Avatar uri={sv.avatarUrl} name={sv.name ?? sv.handle} size={40} />
                <View style={s.info}>
                  <Text style={s.name}>{sv.name ?? sv.handle}</Text>
                  <Text style={s.handle}>@{sv.handle}</Text>
                </View>
                <Text style={s.time}>{fmtTime(sv.savedAt)}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '65%',
    ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginTop: 10, marginBottom: 4 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  title: { ...t.heading, color: color.ink },
  closeBtn: {
    width: avatar.sm, height: avatar.sm, borderRadius: avatar.sm / 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.haze,
  },
  loading: { padding: space.xl, alignItems: 'center' },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute },
  list: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  info: { flex: 1 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
});
