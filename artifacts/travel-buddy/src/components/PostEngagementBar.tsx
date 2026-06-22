/**
 * PostEngagementBar — Like / Comment / Share actions for a post card.
 *
 * Manages its own like optimistic state. Opens CommentsSheet and ShareSheet
 * as local Modals (invisible when closed, no perf impact in the feed).
 */
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { Heart, MessageCircle, Share2 } from 'lucide-react-native';
import { color, space, layout } from '../theme/tokens';
import { likePost, unlikePost } from '../services/postEngagement';
import { CommentsSheet } from './CommentsSheet';
import { ShareSheet } from './ShareSheet';

interface Props {
  postId: string;
  likeCount: number;
  commentCount: number;
  shareCount?: number;
  likedByMe: boolean;
  canLike?: boolean;
  canComment?: boolean;
  canShare?: boolean;
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
  onCommentCountChange,
}: Props) {
  const [localLiked, setLocalLiked] = useState(likedByMe);
  const [localLikeCount, setLocalLikeCount] = useState(likeCount);
  const [localCommentCount, setLocalCommentCount] = useState(commentCount);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [liking, setLiking] = useState(false);

  if (!canLike && !canComment && !canShare) return null;

  const handleLike = useCallback(async () => {
    if (liking) return;
    setLiking(true);

    // Optimistic update
    const wasLiked = localLiked;
    const prevCount = localLikeCount;
    setLocalLiked(!wasLiked);
    setLocalLikeCount(wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1);

    try {
      const result = wasLiked ? await unlikePost(postId) : await likePost(postId);
      if (result) {
        // Sync with server truth
        setLocalLiked(result.likedByMe);
        setLocalLikeCount(result.likeCount);
      } else {
        // Roll back on failure
        setLocalLiked(wasLiked);
        setLocalLikeCount(prevCount);
        Alert.alert('Could not update like', 'Please try again.');
      }
    } finally {
      setLiking(false);
    }
  }, [liking, localLiked, localLikeCount, postId]);

  const handleCommentCountChange = useCallback(
    (n: number) => {
      setLocalCommentCount(n);
      onCommentCountChange?.(n);
    },
    [onCommentCountChange],
  );

  return (
    <>
      <View style={s.bar}>
        <Pressable
          style={s.action}
          onPress={handleLike}
          hitSlop={layout.hitSlop}
          disabled={liking}
        >
          <Heart
            size={17}
            color={localLiked ? color.signal : color.mute}
            fill={localLiked ? color.signal : 'transparent'}
          />
          <Text style={[s.count, localLiked && s.countLiked]}>
            {localLikeCount > 0 ? localLikeCount : ''}
          </Text>
        </Pressable>

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

        <Pressable
          style={s.action}
          onPress={() => setShareOpen(true)}
          hitSlop={layout.hitSlop}
        >
          <Share2 size={17} color={color.mute} />
        </Pressable>
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
      />
    </>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingTop: 2,
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
  countLiked: {
    color: color.signal,
  },
});
