/**
 * Keyboard-dismiss routing logic for CommentsSection / CommentsSheet.
 *
 * CommentsSection wraps all comment content in an outer Pressable whose sole
 * job is to dismiss the keyboard when the user taps an empty area.  Inner
 * Pressables (like, reply, send) handle their own taps; React Native's touch
 * system ensures the outer Pressable does NOT fire when an inner one does.
 *
 * RichText renders @mention and #hashtag spans as tappable <Text> nodes nested
 * inside the same outer Pressable.  In React Native, `onPress` on a nested
 * <Text> inside a <Pressable> does NOT bubble to the outer Pressable — the
 * Text element consumes the touch.  This module models that contract explicitly
 * so tests can assert that mention/hashtag taps never trigger keyboard dismiss.
 *
 * This module is a pure behavioral model of that routing contract, intended
 * for machine-layer testing without RNTL:
 *   - routeCommentAreaPress() models the dispatch that RN's Pressable nesting
 *     enforces at runtime — outer fires only on empty-area taps, inner handlers
 *     fire only for their own button.
 *   - buildCommentAreaHandlers() constructs the six independent handler closures
 *     and makes their separation explicit and assertable.
 *
 * NOTE: CommentsSection uses inline Pressable callbacks directly. This module
 * does NOT replace those callbacks; it models the same contract so tests can
 * verify the routing behavior without a React Native runtime.
 */

export interface CommentRouteHandlers {
  /** Attached to the outer Pressable (empty-area tap). */
  onOuterPress: () => void;
  /** Attached to a like button. */
  onLikePress: () => void;
  /** Attached to a reply button. */
  onReplyPress: () => void;
  /** Attached to the send button. */
  onSendPress: () => void;
  /**
   * Attached to a @mention span inside RichText.
   * Must be a distinct closure from onOuterPress so that tapping a mention
   * navigates the user rather than dismissing the keyboard.
   */
  onMentionPress: (handle: string) => void;
  /**
   * Attached to a #hashtag span inside RichText.
   * Must be a distinct closure from onOuterPress so that tapping a hashtag
   * navigates the user rather than dismissing the keyboard.
   */
  onHashtagPress: (slug: string) => void;
}

/**
 * Builds the six independent handlers used by CommentsSection / CommentsSheet.
 * The outer handler ONLY calls dismiss; inner handlers NEVER call dismiss.
 */
export function buildCommentAreaHandlers(deps: {
  dismiss: () => void;
  like: () => void;
  reply: () => void;
  send: () => void;
  mention: (handle: string) => void;
  hashtag: (slug: string) => void;
}): CommentRouteHandlers {
  return {
    onOuterPress:   () => deps.dismiss(),
    onLikePress:    () => deps.like(),
    onReplyPress:   () => deps.reply(),
    onSendPress:    () => deps.send(),
    onMentionPress: (handle) => deps.mention(handle),
    onHashtagPress: (slug)   => deps.hashtag(slug),
  };
}

/**
 * Models what happens when a touch reaches a specific target.
 * `target` is either "outer" (empty area) or one of the named inner actions.
 * In real RN, inner Pressables / Text onPress handlers consume the event so
 * the outer Pressable never fires; this function enforces the same contract in
 * pure JS for testing.
 */
export function routeCommentAreaPress(
  target: 'outer' | 'like' | 'reply' | 'send' | 'mention' | 'hashtag',
  handlers: CommentRouteHandlers,
  payload?: string,
): void {
  switch (target) {
    case 'outer':
      handlers.onOuterPress();
      break;
    case 'like':
      handlers.onLikePress();
      break;
    case 'reply':
      handlers.onReplyPress();
      break;
    case 'send':
      handlers.onSendPress();
      break;
    case 'mention':
      handlers.onMentionPress(payload ?? '');
      break;
    case 'hashtag':
      handlers.onHashtagPress(payload ?? '');
      break;
  }
}
