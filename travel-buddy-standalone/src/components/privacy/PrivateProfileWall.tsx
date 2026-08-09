/**
 * PrivateProfileWall — lock section shown when the viewer cannot access a
 * private profile.  Renders a minimal identity header (avatar initials,
 * display name, @handle) followed by the private-account badge, lock
 * message, and friend-request CTA.
 *
 * Never renders bio, location, stats, or tab content.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Lock } from 'lucide-react-native';
import { PrivateRequestButton } from '../ui/PrivateRequestButton.tsx';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';

/** Minimal safe fields from the private sentinel DTO. */
export interface PrivateProfilePreview {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface Props {
  profile: PrivateProfilePreview;
  friendRequestPending?: boolean;
  isOwnProfile?: boolean;
  /** Called after a successful Send Request so the parent can update its own UI state. */
  onRequestSent?: () => void;
}

/** First character of displayName, falling back to handle, uppercased. */
function getInitial(displayName: string | null, handle: string | null): string {
  const primary = displayName ?? handle ?? '?';
  return primary.charAt(0).toUpperCase();
}

export function PrivateProfileWall({
  profile,
  friendRequestPending = false,
  isOwnProfile = false,
  onRequestSent,
}: Props) {
  const { handle, displayName, avatarUrl } = profile;

  // Derive initials for the avatar fallback: prefer first char of display name,
  // fall back to first char of handle.
  const initial = getInitial(displayName, handle);

  return (
    <View style={s.container}>
      {/* Avatar — initials placeholder when no image URL is available */}
      {!avatarUrl ? (
        <View style={s.avatarPlaceholder}>
          <Text style={s.avatarInitial}>{initial}</Text>
        </View>
      ) : null}

      {/* Identity */}
      {displayName ? <Text style={s.displayName}>{displayName}</Text> : null}
      {handle ? <Text style={s.handle}>@{handle}</Text> : null}

      {/* Private-account badge */}
      <View style={s.privateBadge}>
        <Lock size={11} color={color.mute} />
        <Text style={s.privateBadgeText}>Private account</Text>
      </View>

      {/* Lock message */}
      <Text style={s.wallMessage}>
        {friendRequestPending
          ? 'Your request is pending. The owner must accept before you can view their Passport.'
          : 'Send a friend request to view this Passport.'}
      </Text>

      {!isOwnProfile ? (
        <PrivateRequestButton
          userId={profile.id}
          initialPending={friendRequestPending}
          onRequestSent={onRequestSent}
          style={s.cta}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingTop: space.lg,
    paddingBottom: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.md,
  },
  avatarPlaceholder: {
    width: avatar.xxxxl,
    height: avatar.xxxxl,
    borderRadius: avatar.xxxxl / 2,
    backgroundColor: color.haze,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  avatarInitial: {
    fontSize: 28,
    fontWeight: '600' as const,
    color: color.mute,
  },
  displayName: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 17,
    fontWeight: '600' as const,
    textAlign: 'center' as const,
  },
  handle: {
    ...t.small,
    color: color.mute,
    fontSize: 13,
    textAlign: 'center' as const,
  },
  privateBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 5,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: color.haze,
  },
  privateBadgeText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600' as const,
    fontSize: 12,
  },
  wallMessage: {
    ...t.body,
    color: color.mute,
    textAlign: 'center' as const,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 280,
  },
  cta: {
    marginTop: space.sm,
    minWidth: 200,
  },
});
