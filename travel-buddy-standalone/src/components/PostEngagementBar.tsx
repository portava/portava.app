/**
 * PostEngagementBar — Like / Reaction / Comment / Share actions for a post card.
 *
 * Manages its own like and reaction state.
 * Opens CommentsSheet, ShareSheet, ReactionPicker, and EngagementUserListSheet as local Modals.
 *
 * Tapping the like count opens the likers sheet (who liked this post).
 * Tapping a reaction emoji chip opens the reaction likers sheet (filtered by emoji).
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { Heart, MessageCircle, Share2, Smile } from 'lucide-react-native';
import { color, space, layout } from '../theme/tokens';
import {
  likePost,
  unlikePost,
  getReactions,
  reactToPost,
  removeReaction,
  recordShare,
  type ReactionCount,
} from '../services/postEngagement';
import { getLiked, setLiked } from '../services/likedPostsCache';
import { useSession } from '../context/SessionContext';
import { CommentsSheet } from './CommentsSheet';
import { ShareSheet, type ShareTarget } from './ShareSheet';
import { ReactionPicker, ReactionSummary } from './ReactionPicker';
import { EngagementUserListSheet } from './EngagementUserListSheet.tsx';

interface Props {
  postId: string;
  likeCount: number;
  commentCount: number;
  shareCount?: number;
  likedByMe: boolean;
  canLike?: boolean;
  canComment?: boolean;
  canShare?: boolean;
  sharingDisabled?: boolean;
  onCommentCountChange?: (n: number) => void;
}

export function PostEngagementBar({
  postId,
  likeCount,
  commentCount,
  likedByMe,
  canLike = true,
  canComment = true,
  canShare = true,
  sharingDisabled = false,
  onCommentCountChange,
}: Props) {
  const { userId } = useSession();

  // Use the cache value when available — it reflects the user's explicit
  // like/unlike action from earlier in this session, overriding stale feed
  // data that may not have refreshed yet after a re-mount.  Falls back to
  // the feed-data prop (always server-authoritative) when no cache entry
  // exists for this post.
  const cachedLiked = userId ? getLiked(userId, postId) : undefined;
  const [localLiked, setLocalLiked] = useState(cachedLiked ?? likedByMe);
  const [localLikeCount, setLocalLikeCount] = useState(likeCount);

  // Track whether the user has explicitly tapped like/unlike this session so
  // incoming prop changes (feed refresh) or async preload cache updates don't
  // overwrite their deliberate action.
  const hasInteracted = useRef(false);

  // Sync localLiked when the feed refreshes new data (likedByMe prop changes).
  // Prefer cache if available (user interacted earlier this session); otherwise
  // accept the fresh server value.  Skip if the user has already tapped in
  // the current component instance — their action takes precedence.
  useEffect(() => {
    if (hasInteracted.current) return;
    const cached = userId ? getLiked(userId, postId) : undefined;
    setLocalLiked(cached ?? likedByMe);
  }, [likedByMe, userId, postId]);
  const [localCommentCount, setLocalCommentCount] = useState(commentCount);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [liking, setLiking] = useState(false);

  const [reactions, setReactions] = useState<ReactionCount[]>([]);
  const [myReaction, setMyReaction] = useState<string | null>(null);
  const [reactionsFetched, setReactionsFetched] = useState(false);

  // likerSheet: null = closed, { emoji: undefined } = post likes, { emoji: '❤️' } = specific reaction
  const [likerSheet, setLikerSheet] = useState<{ emoji?: string } | null>(null);

  const fetchReactions = useCallback(async () => {
    if (reactionsFetched) return;
    const data = await getReactions(postId);
    if (data) {
      setReactions(data.reactions);
      setMyReaction(data.myReaction);
    }
    setReactionsFetched(true);
  }, [postId, reactionsFetched]);

  useEffect(() => {
    fetchReactions();
  }, [fetchReactions]);

  const handleLike = useCallback(async () => {
    if (liking) return;
    setLiking(true);

    const wasLiked = localLiked;
    const prevCount = localLikeCount;

    // Optimistically update UI and cache so re-mounts during the API call
    // (e.g. navigation back) already show the correct state.
    hasInteracted.current = true;
    const optimisticLiked = !wasLiked;
    setLocalLiked(optimisticLiked);
    setLocalLikeCount(wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1);
    if (userId) setLiked(userId, postId, optimisticLiked);

    try {
      const result = wasLiked ? await unlikePost(postId) : await likePost(postId);
      if (result) {
        setLocalLiked(result.likedByMe);
        setLocalLikeCount(result.likeCount);
        // Confirm the definitive server state in the cache.
        if (userId) setLiked(userId, postId, result.likedByMe);
      } else {
        setLocalLiked(wasLiked);
        setLocalLikeCount(prevCount);
        // Revert the cache to the pre-tap state on failure.
        if (userId) setLiked(userId, postId, wasLiked);
        Alert.alert('Could not update like', 'Please try again.');
      }
    } finally {
      setLiking(false);
    }
  }, [liking, localLiked, localLikeCount, postId, userId]);

  const handleCommentCountChange = useCallback(
    (n: number) => {
      setLocalCommentCount(n);
      onCommentCountChange?.(n);
    },
    [onCommentCountChange],
  );

  const handleOpenPicker = useCallback(async () => {
    if (!reactionsFetched) {
      const data = await getReactions(postId);
      if (data) {
        setReactions(data.reactions);
        setMyReaction(data.myReaction);
      }
      setReactionsFetched(true);
    }
    setPickerOpen(true);
  }, [postId, reactionsFetched]);

  const handleReact = useCallback(
    async (emoji: string) => {
      const prevReactions = reactions;
      const prevMyReaction = myReaction;

      setMyReaction(emoji);
      setReactions((r) => {
        const withoutOld = r.filter((x) => x.emoji !== prevMyReaction);
        const existing = withoutOld.find((x) => x.emoji === emoji);
        if (existing) {
          return withoutOld.map((x) =>
            x.emoji === emoji ? { ...x, count: x.count + 1 } : x,
          );
        }
        return [...withoutOld, { emoji, count: 1 }];
      });

      const result = await reactToPost(postId, emoji);
      if (result) {
        setReactions(result.reactions);
        setMyReaction(result.myReaction);
      } else {
        setReactions(prevReactions);
        setMyReaction(prevMyReaction);
      }
    },
    [postId, reactions, myReaction],
  );

  const handleRemoveReaction = useCallback(async () => {
    const prevReactions = reactions;
    const prevMyReaction = myReaction;
    const removedEmoji = myReaction;
    setMyReaction(null);
    if (removedEmoji) {
      setReactions((r) =>
        r
          .map((x) =>
            x.emoji === removedEmoji ? { ...x, count: Math.max(0, x.count - 1) } : x,
          )
          .filter((x) => x.count > 0),
      );
    }

    const result = await removeReaction(postId);
    if (result) {
      setReactions(result.reactions);
      setMyReaction(result.myReaction);
    } else {
      setReactions(prevReactions);
      setMyReaction(prevMyReaction);
    }
  }, [postId, reactions, myReaction]);

  const handleShare = useCallback(() => {
    if (sharingDisabled) {
      Alert.alert('Sharing disabled', 'The author has disabled sharing on this post.');
      return;
    }
    setShareOpen(true);
  }, [sharingDisabled]);

  if (!canLike && !canComment && !canShare) return null;

  const totalReactions = reactions.reduce((sum, r) => sum + r.count, 0);

  return (
    <>
      <View style={s.container}>
        <View style={s.bar}>
          {canLike && (
            <View style={s.likeGroup}>
              <Pressable
                style={s.iconBtn}
                onPress={handleLike}
                onLongPress={() => setLikerSheet({})}
                hitSlop={layout.hitSlop}
                disabled={liking}
              >
                <Heart
                  size={17}
                  color={localLiked ? color.signal : color.mute}
                  fill={localLiked ? color.signal : 'transparent'}
                />
              </Pressable>
              {localLikeCount > 0 ? (
                <Pressable
                  onPress={() => setLikerSheet({})}
                  hitSlop={6}
                  style={s.countBtn}
                >
                  <Text style={[s.count, localLiked && s.countActive]}>
                    {localLikeCount}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}

          <Pressable
            style={s.action}
            onPress={handleOpenPicker}
            hitSlop={layout.hitSlop}
          >
            <Smile
              size={17}
              color={myReaction ? color.signal : color.mute}
            />
            {totalReactions > 0 && (
              <Text style={[s.count, myReaction ? s.countActive : null]}>
                {totalReactions}
              </Text>
            )}
          </Pressable>

          {canComment && (
            <Pressable
              style={s.action}
              onPress={() => setCommentsOpen(true)}
              hitSlop={layout.hitSlop}
            >
              <MessageCircle size={17} color={color.mute} />
              <Text style={s.count}>
                {localCommentCount > 0 ? localCommentCount : ''}
              </Text>
            </Pressable>
          )}

          {canShare && (
            <Pressable
              style={s.action}
              onPress={handleShare}
              hitSlop={layout.hitSlop}
            >
              <Share2 size={17} color={sharingDisabled ? color.haze : color.mute} />
            </Pressable>
          )}
        </View>

        {reactions.length > 0 && (
          <ReactionSummary
            reactions={reactions}
            myReaction={myReaction}
            onPress={handleOpenPicker}
            onChipPress={(emoji) => setLikerSheet({ emoji })}
          />
        )}
      </View>

      <CommentsSheet
        visible={commentsOpen}
        postId={postId}
        onClose={() => setCommentsOpen(false)}
        onCountChange={handleCommentCountChange}
      />
      <ShareSheet
        visible={shareOpen}
        postId={postId}
        onClose={() => setShareOpen(false)}
        onShareSuccess={(target: ShareTarget) => recordShare(postId, target)}
      />
      <ReactionPicker
        visible={pickerOpen}
        myReaction={myReaction}
        onSelect={handleReact}
        onRemove={handleRemoveReaction}
        onClose={() => setPickerOpen(false)}
      />

      {likerSheet !== null && (
        <EngagementUserListSheet
          visible
          targetType={likerSheet.emoji ? 'post_reaction' : 'post_like'}
          targetId={postId}
          reactionType={likerSheet.emoji}
          title={likerSheet.emoji ? `${likerSheet.emoji} Reactions` : 'Liked by'}
          initialTotal={likerSheet.emoji ? undefined : localLikeCount}
          onClose={() => setLikerSheet(null)}
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  container: {
    gap: 6,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingTop: 2,
  },
  likeGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
  },
  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 24,
    minHeight: 36,
  },
  countBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
    minWidth: 36,
    justifyContent: 'center',
  },
  count: {
    fontSize: 13,
    fontWeight: '600',
    color: color.mute,
    minWidth: 16,
  },
  countActive: {
    color: color.signal,
  },
});
