/**
 * HighlightViewersSheet — bottom sheet listing who viewed a highlight.
 * Only rendered/fetched when the current user is the highlight owner.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StampIcon } from './stamps/StampIcon.tsx';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import { fetchHighlightViewers, type HighlightViewer } from '../services/highlights.ts';

interface Props {
  visible: boolean;
  highlightId: string;
  onClose: () => void;
}

export function HighlightViewersSheet({ visible, highlightId, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [viewers, setViewers] = useState<HighlightViewer[]>([]);
  const [loading, setLoading] = useState(false);
  // §28.11. A failed read used to render "👁 0 viewers" and "No views yet." —
  // a claim about who has seen the owner's Highlight, made from a request that
  // failed. It is now an error with a retry.
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!visible || !highlightId) return;
    // The owner can open this sheet, close it, advance to the next Highlight
    // and open it again before the first read lands. Without this guard the
    // late answer for the PREVIOUS Highlight overwrote the current one's list.
    let stale = false;
    setLoading(true);
    setFailed(false);
    setViewers([]);
    fetchHighlightViewers(highlightId).then((r) => {
      if (stale) return;
      if (r.ok && r.data) setViewers(r.data);
      else setFailed(true);
      setLoading(false);
    });
    return () => { stale = true; };
  }, [visible, highlightId, reloadKey]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={s.grab} />
        <View style={s.head}>
          <Text style={s.title}>{failed ? '👁 Viewers' : `👁 ${viewers.length} viewer${viewers.length !== 1 ? 's' : ''}`}</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.loading}>
            <ActivityIndicator size="small" color={color.signal} />
          </View>
        ) : failed ? (
          <View style={s.empty} testID="highlight-viewers-error">
            <Text style={s.emptyText}>Couldn{'’'}t load who viewed this.</Text>
            <Pressable
              testID="highlight-viewers-retry"
              onPress={() => setReloadKey((k) => k + 1)}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={s.retry}>Try again</Text>
            </Pressable>
          </View>
        ) : viewers.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyText}>No views yet.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {viewers.map((v) => (
              <View key={v.userId} style={s.row}>
                <Avatar uri={v.avatarUrl} name={v.name ?? v.handle} size={40} />
                <View style={s.info}>
                  <Text style={s.name}>{v.name ?? v.handle}</Text>
                  <Text style={s.time}>{fmtTime(v.viewedAt)}</Text>
                </View>
                {v.likedByMe && (
                  <StampIcon size={14} active color={color.signal} />
                )}
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
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginTop: 10, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.heading, color: color.ink },
  closeBtn: { width: avatar.s32, height: avatar.s32, borderRadius: avatar.s32 / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  loading: { padding: space.xl, alignItems: 'center' },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute },
  retry: { ...t.bodyStrong, color: color.signal, marginTop: space.sm },
  list: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  info: { flex: 1 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
});
