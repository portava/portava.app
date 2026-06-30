import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Modal, Share, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';
import { MoreVertical, Share2, Flag } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { PostCard } from '../../src/components/PostCard';
import { ReportPostSheet } from '../../src/components/ReportPostSheet';
import { postById } from '../../src/data/cebu';
import { useSession } from '../../src/context/SessionContext';
import { color, space, type as t } from '../../src/theme/tokens';

// ── Small overflow action sheet ────────────────────────────────────────────────

function PostOverflowSheet({
  visible,
  onClose,
  onShare,
  onReport,
}: {
  visible: boolean;
  onClose: () => void;
  onShare: () => void;
  onReport: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={ov.overlay}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={ov.sheet}>
          <View style={ov.handle} />
          <Pressable
            style={ov.row}
            onPress={() => { onClose(); onShare(); }}
          >
            <Share2 size={20} color={color.ink} />
            <Text style={ov.rowLabel}>Share post</Text>
          </Pressable>
          <View style={ov.divider} />
          <Pressable
            style={ov.row}
            onPress={() => { onClose(); onReport(); }}
          >
            <Flag size={20} color={color.signal} />
            <Text style={[ov.rowLabel, { color: color.signal }]}>Report post</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const ov = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: space.lg, paddingBottom: 34, paddingTop: space.sm,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 14 },
  rowLabel: { ...t.body, color: color.ink, fontSize: 15 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.haze },
});

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function PostDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const post = postById(id);
  const { userId } = useSession();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [reportOpen, setReportOpen]     = useState(false);

  const isOwnPost = !!(userId && post?.author.id === userId);

  async function handleShare() {
    if (!post) return;
    const deepLink = Linking.createURL(`post/${post.id}`);
    const caption = post.caption ? `${post.caption.slice(0, 120)}…\n\n` : '';
    await Share.share({
      message: `${caption}${deepLink}`,
      url: deepLink,
    });
  }

  const headerRight = post && !isOwnPost ? (
    <Pressable
      onPress={() => setOverflowOpen(true)}
      hitSlop={8}
      accessibilityLabel="More options"
    >
      <MoreVertical size={22} color={color.ink} />
    </Pressable>
  ) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Post" back right={headerRight} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {post
          ? <PostCard post={post} />
          : <Text style={{ ...t.body, color: color.mute }}>Post not found.</Text>}
        <Text style={{ ...t.heading, color: color.ink }}>Comments</Text>
        <Text style={{ ...t.body, color: color.mute }}>Comments thread shell — wire to backend later.</Text>
      </ScrollView>
      {post && !isOwnPost && (
        <>
          <PostOverflowSheet
            visible={overflowOpen}
            onClose={() => setOverflowOpen(false)}
            onShare={handleShare}
            onReport={() => setReportOpen(true)}
          />
          <ReportPostSheet
            postId={post.id}
            visible={reportOpen}
            onClose={() => setReportOpen(false)}
          />
        </>
      )}
    </View>
  );
}
