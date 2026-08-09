/**
 * EngagementUserListSheet — reusable bottom sheet showing who liked / reacted to content.
 *
 * Works for posts, comments, highlights, memories, reactions.
 * Supports cursor-based pagination and an inline follow button per row.
 *
 * Usage:
 *   <EngagementUserListSheet
 *     visible={likerSheetOpen}
 *     targetType="post_like"
 *     targetId={postId}
 *     title="Liked by"
 *     onClose={() => setLikerSheetOpen(false)}
 *   />
 *
 *   // For a specific reaction emoji:
 *   <EngagementUserListSheet
 *     visible={reactionSheetOpen}
 *     targetType="post_reaction"
 *     targetId={postId}
 *     reactionType="❤️"
 *     title="❤️ Reactions"
 *     onClose={() => setReactionSheetOpen(false)}
 *   />
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { closeThenNavigate } from '../lib/deferredNavigate.ts';
import { X } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import { VerifiedStamp } from './ui/VerifiedStamp.tsx';
import { getLikers, type LikeTargetType, type LikerUser } from '../services/engagementLikers.ts';
import { followUser, unfollowUser } from '../services/follows.ts';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity.ts';

// ── Liker row ─────────────────────────────────────────────────────────────────

interface LikerRowProps {
  user: LikerUser;
  onClose: () => void;
}

function LikerRow({ user, onClose }: LikerRowProps) {
  const [isFollowing, setIsFollowing] = useState(user.isFollowing);
  const [toggling, setToggling] = useState(false);

  async function handleToggle() {
    if (toggling) return;
    const was = isFollowing;
    setToggling(true);
    setIsFollowing(!was);
    const res = was ? await unfollowUser(user.id) : await followUser(user.id);
    if (!res.ok) setIsFollowing(was);
    setToggling(false);
  }

  function handlePress() {
    if (!user.handle) return;
    // BUG CC/CD fix: defer navigation until after the sheet close animation.
    closeThenNavigate(onClose, `/u/${user.handle}`);
  }

  return (
    <Pressable style={s.row} onPress={handlePress} android_ripple={{ color: color.haze }}>
      <Avatar
        uri={user.avatarUrl}
        name={primaryIdentityText({ displayName: user.displayName, handle: user.handle }).replace(/^@/, '')}
        size={AVATAR_SIZE}
      />

      <View style={s.info}>
        <View style={s.nameRow}>
          <Text style={s.name} numberOfLines={1}>{primaryIdentityText({ displayName: user.displayName, handle: user.handle })}</Text>
          {user.verified ? <VerifiedStamp size="sm" /> : null}
        </View>
        <View style={s.handleRow}>
          {secondaryIdentityText({ displayName: user.displayName, handle: user.handle }) ? <Text style={s.handle} numberOfLines={1}>{secondaryIdentityText({ displayName: user.displayName, handle: user.handle })}</Text> : null}
          {user.followsYou && !isFollowing && (
            <View style={s.followsYouBadge}>
              <Text style={s.followsYouText}>Follows you</Text>
            </View>
          )}
        </View>
      </View>

      <Pressable
        style={[s.followBtn, isFollowing && s.followingBtn]}
        onPress={handleToggle}
        disabled={toggling}
        hitSlop={4}
      >
        {toggling ? (
          <ActivityIndicator
            size="small"
            color={isFollowing ? color.mute : color.onInk}
          />
        ) : isFollowing ? (
          <Text style={s.followingText}>Following</Text>
        ) : (
          <Text style={s.followText}>
            {user.followsYou ? 'Follow back' : 'Follow'}
          </Text>
        )}
      </Pressable>
    </Pressable>
  );
}

// ── Main sheet ────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  targetType: LikeTargetType;
  targetId: string;
  title?: string;
  reactionType?: string;
  /** Caller-provided count displayed in the sheet title (e.g. post.like_count).
   *  Omitting it shows just the title without a count. */
  initialTotal?: number;
  onClose: () => void;
}

export function EngagementUserListSheet({
  visible,
  targetType,
  targetId,
  title,
  reactionType,
  initialTotal,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const [users, setUsers] = useState<LikerUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const reset = useCallback(() => {
    setUsers([]);
    setNextCursor(null);
    setHasMore(false);
    setError(false);
  }, []);

  const loadFirst = useCallback(async () => {
    if (!targetId) return;
    setLoading(true);
    setError(false);
    const page = await getLikers(targetType, targetId, { reactionType });
    if (page) {
      setUsers(page.users);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } else {
      setError(true);
    }
    setLoading(false);
  }, [targetType, targetId, reactionType]);

  useEffect(() => {
    if (visible) {
      reset();
      loadFirst();
    }
  }, [visible, targetType, targetId, reactionType]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    const page = await getLikers(targetType, targetId, { reactionType, cursor: nextCursor });
    if (page) {
      setUsers((prev) => [...prev, ...page.users]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }
    setLoadingMore(false);
  }, [hasMore, nextCursor, loadingMore, targetType, targetId, reactionType]);

  const displayTitle = title ?? (targetType === 'post_reaction' ? 'Reactions' : 'Likes');
  const titleWithCount =
    initialTotal !== undefined && initialTotal > 0
      ? `${displayTitle} · ${initialTotal}`
      : displayTitle;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={s.grab} />

        <View style={s.head}>
          <Text style={s.title}>{titleWithCount}</Text>
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.center}>
            <ActivityIndicator size="small" color={color.signal} />
          </View>
        ) : error ? (
          <View style={s.center}>
            <Text style={s.emptyText}>Couldn't load. Tap to retry.</Text>
            <Pressable style={s.retryBtn} onPress={loadFirst}>
              <Text style={s.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : users.length === 0 ? (
          <View style={s.center}>
            <Text style={s.emptyText}>No results yet.</Text>
          </View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <LikerRow user={item} onClose={onClose} />}
            contentContainerStyle={s.list}
            showsVerticalScrollIndicator={false}
            onEndReached={loadMore}
            onEndReachedThreshold={0.3}
            ListFooterComponent={
              loadingMore ? (
                <ActivityIndicator
                  size="small"
                  color={color.signal}
                  style={{ paddingVertical: 12 }}
                />
              ) : null
            }
          />
        )}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const AVATAR_SIZE = 42;

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.4)',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '72%',
    ...shadow.float,
  },
  grab: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginTop: 10,
    marginBottom: 4,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    flex: 1,
    ...t.heading,
    color: color.ink,
    fontSize: 16,
  },
  closeBtn: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  center: {
    padding: space.xxl,
    alignItems: 'center',
    gap: space.md,
  },
  emptyText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  list: {
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.md,
  },
  nameRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 3 },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  handle: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
  },
  followsYouBadge: {
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  followsYouText: {
    fontSize: 10,
    fontWeight: '600',
    color: color.mute,
  },
  followBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
    minWidth: 82,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followingBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: color.haze,
  },
  followText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 13,
  },
  followingText: {
    ...t.bodyStrong,
    color: color.mute,
    fontSize: 13,
  },
});
