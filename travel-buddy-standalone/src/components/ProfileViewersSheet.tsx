/**
 * ProfileViewersSheet — bottom sheet listing users who viewed the current
 * user's profile in the last 7 days.
 * Privacy-opted-out users are already excluded by the API.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Image, Pressable, Modal, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { X, Eye } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { fetchProfileViewers, type ProfileViewer } from '../services/postViewers.ts';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ProfileViewersSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [viewers, setViewers] = useState<ProfileViewer[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    fetchProfileViewers().then((r) => {
      setViewers(r.ok && r.data ? r.data : []);
      setLoading(false);
    });
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={s.grab} />
        <View style={s.head}>
          <Eye size={16} color={color.signal} />
          <Text style={s.title}>
            {viewers.length > 0 ? `${viewers.length} profile viewer${viewers.length !== 1 ? 's' : ''} · 7 days` : 'Profile viewers · 7 days'}
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
        ) : viewers.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyText}>No profile views in the last 7 days.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {viewers.map((v) => (
              <View key={v.userId} style={s.row}>
                <Image
                  source={v.avatarUrl ? { uri: v.avatarUrl } : undefined}
                  style={s.avatar}
                />
                <View style={s.info}>
                  <Text style={s.name}>{v.name ?? v.handle}</Text>
                  <Text style={s.handle}>@{v.handle}</Text>
                </View>
                <Text style={s.time}>{fmtTime(v.viewedAt)}</Text>
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
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.haze,
  },
  loading: { padding: space.xl, alignItems: 'center' },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute },
  list: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  info: { flex: 1 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  handle: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
});
