/**
 * UserIdentityLink — universal "tap identity → navigate to profile" wrapper.
 *
 * This component owns the UX invariant: see a person → tap → open profile.
 * Every rendered user identity (avatar, name, card, sender row, etc.) that is
 * not already handled by UserAvatarButton or UserNameButton should be wrapped
 * with this component.
 *
 * Audit performed: 2026-07-21
 * Total identity surfaces found: 12
 *   Already interactive (UserAvatarButton/UserNameButton/inline router.push): 5
 *     • PulseFeedCard.AuthorRow (inline handleAuthorPress on avatar + name Pressable)
 *     • TravelerRow (UserAvatarButton + UserNameButton)
 *     • CommentsSheet (AuthorPressCtx → router.push per comment/reply)
 *     • EngagementUserListSheet (full-row Pressable → router.push)
 *     • SearchResultCard (UserAvatarButton)
 *   Wrapped by this task: 7
 *     • StoryViewer — header author avatar + name
 *     • StoryViewer — viewers-list avatar + name rows
 *     • GroupChatScreen — message-sender avatar in each non-mine bubble
 *     • CrewMemberCard — avatar + name area
 *     • PostCardMessage — author avatar + name row
 *     • HighlightViewer — top-row author avatar + name
 *     • TelegraphInboxScreen — RequestCard sender avatar + name
 *
 * Usage:
 *   <UserIdentityLink userId={user.id} handle={user.handle} currentUserId={me}>
 *     <Image ... />
 *     <Text>{user.name}</Text>
 *   </UserIdentityLink>
 *
 * Nested action buttons (Follow, Like, Menu) should call e.stopPropagation()
 * inside their onPress handler to avoid triggering profile navigation:
 *   <Pressable onPress={(e) => { e.stopPropagation(); doFollow(); }}>
 */
import React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';

export interface UserIdentityLinkProps {
  /** The profile owner's UUID. Pass '' when unavailable (disables block check). */
  userId: string;
  /** Handle without leading @. Null/undefined → press is a no-op. */
  handle: string | null | undefined;
  /** Not used for routing but kept for future a11y label. */
  displayName?: string | null | undefined;
  /** The currently signed-in user's UUID. Self-taps route to own Passport. */
  currentUserId?: string | null;
  /** Suppress all navigation (render children with no interaction layer). */
  disabled?: boolean;
  /**
   * Style applied to the Pressable wrapper. Use when the parent layout
   * requires specific flex direction (e.g. flexDirection:'row' for horizontal
   * identity areas that would otherwise stack vertically).
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: React.ReactNode;
}

/**
 * Helper for nested action buttons.
 * Call inside the nested button's onPress to stop the tap bubbling to the
 * parent UserIdentityLink:
 *
 *   <Pressable onPress={(e) => { stopPropagation(e); doAction(); }}>
 */
export function stopPropagation(e: { stopPropagation?: () => void }) {
  e.stopPropagation?.();
}

export function UserIdentityLink({
  userId,
  handle,
  currentUserId,
  disabled,
  style,
  testID,
  children,
}: UserIdentityLinkProps) {
  const { blockedIds, blockerIds, isLoading } = useBlockedIds();

  // Blocked users still render (the parent component controls whether to show
  // the surface at all); navigation is silently suppressed, matching the
  // UserAvatarButton / UserNameButton pattern.
  const isBlocked =
    userId ? (blockedIds.has(userId) || blockerIds.has(userId)) : false;

  function handlePress() {
    if (disabled || isBlocked || !handle) return;
    // If the block list is still loading, navigate anyway — the profile screen
    // itself enforces the block on arrival.
    try {
      if (userId && currentUserId && userId === currentUserId) {
        // Self-tap → own Passport tab
        router.push('/(tabs)/passport' as any);
      } else {
        router.push(`/u/${handle}` as any);
      }
    } catch {
      // Navigation errors are silently ignored so a bad route never crashes the UI.
    }
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled || !handle}
      testID={testID}
      style={style}
      // Ensure the pressable doesn't eat pointer events when children are interactive
      accessible={false}
    >
      {children}
    </Pressable>
  );
}
