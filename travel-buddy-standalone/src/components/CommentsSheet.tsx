/**
 * CommentsSheet — bottom-sheet modal for viewing and adding comments.
 *
 * - Loads comments when opened
 * - Sticky input at the bottom, keyboard-aware
 * - Optimistically appends new comment while waiting for server
 * - Comment like / unlike
 * - Handles comments_disabled error gracefully
 * - Safe-area aware; does not clash with bottom nav
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, SendHorizonal, Trash2, Heart } from 'lucide-react-native';
import { color, space, radius, shadow } from '../theme/tokens';
import { MentionInput, type MentionInputHandle } from './MentionInput';
import { MentionSuggestionList } from './MentionSuggestionList';
import type { AnyMentionSuggestion } from '../services/tagging';
import {
  listComments,
  addComment,
  deleteComment,
  likeComment,
  unlikeComment,
  type EngagementComment,
} from '../services/postEngagement';
import { RichText } from './RichText';
import { useSession } from '../context/SessionContext';

interface Props {
  visible: boolean;
  postId: string;
  onClose: () => void;
  onCountChange: (n: number) => void;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function AvatarFallback({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color.deep,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.38, fontWeight: '700', color: color.onInk }}>
        {initials}
      </Text>
    </View>
  );
}

function CommentItem({
  comment,
  postId,
  onDelete,
  onLikeChange,
}: {
  comment: EngagementComment;
  postId: string;
  onDelete: (id: string) => void;
  onLikeChange: (id: string, likedByMe: boolean, likeCount: number) => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  const [liking, setLiking] = useState(false);
  const { userId: currentUserId } = useSession();

  const handleLike = useCallback(async () => {
    if (liking) return;
    setLiking(true);
    const wasLiked = comment.likedByMe ?? false;
    const prevCount = comment.likeCount ?? 0;

    onLikeChange(comment.id, !wasLiked, wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1);

    try {
      const result = wasLiked
        ? await unlikeComment(postId, comment.id)
        : await likeComment(postId, comment.id);
      if (result) {
        onLikeChange(comment.id, result.likedByMe, result.likeCount);
      } else {
        onLikeChange(comment.id, wasLiked, prevCount);
      }
    } finally {
      setLiking(false);
    }
  }, [liking, comment, postId, onLikeChange]);

  const likedByMe = comment.likedByMe ?? false;
  const likeCount = comment.likeCount ?? 0;

  return (
    <View style={s.commentRow}>
      {comment.author.avatarUrl && !imgErr ? (
        <Image
          source={{ uri: comment.author.avatarUrl }}
          style={s.avatar}
          onError={() => setImgErr(true)}
        />
      ) : (
        <AvatarFallback name={comment.author.name} size={32} />
      )}
      <View style={s.commentBody}>
        <View style={s.commentMeta}>
          <Text style={s.commentAuthor}>{comment.author.name}</Text>
          <Text style={s.commentTime}>{timeAgo(comment.createdAt)}</Text>
        </View>
        <RichText
          content={comment.body}
          tags={comment.tags}
          hashtagUsages={comment.hashtagUsages}
          currentUserId={currentUserId ?? undefined}
          style={s.commentText}
        />
      </View>
      <View style={s.commentActions}>
        <Pressable
          hitSlop={8}
          onPress={handleLike}
          disabled={liking}
          style={s.likeBtn}
        >
          <Heart
            size={13}
            color={likedByMe ? color.signal : color.faint}
            fill={likedByMe ? color.signal : 'transparent'}
          />
          {likeCount > 0 && (
            <Text style={[s.likeCount, likedByMe && s.likeCountActive]}>
              {likeCount}
            </Text>
          )}
        </Pressable>
        {comment.canDelete && (
          <Pressable
            hitSlop={8}
            onPress={() =>
              Alert.alert('Delete comment?', 'This cannot be undone.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => onDelete(comment.id) },
              ])
            }
            style={s.deleteBtn}
          >
            <Trash2 size={13} color={color.faint} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function CommentsSheet({ visible, postId, onClose, onCountChange }: Props) {
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<EngagementComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [commentsDisabled, setCommentsDisabled] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await listComments(postId);
    setComments(data);
    setLoading(false);
  }, [postId]);

  useEffect(() => {
    if (visible) {
      setCommentsDisabled(false);
      load();
      setText('');
    }
  }, [visible, load]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    if (trimmed.length > 1000) {
      Alert.alert('Too long', 'Comments must be 1000 characters or fewer.');
      return;
    }
    setSubmitting(true);
    const result = await addComment(postId, trimmed);
    if (result && 'comment' in result) {
      setText('');
      setComments((prev) => [...prev, result.comment]);
      onCountChange(result.commentCount);
    } else if (result && 'error' in result) {
      if (result.error === 'comments_disabled') {
        setCommentsDisabled(true);
        Alert.alert('Comments disabled', 'The author has turned off comments on this post.');
      } else if (result.error === 'comments_limited') {
        Alert.alert('Comments limited', 'Only certain people can comment on this post.');
      }
    } else {
      Alert.alert('Could not post comment', 'Please try again.');
    }
    setSubmitting(false);
  }, [text, submitting, postId, onCountChange]);

  const handleDelete = useCallback(
    async (commentId: string) => {
      const result = await deleteComment(postId, commentId);
      if (result) {
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        onCountChange(result.commentCount);
      }
    },
    [postId, onCountChange],
  );

  const handleLikeChange = useCallback(
    (id: string, likedByMe: boolean, likeCount: number) => {
      setComments((prev) =>
        prev.map((c) => c.id === id ? { ...c, likedByMe, likeCount } : c),
      );
    },
    [],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={s.sheetWrapper}
        keyboardVerticalOffset={0}
      >
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.sm }]}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>Comments</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <X size={20} color={color.ink} />
            </Pressable>
          </View>

          {/* Comments list */}
          {loading ? (
            <View style={s.center}>
              <ActivityIndicator color={color.signal} />
            </View>
          ) : (
            <FlatList
              data={comments}
              keyExtractor={(c) => c.id}
              renderItem={({ item }) => (
                <CommentItem
                  comment={item}
                  postId={postId}
                  onDelete={handleDelete}
                  onLikeChange={handleLikeChange}
                />
              )}
              ListEmptyComponent={
                <View style={s.center}>
                  <Text style={s.empty}>No comments yet. Start the conversation.</Text>
                </View>
              }
              contentContainerStyle={s.listContent}
              showsVerticalScrollIndicator={false}
              style={s.list}
              keyboardShouldPersistTaps="handled"
            />
          )}

          {/* Disabled banner */}
          {commentsDisabled && (
            <View style={s.disabledBanner}>
              <Text style={s.disabledText}>Comments have been turned off.</Text>
            </View>
          )}

          {/* Mention suggestions — above input row */}
          <MentionSuggestionList
            suggestions={mentionSuggestions}
            loading={mentionLoading}
            visible={mentionVisible}
            onSelect={(sg) => mentionRef.current?.insertTag(sg)}
          />

          {/* Input row */}
          {!commentsDisabled && (
            <View style={s.inputRow}>
              <MentionInput
                ref={mentionRef}
                style={s.input}
                value={text}
                onChangeText={setText}
                placeholder="Add a comment…"
                placeholderTextColor={color.faint}
                multiline
                maxLength={1000}
                returnKeyType="default"
                blurOnSubmit={false}
                surface="comment"
                onSuggestionsChange={(items, isLoading, trigger) => {
                  setMentionSuggestions(items);
                  setMentionLoading(isLoading);
                  setMentionVisible(!!trigger && (items.length > 0 || isLoading));
                }}
              />
              <Pressable
                style={[s.sendBtn, (!text.trim() || submitting) && s.sendBtnDisabled]}
                onPress={handleSubmit}
                disabled={!text.trim() || submitting}
                hitSlop={8}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={color.onInk} />
                ) : (
                  <SendHorizonal size={18} color={color.onInk} />
                )}
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheetWrapper: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '88%',
    minHeight: 320,
    ...shadow.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  list: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xxxl,
  },
  empty: {
    fontSize: 14,
    color: color.faint,
    textAlign: 'center',
    paddingHorizontal: space.xl,
  },
  disabledBanner: {
    backgroundColor: color.haze,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  disabledText: {
    fontSize: 13,
    color: color.mute,
    fontStyle: 'italic',
  },
  commentRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.haze,
  },
  commentBody: {
    flex: 1,
    gap: 3,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: '700',
    color: color.ink,
  },
  commentTime: {
    fontSize: 11,
    color: color.faint,
  },
  commentText: {
    fontSize: 14,
    color: color.ink,
    lineHeight: 20,
  },
  commentActions: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    paddingTop: 2,
  },
  likeBtn: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  likeCount: {
    fontSize: 10,
    fontWeight: '700',
    color: color.faint,
  },
  likeCountActive: {
    color: color.signal,
  },
  deleteBtn: {
    paddingLeft: space.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderWidth: 1.5,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 14,
    color: color.ink,
    backgroundColor: color.paper,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: color.haze,
  },
});
