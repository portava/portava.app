/**
 * PrivateProfileWall — shared component for private-profile minimal views.
 *
 * Used whenever the API returns a private sentinel for a user whose passport
 * is not visible to the current viewer. Renders ONLY the safe minimum:
 * avatar (if present), display name, @handle, "Private account" badge, and
 * the relationship action button (Send Request / Request Sent).
 *
 * Deliberately does NOT render bio, home city, country, travel status, stats,
 * tabs, or any count — none of those fields are passed in the prop shape.
 */
import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Lock } from 'lucide-react-native';
import { PrivateRequestButton } from '../ui/PrivateRequestButton.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

/** Minimal safe fields from the private sentinel DTO. */
export interface PrivateProfilePreview {
  id: string;
  /** @handle — used for the @handle subline.  null when not yet resolved. */
  handle: string | null;
  /** Resolved display name (or null to fall back to handle). */
  displayName: string | null;
  /**
   * Avatar URL — rendered when non-null.  When null the component renders an
   * initials placeholder so the bio / location / other private fields are
   * never needed to produce a visually complete wall.
   */
  avatarUrl: string | null;
}

interface Props {
  profile: PrivateProfilePreview;
  /** True when the viewer already sent a friend request that is still pending. */
  friendRequestPending?: boolean;
  /** Hides the action button when the viewer is viewing their own (private) profile. */
  isOwnProfile?: boolean;
}

export function PrivateProfileWall({
  profile,
  friendRequestPending = false,
  isOwnProfile = false,
}: Props) {
  const primary = profile.displayName ?? profile.handle ?? 'User';
  const handleLine = profile.handle ? `@${profile.handle}` : null;
  const initial = primary[0]?.toUpperCase() ?? '?';

  return (
    <View style={s.container}>
      {/* Avatar — only rendered when avatarUrl is non-null; no private fallback data */}
      <View style={s.avatarWrap}>
        {profile.avatarUrl != null ? (
          <Image
            source={{ uri: profile.avatarUrl }}
            style={s.avatar}
            accessibilityLabel={`${primary} profile photo`}
          />
        ) : (
          <View style={[s.avatar, s.avatarFallback]}>
            <Text style={s.avatarInitials}>{initial}</Text>
          </View>
        )}
        {/* Lock overlay badge */}
        <View style={s.lockBadge} accessibilityLabel="Private account">
          <Lock size={11} color="#fff" />
        </View>
      </View>

      {/* Display name — no bio, no location, no counts */}
      <Text style={s.displayName} numberOfLines={1}>{primary}</Text>
      {handleLine ? (
        <Text style={s.handle} numberOfLines={1}>{handleLine}</Text>
      ) : null}

      {/* "Private account" indicator */}
      <View style={s.privateBadge}>
        <Lock size={11} color={color.mute} />
        <Text style={s.privateBadgeText}>Private account</Text>
      </View>

      {/* Wall message */}
      <Text style={s.wallMessage}>
        {friendRequestPending
          ? 'Your request is pending. The owner must accept before you can view their Passport.'
          : 'Send a friend request to view this Passport.'}
      </Text>

      {/* Action button — hidden for own profile */}
      {!isOwnProfile ? (
        <PrivateRequestButton
          userId={profile.id}
          initialPending={friendRequestPending}
          style={s.cta}
        />
      ) : null}
    </View>
  );
}

const AVATAR_SIZE = 88;

const s = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.md,
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: space.sm,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700' as const,
  },
  lockBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: color.ink,
    borderWidth: 2,
    borderColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayName: {
    ...t.heading,
    color: color.ink,
    fontSize: 20,
    textAlign: 'center',
  },
  handle: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    fontSize: 13,
    textAlign: 'center',
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
