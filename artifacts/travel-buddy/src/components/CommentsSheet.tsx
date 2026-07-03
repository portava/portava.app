/**
 * CommentsSheet — bottom-sheet modal for viewing and adding comments.
 *
 * - Loads root comments when opened (replies excluded from main list)
 * - Sticky input at the bottom, keyboard-aware
 * - Optimistically appends new comment while waiting for server
 * - Comment like / unlike
 * - Threaded one-level replies: tap "Reply" → input shows "Replying to @name"
 *   → submit posts reply via backend; new reply appended immediately to thread
 * - Replies lazy-loaded per comment, toggle open/closed
 * - Reply deletion wired to backend (same delete endpoint as comment)
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
import { router } from 'expo-router';
import { X, SendHorizonal, Trash2, Heart, CornerDownRight } from 'lucide-react-native';
import { ProfilePreviewCard } from './ProfilePreviewCard';
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
  listReplies,
  addReply,
  type EngagementComment,
  type EngagementReply,
} from '../services/postEngagement';
import { RichText } from './RichText';
import { useSession } from '../context/SessionContext';

const AuthorPressCtx = React.createContext<(handle: string) => void>(() => {});

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
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size * 0.38, fontWeight: '700', color: color.onInk }}>{initials}</Text>
    </View>
  );
}

function CommentAvatar({ uri, name, size = 32 }: { uri?: string | null; name: string; size?: number }) {
  const [imgErr, setImgErr] = useState(false);
  if (uri && !imgErr) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.haze }}
        onError={() => setImgErr(true)}
      />
    );
  }
  return <AvatarFallback name={name} size={size} />;
}

interface ReplyThreadProps {
  replies: EngagementReply[];
  loaded: boolean;
  open: boolean;
  loading: boolean;
  postId: string;
  onToggle: () => void;
  onDelete: (id: string) => void;
  onLikeChange: (id: string, likedByMe: boolean, likeCount: number) => void;
}

function ReplyThread({ replies, loaded, open, loading, postId, onToggle, onDelete, onLikeChange }: ReplyThreadProps) {
  const { userId: currentUserId } = useSession();

  return (
    <View>
      {/* Toggle button */}
      {(!loaded || replies.length > 0 || loading) && (
        <Pressable style={s.repliesToggle} onPress={onToggle} hitSlop={4}>
          {loading ? (
            <ActivityIndicator size="small" color={color.signal} />
          ) : (
            <Text style={s.repliesToggleText}>
              {!loaded
                ? 'View replies'
                : open
                ? 'Hide replies'
                : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
            </Text>
          )}
        </Pressable>
      )}

      {/* Inline reply list */}
      {open && replies.length > 0 && (
        <View style={s.repliesContainer}>
          {replies.map((r) => {
            const likedByMe = r.likedByMe ?? false;
            const likeCount = r.likeCount ?? 0;
            return (
              <ReplyRow
                key={r.id}
                reply={r}
                postId={postId}
                onDelete={onDelete}
                onLikeChange={onLikeChange}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}

function ReplyRow({
  reply,
  postId,
  onDelete,
  onLikeChange,
}: {
  reply: EngagementReply;
  postId: string;
  onDelete: (id: string) => void;
  onLikeChange: (id: string, likedByMe: boolean, likeCount: number) => void;
}) {
  const [liking, setLiking] = useState(false);
  const { userId: currentUserId } = useSession();
  const onAuthorPress = React.useContext(AuthorPressCtx);
  const likedByMe = reply.likedByMe ?? false;
  const likeCount = reply.likeCount ?? 0;

  const handleLike = useCallback(async () => {
    if (liking) return;
    setLiking(true);
    const wasLiked = likedByMe;
    const prevCount = likeCount;
    onLikeChange(reply.id, !wasLiked, wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1);
    try {
      const result = wasLiked
        ? await unlikeComment(postId, reply.id)
        : await likeComment(postId, reply.id);
      if (result) onLikeChange(reply.id, result.likedByMe, result.likeCount);
      else onLikeChange(reply.id, wasLiked, prevCount);
    } finally {
      setLiking(false);
    }
  }, [liking, likedByMe, likeCount, reply.id, postId, onLikeChange]);

  return (
    <View style={s.replyRow}>
      <CornerDownRight size={12} color={color.faint} style={s.replyIcon} />
      <CommentAvatar uri={reply.author.avatarUrl} name={reply.author.name} size={24} />
      <View style={s.commentBody}>
        <View style={s.commentMeta}>
          <Pressable onPress={() => onAuthorPress(reply.author.handle)} hitSlop={4}>
            <Text style={s.commentAuthor}>{reply.author.name}</Text>
          </Pressable>
          <Text style={s.commentTime}>{timeAgo(reply.createdAt)}</Text>
        </View>
        <RichText
          content={reply.body}
          tags={reply.tags}
          hashtagUsages={reply.hashtagUsages}
          currentUserId={currentUserId ?? undefined}
          style={s.commentText}
        />
      </View>
      <View style={s.commentActions}>
        <Pressable hitSlop={8} onPress={handleLike} disabled={liking} style={s.likeBtn}>
          <Heart size={12} color={likedByMe ? color.signal : color.faint} fill={likedByMe ? color.signal : 'transparent'} />
          {likeCount > 0 && <Text style={[s.likeCount, likedByMe && s.likeCountActive]}>{likeCount}</Text>}
        </Pressable>
        {reply.canDelete && (
          <Pressable
            hitSlop={8}
            onPress={() =>
              Alert.alert('Delete reply?', 'This cannot be undone.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => onDelete(reply.id) },
              ])
            }
            style={s.deleteBtn}
          >
            <Trash2 size={12} color={color.faint} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function CommentItem({
  comment,
  postId,
  replies,
  repliesLoaded,
  repliesOpen,
  repliesLoading,
  onDelete,
  onLikeChange,
  onReply,
  onLoadReplies,
  onToggleReplies,
  onReplyDelete,
  onReplyLikeChange,
}: {
  comment: EngagementComment;
  postId: string;
  replies: EngagementReply[];
  repliesLoaded: boolean;
  repliesOpen: boolean;
  repliesLoading: boolean;
  onDelete: (id: string) => void;
  onLikeChange: (id: string, likedByMe: boolean, likeCount: number) => void;
  onReply: (commentId: string, authorName: string) => void;
  onLoadReplies: (commentId: string) => void;
  onToggleReplies: (commentId: string) => void;
  onReplyDelete: (commentId: string, replyId: string) => void;
  onReplyLikeChange: (commentId: string, replyId: string, likedByMe: boolean, likeCount: number) => void;
}) {
  const [liking, setLiking] = useState(false);
  const { userId: currentUserId } = useSession();
  const onAuthorPress = React.useContext(AuthorPressCtx);
  const likedByMe = comment.likedByMe ?? false;
  const likeCount = comment.likeCount ?? 0;

  const handleLike = useCallback(async () => {
    if (liking) return;
    setLiking(true);
    const wasLiked = likedByMe;
    const prevCount = likeCount;
    onLikeChange(comment.id, !wasLiked, wasLiked ? Math.max(0, prevCount - 1) : prevCount + 1);
    try {
      const result = wasLiked
        ? await unlikeComment(postId, comment.id)
        : await likeComment(postId, comment.id);
      if (result) onLikeChange(comment.id, result.likedByMe, result.likeCount);
      else onLikeChange(comment.id, wasLiked, prevCount);
    } finally {
      setLiking(false);
    }
  }, [liking, likedByMe, likeCount, comment.id, postId, onLikeChange]);

  const handleToggle = useCallback(() => {
    if (!repliesLoaded) {
      onLoadReplies(comment.id);
    } else {
      onToggleReplies(comment.id);
    }
  }, [repliesLoaded, comment.id, onLoadReplies, onToggleReplies]);

  return (
    <View>
      <View style={s.commentRow}>
        <CommentAvatar uri={comment.author.avatarUrl} name={comment.author.name} size={32} />
        <View style={s.commentBody}>
          <View style={s.commentMeta}>
            <Pressable onPress={() => onAuthorPress(comment.author.handle)} hitSlop={4}>
              <Text style={s.commentAuthor}>{comment.author.name}</Text>
            </Pressable>
            <Text style={s.commentTime}>{timeAgo(comment.createdAt)}</Text>
          </View>
          <RichText
            content={comment.body}
            tags={comment.tags}
            hashtagUsages={comment.hashtagUsages}
            currentUserId={currentUserId ?? undefined}
            style={s.commentText}
          />
          <Pressable hitSlop={6} onPress={() => onReply(comment.id, comment.author.name)} style={s.replyBtn}>
            <Text style={s.replyBtnText}>Reply</Text>
          </Pressable>
        </View>
        <View style={s.commentActions}>
          <Pressable hitSlop={8} onPress={handleLike} disabled={liking} style={s.likeBtn}>
            <Heart size={13} color={likedByMe ? color.signal : color.faint} fill={likedByMe ? color.signal : 'transparent'} />
            {likeCount > 0 && <Text style={[s.likeCount, likedByMe && s.likeCountActive]}>{likeCount}</Text>}
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

      <ReplyThread
        replies={replies}
        loaded={repliesLoaded}
        open={repliesOpen}
        loading={repliesLoading}
        postId={postId}
        onToggle={handleToggle}
        onDelete={(replyId) => onReplyDelete(comment.id, replyId)}
        onLikeChange={(replyId, liked, count) => onReplyLikeChange(comment.id, replyId, liked, count)}
      />
    </View>
  );
}

// ── Inline comments section (for embedding in a ScrollView, e.g. post detail) ─

interface SectionProps {
  postId: string;
  onCountChange: (n: number) => void;
}

export function CommentsSection({ postId, onCountChange }: SectionProps) {
  const [comments, setComments] = useState<EngagementComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [commentsDisabled, setCommentsDisabled] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<{ id: string; authorName: string } | null>(null);
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);

  const [repliesMap, setRepliesMap] = useState<Record<string, EngagementReply[]>>({});
  const [repliesLoaded, setRepliesLoaded] = useState<Set<string>>(new Set());
  const [repliesOpen, setRepliesOpen] = useState<Set<string>>(new Set());
  const [repliesLoading, setRepliesLoading] = useState<Set<string>>(new Set());

  const [previewHandle, setPreviewHandle] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await listComments(postId);
    setComments(data);
    setLoading(false);
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLoadReplies = useCallback(async (commentId: string) => {
    setRepliesLoading((prev) => new Set(prev).add(commentId));
    const data = await listReplies(postId, commentId);
    setRepliesMap((prev) => ({ ...prev, [commentId]: data }));
    setRepliesLoaded((prev) => new Set(prev).add(commentId));
    setRepliesOpen((prev) => new Set(prev).add(commentId));
    setRepliesLoading((prev) => { const s = new Set(prev); s.delete(commentId); return s; });
  }, [postId]);

  const handleToggleReplies = useCallback((commentId: string) => {
    setRepliesOpen((prev) => {
      const s = new Set(prev);
      if (s.has(commentId)) s.delete(commentId);
      else s.add(commentId);
      return s;
    });
  }, []);

  const handleReplyDelete = useCallback(async (commentId: string, replyId: string) => {
    setRepliesMap((prev) => ({
      ...prev,
      [commentId]: (prev[commentId] ?? []).filter((r) => r.id !== replyId),
    }));
    const result = await deleteComment(postId, replyId);
    if (!result) {
      handleLoadReplies(commentId);
      Alert.alert('Error', 'Could not delete reply. Please try again.');
    }
  }, [postId, handleLoadReplies]);

  const handleReplyLikeChange = useCallback(
    (commentId: string, replyId: string, likedByMe: boolean, likeCount: number) => {
      setRepliesMap((prev) => ({
        ...prev,
        [commentId]: (prev[commentId] ?? []).map((r) =>
          r.id === replyId ? { ...r, likedByMe, likeCount } : r,
        ),
      }));
    },
    [],
  );

  const handleReply = useCallback((commentId: string, authorName: string) => {
    setReplyingTo({ id: commentId, authorName });
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    if (trimmed.length > 1000) {
      Alert.alert('Too long', 'Comments must be 1000 characters or fewer.');
      return;
    }
    setSubmitting(true);

    if (replyingTo) {
      const result = await addReply(postId, replyingTo.id, trimmed);
      if (result && 'reply' in result) {
        setText('');
        const parentId = replyingTo.id;
        setReplyingTo(null);
        setRepliesMap((prev) => ({
          ...prev,
          [parentId]: [...(prev[parentId] ?? []), result.reply],
        }));
        setRepliesLoaded((prev) => new Set(prev).add(parentId));
        setRepliesOpen((prev) => new Set(prev).add(parentId));
      } else if (result && 'error' in result) {
        if (result.error === 'comments_disabled') {
          setCommentsDisabled(true);
          Alert.alert('Comments disabled', 'The author has turned off comments on this post.');
        } else {
          Alert.alert('Comments limited', 'Only certain people can comment on this post.');
        }
      } else {
        Alert.alert('Could not post reply', 'Please try again.');
      }
    } else {
      const result = await addComment(postId, trimmed);
      if (result && 'comment' in result) {
        setText('');
        setComments((prev) => [...prev, result.comment]);
        onCountChange(result.commentCount);
      } else if (result && 'error' in result) {
        if (result.error === 'comments_disabled') {
          setCommentsDisabled(true);
          Alert.alert('Comments disabled', 'The author has turned off comments on this post.');
        } else {
          Alert.alert('Comments limited', 'Only certain people can comment on this post.');
        }
      } else {
        Alert.alert('Could not post comment', 'Please try again.');
      }
    }

    setSubmitting(false);
  }, [text, submitting, postId, replyingTo, onCountChange]);

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
        prev.map((c) => (c.id === id ? { ...c, likedByMe, likeCount } : c)),
      );
    },
    [],
  );

  const inputPlaceholder = replyingTo ? `Reply to ${replyingTo.authorName}…` : 'Add a comment…';

  return (
    <AuthorPressCtx.Provider value={setPreviewHandle}>
      <View style={sec.wrap}>
        {loading ? (
          <View style={sec.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : comments.length === 0 ? (
          <View style={sec.center}>
            <Text style={sec.empty}>No comments yet. Start the conversation.</Text>
          </View>
        ) : (
          <View style={sec.list}>
            {comments.map((item) => (
              <CommentItem
                key={item.id}
                comment={item}
                postId={postId}
                replies={repliesMap[item.id] ?? []}
                repliesLoaded={repliesLoaded.has(item.id)}
                repliesOpen={repliesOpen.has(item.id)}
                repliesLoading={repliesLoading.has(item.id)}
                onDelete={handleDelete}
                onLikeChange={handleLikeChange}
                onReply={handleReply}
                onLoadReplies={handleLoadReplies}
                onToggleReplies={handleToggleReplies}
                onReplyDelete={handleReplyDelete}
                onReplyLikeChange={handleReplyLikeChange}
              />
            ))}
          </View>
        )}

        {commentsDisabled && (
          <View style={s.disabledBanner}>
            <Text style={s.disabledText}>Comments have been turned off.</Text>
          </View>
        )}

        {replyingTo && (
          <View style={s.replyContext}>
            <Text style={s.replyContextText} numberOfLines={1}>
              Replying to {replyingTo.authorName}
            </Text>
            <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
              <X size={14} color={color.faint} />
            </Pressable>
          </View>
        )}

        <MentionSuggestionList
          suggestions={mentionSuggestions}
          loading={mentionLoading}
          visible={mentionVisible}
          onSelect={(sg) => mentionRef.current?.insertTag(sg)}
        />

        {!commentsDisabled && (
          <View style={s.inputRow}>
            <MentionInput
              ref={mentionRef}
              style={s.input}
              value={text}
              onChangeText={setText}
              placeholder={inputPlaceholder}
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

      <ProfilePreviewCard
        username={previewHandle}
        visible={previewHandle !== null}
        onClose={() => setPreviewHandle(null)}
      />
    </AuthorPressCtx.Provider>
  );
}

// ── Modal sheet wrapper ───────────────────────────────────────────────────────

export function CommentsSheet({ visible, postId, onClose, onCountChange }: Props) {
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<EngagementComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [commentsDisabled, setCommentsDisabled] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<{ id: string; authorName: string } | null>(null);
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);

  // Lifted reply state: keyed by parent comment id
  const [repliesMap, setRepliesMap] = useState<Record<string, EngagementReply[]>>({});
  const [repliesLoaded, setRepliesLoaded] = useState<Set<string>>(new Set());
  const [repliesOpen, setRepliesOpen] = useState<Set<string>>(new Set());
  const [repliesLoading, setRepliesLoading] = useState<Set<string>>(new Set());

  const [previewHandle, setPreviewHandle] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await listComments(postId);
    setComments(data);
    setLoading(false);
  }, [postId]);

  useEffect(() => {
    if (visible) {
      setCommentsDisabled(false);
      setReplyingTo(null);
      setRepliesMap({});
      setRepliesLoaded(new Set());
      setRepliesOpen(new Set());
      setRepliesLoading(new Set());
      load();
      setText('');
    }
  }, [visible, load]);

  const handleLoadReplies = useCallback(async (commentId: string) => {
    setRepliesLoading((prev) => new Set(prev).add(commentId));
    const data = await listReplies(postId, commentId);
    setRepliesMap((prev) => ({ ...prev, [commentId]: data }));
    setRepliesLoaded((prev) => new Set(prev).add(commentId));
    setRepliesOpen((prev) => new Set(prev).add(commentId));
    setRepliesLoading((prev) => { const s = new Set(prev); s.delete(commentId); return s; });
  }, [postId]);

  const handleToggleReplies = useCallback((commentId: string) => {
    setRepliesOpen((prev) => {
      const s = new Set(prev);
      if (s.has(commentId)) s.delete(commentId);
      else s.add(commentId);
      return s;
    });
  }, []);

  const handleReplyDelete = useCallback(async (commentId: string, replyId: string) => {
    // Optimistic: remove from UI immediately
    setRepliesMap((prev) => ({
      ...prev,
      [commentId]: (prev[commentId] ?? []).filter((r) => r.id !== replyId),
    }));
    // Persist to server — use same delete endpoint (reply is just a comment with parent)
    const result = await deleteComment(postId, replyId);
    if (!result) {
      // Rollback on failure — reload replies
      handleLoadReplies(commentId);
      Alert.alert('Error', 'Could not delete reply. Please try again.');
    }
  }, [postId, handleLoadReplies]);

  const handleReplyLikeChange = useCallback(
    (commentId: string, replyId: string, likedByMe: boolean, likeCount: number) => {
      setRepliesMap((prev) => ({
        ...prev,
        [commentId]: (prev[commentId] ?? []).map((r) =>
          r.id === replyId ? { ...r, likedByMe, likeCount } : r,
        ),
      }));
    },
    [],
  );

  const handleReply = useCallback((commentId: string, authorName: string) => {
    setReplyingTo({ id: commentId, authorName });
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    if (trimmed.length > 1000) {
      Alert.alert('Too long', 'Comments must be 1000 characters or fewer.');
      return;
    }
    setSubmitting(true);

    if (replyingTo) {
      const result = await addReply(postId, replyingTo.id, trimmed);
      if (result && 'reply' in result) {
        setText('');
        const parentId = replyingTo.id;
        setReplyingTo(null);
        // Append new reply immediately to the thread; open the thread if needed
        setRepliesMap((prev) => ({
          ...prev,
          [parentId]: [...(prev[parentId] ?? []), result.reply],
        }));
        setRepliesLoaded((prev) => new Set(prev).add(parentId));
        setRepliesOpen((prev) => new Set(prev).add(parentId));
      } else if (result && 'error' in result) {
        if (result.error === 'comments_disabled') {
          setCommentsDisabled(true);
          Alert.alert('Comments disabled', 'The author has turned off comments on this post.');
        } else {
          Alert.alert('Comments limited', 'Only certain people can comment on this post.');
        }
      } else {
        Alert.alert('Could not post reply', 'Please try again.');
      }
    } else {
      const result = await addComment(postId, trimmed);
      if (result && 'comment' in result) {
        setText('');
        setComments((prev) => [...prev, result.comment]);
        onCountChange(result.commentCount);
      } else if (result && 'error' in result) {
        if (result.error === 'comments_disabled') {
          setCommentsDisabled(true);
          Alert.alert('Comments disabled', 'The author has turned off comments on this post.');
        } else {
          Alert.alert('Comments limited', 'Only certain people can comment on this post.');
        }
      } else {
        Alert.alert('Could not post comment', 'Please try again.');
      }
    }

    setSubmitting(false);
  }, [text, submitting, postId, replyingTo, onCountChange]);

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
        prev.map((c) => (c.id === id ? { ...c, likedByMe, likeCount } : c)),
      );
    },
    [],
  );

  const inputPlaceholder = replyingTo ? `Reply to ${replyingTo.authorName}…` : 'Add a comment…';

  return (
    <AuthorPressCtx.Provider value={setPreviewHandle}>
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
                  replies={repliesMap[item.id] ?? []}
                  repliesLoaded={repliesLoaded.has(item.id)}
                  repliesOpen={repliesOpen.has(item.id)}
                  repliesLoading={repliesLoading.has(item.id)}
                  onDelete={handleDelete}
                  onLikeChange={handleLikeChange}
                  onReply={handleReply}
                  onLoadReplies={handleLoadReplies}
                  onToggleReplies={handleToggleReplies}
                  onReplyDelete={handleReplyDelete}
                  onReplyLikeChange={handleReplyLikeChange}
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

          {/* Reply context bar */}
          {replyingTo && (
            <View style={s.replyContext}>
              <Text style={s.replyContextText} numberOfLines={1}>
                Replying to {replyingTo.authorName}
              </Text>
              <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
                <X size={14} color={color.faint} />
              </Pressable>
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
                placeholder={inputPlaceholder}
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
    <ProfilePreviewCard
      username={previewHandle}
      visible={previewHandle !== null}
      onClose={() => setPreviewHandle(null)}
    />
    </AuthorPressCtx.Provider>
  );
}

const sec = StyleSheet.create({
  wrap: { gap: space.md },
  center: { alignItems: 'center', paddingVertical: space.xl },
  empty: { fontSize: 14, color: color.faint, textAlign: 'center' },
  list: { gap: space.lg },
});

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheetWrapper: { flex: 1, justifyContent: 'flex-end' },
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
  title: { fontSize: 16, fontWeight: '700', color: color.ink },
  list: { flex: 1 },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.lg,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.xxxl },
  empty: { fontSize: 14, color: color.faint, textAlign: 'center', paddingHorizontal: space.xl },
  disabledBanner: {
    backgroundColor: color.haze,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  disabledText: { fontSize: 13, color: color.mute, fontStyle: 'italic' },
  replyContext: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  replyContextText: { fontSize: 12, color: color.faint, fontStyle: 'italic', flex: 1, marginRight: space.sm },
  commentRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  replyRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', paddingLeft: space.md, marginTop: space.xs },
  replyIcon: { marginTop: 6 },
  commentBody: { flex: 1, gap: 3 },
  commentMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  commentAuthor: { fontSize: 13, fontWeight: '700', color: color.ink },
  commentTime: { fontSize: 11, color: color.faint },
  commentText: { fontSize: 14, color: color.ink, lineHeight: 20 },
  replyBtn: { alignSelf: 'flex-start', marginTop: 3 },
  replyBtnText: { fontSize: 12, fontWeight: '600', color: color.faint },
  commentActions: { flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 2 },
  likeBtn: { alignItems: 'center', gap: 2, paddingHorizontal: 4 },
  likeCount: { fontSize: 10, fontWeight: '700', color: color.faint },
  likeCountActive: { color: color.signal },
  deleteBtn: { paddingLeft: space.xs },
  repliesToggle: { marginLeft: 44, paddingVertical: 4, alignSelf: 'flex-start' },
  repliesToggleText: { fontSize: 12, fontWeight: '600', color: color.deep },
  repliesContainer: { marginLeft: space.sm, gap: space.md, marginTop: space.xs },
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
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: color.haze },
});
