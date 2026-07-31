/**
 * PostEngagementBar — Stamp / Reaction / Comment / Share actions for a post card.
 *
 * Manages its own stamp and reaction state.
 * Opens CommentsSheet, ShareSheet, ReactionPicker as local Modals.
 *
 * Tapping the stamp count opens the stampers sheet (who stamped this post).
 * Tapping a reaction emoji chip opens the reaction likers sheet (filtered by emoji).
 * Tapping the save count (owner-only) opens PostSaversSheet showing who saved.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { MessageCircle, Smile, Bookmark } from 'lucide-react-native';
import { TelegraphSendIcon } from './icons/TelegraphSendIcon.tsx';
import { color, space, layout } from '../theme/tokens.ts';
import {
  getReactions,
  reactToPost,
  removeReaction,
  recordShare,
  type ReactionCount,
} from '../services/postEngagement.ts';
import { useSession } from '../context/SessionContext.tsx';
import { CommentsSheet } from './CommentsSheet.tsx';
import { ShareSheet, type ShareTarget } from './ShareSheet.tsx';
import { ReactionPicker, ReactionSummary } from './ReactionPicker.tsx';
import { EngagementUserListSheet } from './EngagementUserListSheet.tsx';
import { StampButton } from './stamps/StampButton.tsx';
import type { UseStampReturn } from '../hooks/useStamp.ts';
import { PostSaversSheet } from './PostSaversSheet.tsx';

interface Props {
  postId: string;
  stampCount?: number;
  commentCount: number;
  shareCount?: number;
  /** Displayed as a tappable chip when isOwner — opens who-saved list. */
  saveCount?: number;
  isStampedByViewer?: boolean;
  /** When true the save-count chip is tappable (opens PostSaversSheet). */
  isOwner?: boolean;
  canStamp?: boolean;
  canComment?: boolean;
  canShare?: boolean;
  sharingDisabled?: boolean;
  onCommentCountChange?: (n: number) => void;
  /**
   * Share a single useStamp instance with a card-level double-tap handler
   * instead of letting StampButton own a private one — keeps the button's
   * displayed count/state in sync with double-tap stamps. When provided,
   * `stampCount`/`isStampedByViewer` are ignored.
   */
  controlledStamp?: UseStampReturn;
  /** Forwarded to StampButton — see StampButtonProps.localBurst. */
  localBurst?: boolean;
  /** Forwarded to StampButton — see StampButtonProps.onLocalBurst. */
  onLocalBurst?: () => void;
}

export function PostEngagementBar({
  postId,
  stampCount = 0,
  commentCount,
  isStampedByViewer = false,
  saveCount = 0,
  isOwner = false,
  canStamp = true,
  canComment = true,
  canShare = true,
  sharingDisabled = false,
  onCommentCountChange,
  controlledStamp,
  localBurst = false,
  onLocalBurst,
}: Props) {
  const { userId } = useSession();

  const [localCommentCount, setLocalCommentCount] = useState(commentCount);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saversOpen, setSaversOpen] = useState(false);

  const [reactions, setReactions] = useState<ReactionCount[]>([]);
  const [myReaction, setMyReaction] = useState<string | null>(null);
  const [reactionsFetched, setReactionsFetched] = useState(false);

  // reactionLikerSheet: null = closed, { emoji: '❤️' } = specific reaction
  const [reactionLikerSheet, setReactionLikerSheet] = useState<{ emoji: string } | null>(null);

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

  if (!canStamp && !canComment && !canShare) return null;

  const totalReactions = reactions.reduce((sum, r) => sum + r.count, 0);

  return (
    <>
      <View style={s.container}>
        <View style={s.bar}>
          {canStamp && (
            <StampButton
              entityType="post"
              entityId={postId}
              initialCount={stampCount}
              initialIsStamped={isStampedByViewer}
              iconSize={17}
              style={s.stampBtnWrapper}
              controlledStamp={controlledStamp}
              localBurst={localBurst}
              onLocalBurst={onLocalBurst}
            />
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
              <TelegraphSendIcon size={17} color={sharingDisabled ? color.haze : color.mute} />
            </Pressable>
          )}

          {/* Save count chip — visible to everyone; tappable (opens who-saved) for owner only */}
          {saveCount > 0 && (
            <Pressable
              style={s.action}
              onPress={isOwner ? () => setSaversOpen(true) : undefined}
              hitSlop={layout.hitSlop}
              disabled={!isOwner}
            >
              <Bookmark size={17} color={color.mute} />
              <Text style={s.count}>{saveCount}</Text>
            </Pressable>
          )}
        </View>

        {reactions.length > 0 && (
          <ReactionSummary
            reactions={reactions}
            myReaction={myReaction}
            onPress={handleOpenPicker}
            onChipPress={(emoji) => setReactionLikerSheet({ emoji })}
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

      {reactionLikerSheet !== null && (
        <EngagementUserListSheet
          visible
          targetType="post_reaction"
          targetId={postId}
          reactionType={reactionLikerSheet.emoji}
          title={`${reactionLikerSheet.emoji} Reactions`}
          onClose={() => setReactionLikerSheet(null)}
        />
      )}

      <PostSaversSheet
        visible={saversOpen}
        postId={postId}
        onClose={() => setSaversOpen(false)}
      />
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
  stampBtnWrapper: {
    minHeight: 44,
    justifyContent: 'center',
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
