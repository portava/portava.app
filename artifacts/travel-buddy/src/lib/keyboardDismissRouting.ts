/**
 * Keyboard-dismiss routing logic for CommentsSection.
 *
 * CommentsSection wraps all comment content in an outer Pressable whose sole
 * job is to dismiss the keyboard when the user taps an empty area.  Inner
 * Pressables (like, reply, send) handle their own taps; React Native's touch
 * system ensures the outer Pressable does NOT fire when an inner one does.
 *
 * This module is a pure behavioral model of that routing contract, intended
 * for machine-layer testing without RNTL:
 *   - routeCommentAreaPress() models the dispatch that RN's Pressable nesting
 *     enforces at runtime — outer fires only on empty-area taps, inner handlers
 *     fire only for their own button.
 *   - buildCommentAreaHandlers() constructs the four independent handler closures
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
}

/**
 * Builds the four independent handlers used by CommentsSection.
 * The outer handler ONLY calls dismiss; inner handlers NEVER call dismiss.
 */
export function buildCommentAreaHandlers(deps: {
  dismiss: () => void;
  like: () => void;
  reply: () => void;
  send: () => void;
}): CommentRouteHandlers {
  return {
    onOuterPress: () => deps.dismiss(),
    onLikePress: () => deps.like(),
    onReplyPress: () => deps.reply(),
    onSendPress: () => deps.send(),
  };
}

/**
 * Models what happens when a touch reaches a specific target.
 * `target` is either "outer" (empty area) or one of the named inner buttons.
 * In real RN, inner Pressables consume the event so the outer never fires;
 * this function enforces the same contract in pure JS for testing.
 */
export function routeCommentAreaPress(
  target: 'outer' | 'like' | 'reply' | 'send',
  handlers: CommentRouteHandlers,
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
  }
}
