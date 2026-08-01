/**
 * Pure (zero-React, zero-native) logic for the circle_status_card tap handler
 * in the messages thread screen.
 *
 * Extracted so the routing decision can be tested with node:test without
 * pulling in React, React Native, expo-router, or any native module.
 *
 * The screen calls `resolveCircleCardNav(...)` and executes the returned action
 * with `router.push` / `Alert.alert`, keeping the component free of untestable
 * if-branching.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Possible results of tapping a circle_status_card. */
export type CircleCardNavAction =
  /** Circle-type thread: navigate to the Circle screen. */
  | { action: 'push-circle' }
  /** Trip/event thread where the viewer is confirmed a member: open Circle presence. */
  | {
      action: 'push-presence';
      contextType: 'trip' | 'event';
      contextId: string;
      contextLabel: string;
    }
  /** Trip/event thread where membership is confirmed false: show informational alert. */
  | { action: 'alert'; title: string; message: string }
  /** Trip/event thread where membership is still being checked (null/undefined): wait silently. */
  | { action: 'loading' }
  /** No Circle context (direct thread, etc.): do nothing. */
  | { action: 'noop' };

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * Determine what should happen when a circle_status_card is tapped.
 *
 * @param threadType     The type string of the current thread ('circle' | 'trip' | 'event' | …).
 * @param contextId      The trip / event id associated with the thread (if any).
 * @param isCircleMember Whether the current viewer is a Circle member for this thread's context.
 *                       `null` means the membership check is still loading (→ silent noop).
 * @param contextLabel   Display label for the context (e.g. destination city or thread title).
 */
export function resolveCircleCardNav(
  threadType: string | null | undefined,
  contextId: string | null | undefined,
  isCircleMember: boolean | null | undefined,
  contextLabel: string | null | undefined,
): CircleCardNavAction {
  // Circle-type thread: go straight to the Circle screen.
  if (threadType === 'circle') {
    return { action: 'push-circle' };
  }

  // Trip / event threads only.
  const ctxType: 'trip' | 'event' | null =
    threadType === 'trip' ? 'trip' : threadType === 'event' ? 'event' : null;

  if (!ctxType || !contextId) {
    return { action: 'noop' };
  }

  if (isCircleMember === true) {
    return {
      action: 'push-presence',
      contextType: ctxType,
      contextId,
      contextLabel: contextLabel ?? 'Circle',
    };
  }

  // Membership check still in-flight (null / undefined) → wait silently, do not alert.
  if (isCircleMember == null) {
    return { action: 'loading' };
  }

  // Membership explicitly false → fail-closed alert.
  return {
    action: 'alert',
    title: 'Circle members only',
    message: 'Only Circle members can view the live presence for this group.',
  };
}
