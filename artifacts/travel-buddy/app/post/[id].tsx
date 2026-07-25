import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, Pressable, Modal, Share, StyleSheet,
  Image, ActivityIndicator, useWindowDimensions,
  Keyboard,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useLocalSearchParams, router } from 'expo-router';
import * as Linking from 'expo-linking';
import {
  MoreVertical, Share2, Flag, Flag as FlagFill,
  MapPin, Heart, MessageCircle, UserCircle, Pencil,
} from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { ReportSheet } from '../../src/components/ReportSheet';
import { CommentsSection } from '../../src/components/CommentsSheet';
import { MediaStampOverlay } from '../../src/components/StampOverlayBadge';
import { SharedVideoPlayer } from '../../src/components/ui/SharedVideoPlayer';
import { getPostById, type PostRow } from '../../src/services/posts';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { emitCommentCount } from '../../src/lib/commentCountStore';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

const UNDO_WINDOW_MS = 5000;

// ── Small overflow action sheet ─────────────────────────────────────────────

function PostOverflowSheet({
  visible,
  onClose,
  onShare,
  onReport,
  onEdit,
}: {
  visible: boolean;
  onClose: () => void;
  onShare: () => void;
  onReport?: () => void;
  onEdit?: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={ov.overlay}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={ov.sheet}>
          <View style={ov.handle} />
          {onEdit && (
            <>
              <Pressable style={ov.row} onPress={() => { onClose(); onEdit(); }}>
                <Pencil size={20} color={color.ink} />
                <Text style={ov.rowLabel}>Edit post</Text>
              </Pressable>
              <View style={ov.divider} />
            </>
          )}
          <Pressable style={ov.row} onPress={() => { onClose(); onShare(); }}>
            <Share2 size={20} color={color.ink} />
            <Text style={ov.rowLabel}>Share post</Text>
          </Pressable>
          {onReport && (
            <>
              <View style={ov.divider} />
              <Pressable style={ov.row} onPress={() => { onClose(); onReport(); }}>
                <Flag size={20} color={color.signal} />
                <Text style={[ov.rowLabel, { color: color.signal }]}>Report post</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Reported placeholder ─────────────────────────────────────────────────────

function ReportedBanner({
  undoAvailable,
  onUndo,
}: {
  undoAvailable: boolean;
  onUndo: () => void;
}) {
  return (
    <View style={rb.wrap}>
      <View style={rb.iconWrap}>
        <FlagFill size={28} color={color.signal} />
      </View>
      <Text style={rb.title}>You reported this post</Text>
      <Text style={rb.sub}>Thank you — our team will review it shortly.</Text>
      {undoAvailable && (
        <Pressable style={rb.undoBtn} onPress={onUndo} hitSlop={8}>
          <Text style={rb.undoLabel}>Undo</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Minimal post detail card (renders a live PostRow) ────────────────────────

function PostDetailCard({ post, commentCount }: { post: PostRow; commentCount: number }) {
  const { width } = useWindowDimensions();
  const mediaHeight = Math.min(Math.round(width * (5 / 4)), 560);
  const firstMediaItem = post.media?.[0] ?? null;
  const firstMedia = firstMediaItem?.url ?? post.mediaUrls[0] ?? null;
  const loc = post.locationName ?? post.locationCity ?? null;
  const authorName = post.author?.name ?? 'Traveler';
  const authorAvatar = post.author?.avatarUrl ?? null;
  const ts = new Date(post.createdAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  return (
    <View style={card.wrap}>
      <Pressable
        style={card.authorRow}
        onPress={post.author?.handle ? () => router.push(`/u/${post.author!.handle}` as any) : undefined}
      >
        {authorAvatar ? (
          <Image source={{ uri: authorAvatar }} style={card.avatar} />
        ) : (
          <View style={[card.avatar, card.avatarPlaceholder]}>
            <UserCircle size={20} color={color.mute} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={card.authorName}>{authorName}</Text>
          <Text style={card.ts}>{ts}</Text>
        </View>
      </Pressable>

      {firstMedia ? (
        <View style={[card.media, { height: mediaHeight, overflow: 'hidden' as const }]}>
          {firstMediaItem?.media_type === 'video' ? (
            <SharedVideoPlayer
              uri={firstMedia}
              poster={firstMediaItem?.thumbnail_url ?? undefined}
              autoplay={false}
              muted
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <>
              <Image source={{ uri: firstMedia }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              <MediaStampOverlay raw={firstMediaItem?.stamp_overlay} />
            </>
          )}
        </View>
      ) : (
        <View style={[card.media, { height: mediaHeight }, card.mediaPlaceholder]}>
          <MapPin size={28} color={color.onInk} />
          <Text style={card.mediaPlaceholderText} numberOfLines={1}>
            {(post.locationCity ?? post.locationName ?? 'TRAVEL').toUpperCase()}
          </Text>
        </View>
      )}

      {post.content ? (
        <Text style={card.content}>{post.content}</Text>
      ) : null}

      {loc ? (
        <View style={card.locRow}>
          <MapPin size={12} color={color.mute} />
          <Text style={card.locText}>{loc}</Text>
        </View>
      ) : null}

      <View style={card.engRow}>
        <View style={card.engItem}>
          <Heart size={14} color={color.mute} />
          <Text style={card.engText}>{post.likeCount}</Text>
        </View>
        <View style={card.engItem}>
          <MessageCircle size={14} color={color.mute} />
          <Text style={card.engText}>{commentCount}</Text>
        </View>
      </View>
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function PostDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [post, setPost]             = useState<PostRow | null>(null);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [commentCount, setCommentCount] = useState(0);

  const [overflowOpen, setOverflowOpen]   = useState(false);
  const [reportOpen, setReportOpen]       = useState(false);
  const [reported, setReported]           = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const handleInputFocus = useCallback(() => {
    // Delay matches the iOS keyboard animation (~250 ms) so the scroll
    // fires after the view has already shrunk to its new height.
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
  }, []);

  useEffect(() => {
    if (!id) { setLoading(false); return; }
    setLoading(true);
    setFetchError(null);
    getPostById(id)
      .then((result) => {
        if (result.ok && result.data) {
          setPost(result.data);
          setCommentCount(result.data.commentCount);
        } else {
          setFetchError(
            result.errorKind === 'not_found'
              ? 'Post not found.'
              : 'Could not load this post.',
          );
        }
      })
      .catch(() => setFetchError('Could not load this post.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  // Emit the live comment count so feed cards update instantly on return.
  // Guard on `post` being loaded — commentCount starts at 0 before the fetch
  // resolves, and emitting that premature zero would clobber the feed card.
  useEffect(() => {
    if (id && post && typeof commentCount === 'number') {
      emitCommentCount(id, commentCount);
    }
  }, [id, post, commentCount]);

  const isOwnPost = !!(userId && post?.author?.id === userId);

  const handleReported = useCallback(() => {
    setReported(true);
    setUndoAvailable(true);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoAvailable(false), UNDO_WINDOW_MS);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setReported(false);
    setUndoAvailable(false);
  }, []);

  async function handleShare() {
    if (!post) return;
    const deepLink = Linking.createURL(`post/${post.id}`);
    const preview = post.content ? `${post.content.slice(0, 120)}…\n\n` : '';
    await Share.share({ message: `${preview}${deepLink}`, url: deepLink });
  }

  const headerRight = post ? (
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
      <KeyboardSafeScrollView>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: space.lg, gap: space.lg }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
        >
          {loading ? (
            <View style={{ paddingVertical: space.xxl, alignItems: 'center' }}>
              <ActivityIndicator color={color.signal} />
            </View>
          ) : fetchError ? (
            <Text style={{ ...t.body, color: color.mute }}>{fetchError}</Text>
          ) : post ? (
            reported
              ? <ReportedBanner undoAvailable={undoAvailable} onUndo={handleUndo} />
              : (
                <Pressable onPress={Keyboard.dismiss}>
                  <PostDetailCard post={post} commentCount={commentCount} />
                </Pressable>
              )
          ) : null}

          {post && !reported && (
            <View style={{ gap: space.md }}>
              <Text style={{ ...t.heading, color: color.ink }}>
                {commentCount > 0
                  ? `${commentCount} Comment${commentCount !== 1 ? 's' : ''}`
                  : 'Comments'}
              </Text>
              <CommentsSection
                postId={post.id}
                onCountChange={setCommentCount}
                onInputFocus={handleInputFocus}
              />
            </View>
          )}
          <NavBarFiller />
        </ScrollView>
      </KeyboardSafeScrollView>

      {post && (
        <>
          <PostOverflowSheet
            visible={overflowOpen}
            onClose={() => setOverflowOpen(false)}
            onShare={handleShare}
            onEdit={isOwnPost ? () => router.push(`/post/edit/${post.id}` as any) : undefined}
            onReport={!isOwnPost ? () => setReportOpen(true) : undefined}
          />
          {!isOwnPost && (
            <ReportSheet
              visible={reportOpen}
              onClose={() => setReportOpen(false)}
              subjectType="post"
              subjectId={post.id}
              subjectUserId={post.author?.id ?? undefined}
              onReported={handleReported}
            />
          )}
        </>
      )}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const card = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
  },
  avatar: { width: 38, height: 38, borderRadius: 19 },
  avatarPlaceholder: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authorName: { ...t.bodyStrong, color: color.ink },
  ts:         { ...t.small,     color: color.mute },
  media:      { width: '100%' },
  mediaPlaceholder: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center', gap: 8 },
  mediaPlaceholderText: { fontFamily: 'Courier', fontSize: 12, fontWeight: '700', color: color.onInk, letterSpacing: 2 },
  content: {
    ...t.body,
    color: color.ink,
    padding: space.md,
    lineHeight: 22,
  },
  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  locText: { ...t.small, color: color.mute },
  engRow: {
    flexDirection: 'row',
    gap: space.lg,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  engItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  engText: { ...t.small, color: color.mute },
});

const rb = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: space.xl,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: `${color.signal}12`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
    textAlign: 'center',
  },
  sub: {
    fontSize: 13,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 18,
  },
  undoBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.signal,
  },
  undoLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: color.signal,
  },
});

const ov = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 34,
    paddingTop: space.sm,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 14 },
  rowLabel: { ...t.body, color: color.ink, fontSize: 15 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.haze },
});
