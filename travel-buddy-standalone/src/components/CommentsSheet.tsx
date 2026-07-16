/**
 * CommentsSheet — peek-to-full animated bottom sheet for post comments.
 *
 * Behaviour:
 *   • Opens at ~48 % screen height so the post stays visible above the sheet.
 *   • Scrolling down in the comment list smoothly expands the sheet to full-screen.
 *   • Scrolling back to the top collapses the sheet back to peek height.
 *   • Tapping the keyboard focuses the input and auto-expands to fill the
 *     space above the keyboard; dismissing the keyboard restores full height.
 *   • Tapping the backdrop or pressing X / back animates the sheet closed.
 *   • Pressing the handle bar collapses (if expanded) or closes (if at peek).
 *   • On tablets (width > 600) the sheet is centred with a 560 px max-width.
 *
 * All comment data logic, like/reply/delete/mention wiring, and CommentsSection
 * are completely preserved.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  FlatList,
  StyleSheet,
  Keyboard,
  Platform,
  Image,
  ActivityIndicator,
  Alert,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, SendHorizonal, Trash2, Heart, CornerDownRight } from 'lucide-react-native';
import { ProfilePreviewCard } from './ProfilePreviewCard.tsx';
import { color, space, radius, shadow } from '../theme/tokens.ts';
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';
import { MentionSuggestionList } from './MentionSuggestionList.tsx';
import type { AnyMentionSuggestion } from '../services/tagging.ts';
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
} from '../services/postEngagement.ts';
import { RichText } from './RichText.tsx';
import { useSession } from '../context/SessionContext.tsx';
import { computeOptimisticLike } from '../lib/commentLikeLogic.ts';
import { createSubmitGuard } from '../lib/commentSubmitGuard.ts';
import { createLikeToggleGuard } from '../lib/likeToggleGuard.ts';
import { EngagementUserListSheet } from './EngagementUserListSheet.tsx';
import { primaryIdentityText } from '../lib/displayIdentity.ts';

// ── Shared contexts ───────────────────────────────────────────────────────────

const AuthorPressCtx = React.createContext<(handle: string) => void>(() => {});

/**
 * Controls the hitSlop of like buttons.
 * Default (8) in the modal where vertical space is tight.
 * CommentsSection (inline) overrides to 12 for thumb comfort.
 */
const LikeHitSlopCtx = React.createContext<number>(8);

// ── Animated FlatList ─────────────────────────────────────────────────────────

// Reanimated 4's createAnimatedComponent prop types no longer surface FlatList
// props (e.g. onScroll), so re-assert the component as a FlatList that accepts
// a Reanimated scroll handler on onScroll.
type AnimatedFlatListType = React.ComponentType<
  Omit<React.ComponentProps<typeof FlatList>, 'onScroll'> & {
    onScroll?: ReturnType<typeof useAnimatedScrollHandler>;
  }
>;
const AnimFlatList = Animated.createAnimatedComponent(
  FlatList,
) as unknown as AnimatedFlatListType;

// Shared spring config for peek ↔ full transitions
const SHEET_SPRING = { damping: 26, stiffness: 240, mass: 0.85 } as const;

// ── Prop types ────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  postId: string;
  onClose: () => void;
  onCountChange: (n: number) => void;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function AvatarFallback({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .replace(/^@/, '')
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

// ── ReplyThread ───────────────────────────────────────────────────────────────

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
  return (
    <View>
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

      {open && replies.length > 0 && (
        <View style={s.repliesContainer}>
          {replies.map((r) => (
            <ReplyRow
              key={r.id}
              reply={r}
              postId={postId}
              onDelete={onDelete}
              onLikeChange={onLikeChange}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ── ReplyRow ──────────────────────────────────────────────────────────────────

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
  const likeHitSlop = React.useContext(LikeHitSlopCtx);
  const likedByMe = reply.likedByMe ?? false;
  const likeCount = reply.likeCount ?? 0;
  const likeGuardRef = useRef(createLikeToggleGuard());
  const [likerReplyId, setLikerReplyId] = useState<string | null>(null);

  const handleLike = useCallback(async () => {
    if (likeGuardRef.current.isToggling()) return;
    setLiking(true);
    const wasLiked = likedByMe;
    const prevCount = likeCount;
    const optimistic = computeOptimisticLike(wasLiked, prevCount);
    onLikeChange(reply.id, optimistic.likedByMe, optimistic.likeCount);
    try {
      await likeGuardRef.current.tryToggle(async () => {
        const result = wasLiked
          ? await unlikeComment(postId, reply.id)
          : await likeComment(postId, reply.id);
        if (result) onLikeChange(reply.id, result.likedByMe, result.likeCount);
        else onLikeChange(reply.id, wasLiked, prevCount);
      });
    } finally {
      setLiking(false);
    }
  }, [likedByMe, likeCount, reply.id, postId, onLikeChange]);

  return (
    <>
      <View style={s.replyRow}>
        <CornerDownRight size={12} color={color.faint} style={s.replyIcon} />
        <CommentAvatar uri={reply.author.avatarUrl} name={primaryIdentityText({ name: reply.author.name, handle: reply.author.handle })} size={24} />
        <View style={s.commentBody}>
          <View style={s.commentMeta}>
            <Pressable onPress={() => onAuthorPress(reply.author.handle)} hitSlop={4}>
              <Text style={s.commentAuthor}>{primaryIdentityText({ name: reply.author.name, handle: reply.author.handle })}</Text>
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
          <Pressable hitSlop={likeHitSlop} onPress={handleLike} disabled={liking} style={s.likeBtn}>
            <Heart size={12} color={likedByMe ? color.signal : color.faint} fill={likedByMe ? color.signal : 'transparent'} />
          </Pressable>
          {likeCount > 0 && (
            <Pressable onPress={() => setLikerReplyId(reply.id)} hitSlop={5} style={s.likeCountBtn}>
              <Text style={[s.likeCount, likedByMe && s.likeCountActive]}>{likeCount}</Text>
            </Pressable>
          )}
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
      {likerReplyId !== null && (
        <EngagementUserListSheet
          visible
          targetType="comment_like"
          targetId={likerReplyId}
          title="Liked by"
          initialTotal={likeCount}
          onClose={() => setLikerReplyId(null)}
        />
      )}
    </>
  );
}

// ── CommentItem ───────────────────────────────────────────────────────────────

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
  const likeHitSlop = React.useContext(LikeHitSlopCtx);
  const likedByMe = comment.likedByMe ?? false;
  const likeCount = comment.likeCount ?? 0;
  const likeGuardRef = useRef(createLikeToggleGuard());
  const [likerCommentId, setLikerCommentId] = useState<string | null>(null);

  const handleLike = useCallback(async () => {
    if (likeGuardRef.current.isToggling()) return;
    setLiking(true);
    const wasLiked = likedByMe;
    const prevCount = likeCount;
    const optimistic = computeOptimisticLike(wasLiked, prevCount);
    onLikeChange(comment.id, optimistic.likedByMe, optimistic.likeCount);
    try {
      await likeGuardRef.current.tryToggle(async () => {
        const result = wasLiked
          ? await unlikeComment(postId, comment.id)
          : await likeComment(postId, comment.id);
        if (result) onLikeChange(comment.id, result.likedByMe, result.likeCount);
        else onLikeChange(comment.id, wasLiked, prevCount);
      });
    } finally {
      setLiking(false);
    }
  }, [likedByMe, likeCount, comment.id, postId, onLikeChange]);

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
        <CommentAvatar uri={comment.author.avatarUrl} name={primaryIdentityText({ name: comment.author.name, handle: comment.author.handle })} size={32} />
        <View style={s.commentBody}>
          <View style={s.commentMeta}>
            <Pressable onPress={() => onAuthorPress(comment.author.handle)} hitSlop={4}>
              <Text style={s.commentAuthor}>{primaryIdentityText({ name: comment.author.name, handle: comment.author.handle })}</Text>
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
          <Pressable hitSlop={6} onPress={() => onReply(comment.id, primaryIdentityText({ name: comment.author.name, handle: comment.author.handle }))} style={s.replyBtn}>
            <Text style={s.replyBtnText}>Reply</Text>
          </Pressable>
        </View>
        <View style={s.commentActions}>
          <Pressable hitSlop={likeHitSlop} onPress={handleLike} disabled={liking} style={s.likeBtn}>
            <Heart size={13} color={likedByMe ? color.signal : color.faint} fill={likedByMe ? color.signal : 'transparent'} />
          </Pressable>
          {likeCount > 0 && (
            <Pressable onPress={() => setLikerCommentId(comment.id)} hitSlop={5} style={s.likeCountBtn}>
              <Text style={[s.likeCount, likedByMe && s.likeCountActive]}>{likeCount}</Text>
            </Pressable>
          )}
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
      {likerCommentId !== null && (
        <EngagementUserListSheet
          visible
          targetType="comment_like"
          targetId={likerCommentId}
          title="Liked by"
          initialTotal={likeCount}
          onClose={() => setLikerCommentId(null)}
        />
      )}
    </View>
  );
}

// ── CommentsSection — inline embed (post detail screen) ───────────────────────

interface SectionProps {
  postId: string;
  onCountChange: (n: number) => void;
  /** Called when the comment input receives focus. Use to scroll it into view. */
  onInputFocus?: () => void;
}

export function CommentsSection({ postId, onCountChange, onInputFocus }: SectionProps) {
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
  const submitGuardRef = useRef(createSubmitGuard());

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
    if (trimmed.length > 1000) {
      Alert.alert('Too long', 'Comments must be 1000 characters or fewer.');
      return;
    }
    if (!trimmed || submitGuardRef.current.isSubmitting()) return;
    setSubmitting(true);
    try {
      await submitGuardRef.current.trySubmit(text, async (t) => {
        if (replyingTo) {
          const result = await addReply(postId, replyingTo.id, t);
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
          const result = await addComment(postId, t);
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
      });
    } finally {
      setSubmitting(false);
    }
  }, [text, postId, replyingTo, onCountChange]);

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
    <LikeHitSlopCtx.Provider value={12}>
      <AuthorPressCtx.Provider value={setPreviewHandle}>
        <Pressable onPress={() => Keyboard.dismiss()} accessible={false}>
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
                  onFocus={onInputFocus}
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
        </Pressable>

        <ProfilePreviewCard
          username={previewHandle}
          visible={previewHandle !== null}
          onClose={() => setPreviewHandle(null)}
        />
      </AuthorPressCtx.Provider>
    </LikeHitSlopCtx.Provider>
  );
}

// ── CommentsSheet — peek-to-full animated bottom sheet ────────────────────────

export function CommentsSheet({ visible, postId, onClose, onCountChange }: Props) {
  const { height: SCREEN_H, width: SCREEN_W } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Height breakpoints — recomputed on rotation/resize
  const PEEK_H = Math.round(SCREEN_H * 0.48);
  const FULL_H = SCREEN_H - Math.max(insets.top, 20);
  const isWide = SCREEN_W > 600;

  // ── Reanimated shared values ────────────────────────────────────────────────
  const sheetH = useSharedValue(0);
  const backdropAlpha = useSharedValue(0);
  const kbOffset = useSharedValue(0);    // lifts sheet above keyboard
  const expanded = useSharedValue(false);

  // Sync height breakpoints into shared values for the scroll worklet
  const peekHSv = useSharedValue(PEEK_H);
  const fullHSv = useSharedValue(FULL_H);
  useEffect(() => { peekHSv.value = PEEK_H; }, [PEEK_H]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fullHSv.value = FULL_H; }, [FULL_H]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount flag — lets us animate out before unmounting the Modal ────────────
  const [mounted, setMounted] = useState(false);
  const isClosingRef = useRef(false);

  // ── Comment data state ──────────────────────────────────────────────────────
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
  const submitGuardRef = useRef(createSubmitGuard());

  // ── Load comments ───────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    const data = await listComments(postId);
    setComments(data);
    setLoading(false);
  }, [postId]);

  // ── Open: visible → mount → animate in ─────────────────────────────────────
  useEffect(() => {
    if (visible && !mounted) {
      isClosingRef.current = false;
      setMounted(true);
    }
  }, [visible, mounted]);

  useEffect(() => {
    if (!mounted) return;
    // Reset per-session state
    expanded.value = false;
    kbOffset.value = 0;
    sheetH.value = 0;
    backdropAlpha.value = 0;
    setCommentsDisabled(false);
    setReplyingTo(null);
    setRepliesMap({});
    setRepliesLoaded(new Set());
    setRepliesOpen(new Set());
    setRepliesLoading(new Set());
    setText('');
    load();
    // Slide up from bottom
    sheetH.value = withSpring(PEEK_H, SHEET_SPRING);
    backdropAlpha.value = withTiming(1, { duration: 280 });
  // PEEK_H is stable at mount time; intentionally excluded from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // ── Close: animate out → unmount ────────────────────────────────────────────
  const doClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    Keyboard.dismiss();
    kbOffset.value = withTiming(0, { duration: 160 });
    backdropAlpha.value = withTiming(0, { duration: 220 });
    sheetH.value = withTiming(0, { duration: 240 }, () => {
      runOnJS(setMounted)(false);
      runOnJS(onClose)();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // Stable ref so effects always call the latest doClose without re-subscribing
  const doCloseRef = useRef(doClose);
  useEffect(() => { doCloseRef.current = doClose; }, [doClose]);

  // Sync: if parent sets visible=false externally (e.g. navigating away)
  useEffect(() => {
    if (!visible && mounted && !isClosingRef.current) {
      doCloseRef.current();
    }
  }, [visible, mounted]);

  // ── Keyboard: lift sheet + fill available space while typing ────────────────
  useEffect(() => {
    if (!mounted) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onKbShow = Keyboard.addListener(showEvt, (e) => {
      const kb = e.endCoordinates.height;
      const dur = Platform.OS === 'ios' ? Math.min(e.duration ?? 250, 300) : 200;
      kbOffset.value = withTiming(kb, { duration: dur });
      // Shrink height so the sheet fits between status bar and keyboard
      sheetH.value = withTiming(SCREEN_H - Math.max(insets.top, 20) - kb, { duration: dur });
      expanded.value = true;
    });

    const onKbHide = Keyboard.addListener(hideEvt, (e) => {
      const dur = Platform.OS === 'ios' ? Math.min(e.duration ?? 250, 300) : 200;
      kbOffset.value = withTiming(0, { duration: dur });
      // Restore full-screen height so the list fills the space again
      sheetH.value = withTiming(fullHSv.value, { duration: dur });
      expanded.value = true;
    });

    return () => { onKbShow.remove(); onKbHide.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, SCREEN_H, insets.top]);

  // ── Scroll-driven expand / collapse ─────────────────────────────────────────
  // Runs entirely on the UI thread — no JS-bridge round-trip per frame.
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      'worklet';
      const y = event.contentOffset.y;
      if (y > 50 && !expanded.value) {
        expanded.value = true;
        sheetH.value = withSpring(fullHSv.value, SHEET_SPRING);
      } else if (y < 15 && expanded.value) {
        expanded.value = false;
        sheetH.value = withSpring(peekHSv.value, SHEET_SPRING);
      }
    },
  });

  // ── Reply / like / submit handlers ──────────────────────────────────────────
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
    if (trimmed.length > 1000) {
      Alert.alert('Too long', 'Comments must be 1000 characters or fewer.');
      return;
    }
    if (!trimmed || submitGuardRef.current.isSubmitting()) return;
    setSubmitting(true);
    try {
      await submitGuardRef.current.trySubmit(text, async (t) => {
        if (replyingTo) {
          const result = await addReply(postId, replyingTo.id, t);
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
          const result = await addComment(postId, t);
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
      });
    } finally {
      setSubmitting(false);
    }
  }, [text, postId, replyingTo, onCountChange]);

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

  // ── Animated styles ─────────────────────────────────────────────────────────
  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: backdropAlpha.value * 0.50,
  }));

  const sheetAnimStyle = useAnimatedStyle(() => ({
    height: sheetH.value,
    bottom: kbOffset.value,
  }));

  // Tablet: centre the sheet with rounded corners on all sides
  const sheetWideOverride: object | undefined = isWide
    ? {
        left: Math.max((SCREEN_W - 560) / 2, 0),
        right: Math.max((SCREEN_W - 560) / 2, 0),
        borderRadius: 20,
      }
    : undefined;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <AuthorPressCtx.Provider value={setPreviewHandle}>
      <Modal
        visible={mounted}
        transparent
        animationType="none"
        onRequestClose={doClose}
        statusBarTranslucent
      >
        {/*
         * Z-order (last child = on top):
         *   1. Dark backdrop  — visual only, pointerEvents="none"
         *   2. Backdrop Pressable — tap area above/beside the sheet to close
         *   3. Animated sheet — highest z-index, intercepts all touches in its area
         *      so backdrop Pressable never fires when user touches the sheet.
         */}

        {/* ① Visual backdrop */}
        <Animated.View
          style={[StyleSheet.absoluteFillObject, s.backdropFill, backdropAnimStyle]}
          pointerEvents="none"
        />

        {/* ② Tap-outside-to-close */}
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={doClose}
          accessible={false}
        />

        {/* ③ Animated sheet */}
        <Animated.View style={[s.sheet, sheetAnimStyle, sheetWideOverride]}>

          {/* Drag handle — tap to collapse (if expanded) or close (if at peek) */}
          <Pressable
            style={s.handleWrap}
            onPress={() => {
              if (expanded.value) {
                expanded.value = false;
                sheetH.value = withSpring(peekHSv.value, SHEET_SPRING);
              } else {
                doClose();
              }
            }}
            hitSlop={14}
            accessible={false}
          >
            <View style={s.handleBar} />
          </Pressable>

          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>Comments</Text>
            <Pressable onPress={doClose} hitSlop={10}>
              <X size={20} color={color.ink} />
            </Pressable>
          </View>

          {/* Comment list */}
          {loading ? (
            <View style={s.center}>
              <ActivityIndicator color={color.signal} />
            </View>
          ) : (
            <AnimFlatList
              onScroll={scrollHandler}
              scrollEventThrottle={16}
              data={comments}
              keyExtractor={(c: any) => c.id}
              renderItem={({ item }: any) => (
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
              keyboardDismissMode="interactive"
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

          {/* Mention suggestions — rendered above input row */}
          <MentionSuggestionList
            suggestions={mentionSuggestions}
            loading={mentionLoading}
            visible={mentionVisible}
            onSelect={(sg) => mentionRef.current?.insertTag(sg)}
          />

          {/* Input row — safe-area-aware bottom padding */}
          {!commentsDisabled && (
            <View style={[s.inputRow, { paddingBottom: insets.bottom > 0 ? insets.bottom : 8 }]}>
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
        </Animated.View>
      </Modal>

      <ProfilePreviewCard
        username={previewHandle}
        visible={previewHandle !== null}
        onClose={() => setPreviewHandle(null)}
      />
    </AuthorPressCtx.Provider>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sec = StyleSheet.create({
  wrap: { gap: space.md },
  center: { alignItems: 'center', paddingVertical: space.xl },
  empty: { fontSize: 14, color: color.faint, textAlign: 'center' },
  list: { gap: space.lg },
});

const s = StyleSheet.create({
  // ── Sheet chrome ─────────────────────────────────────────────────────────────
  backdropFill: { backgroundColor: color.deep },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    // `bottom` is driven at runtime by the `kbOffset` shared value
    bottom: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    ...shadow.card,
  },

  handleWrap: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: 4,
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

  // ── Shared comment / reply / input styles ─────────────────────────────────────
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
  likeCountBtn: { alignItems: 'center', paddingHorizontal: 4 },
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
