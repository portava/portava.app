/**
 * PrivateProfileWall — lock section rendered BELOW the passport header.
 *
 * The header (PassportHero with isPrivateView=true) is always shown by the
 * parent screen — the passport header is intentionally public. This component
 * renders only the private-account badge, the lock message, and the
 * relationship action button.
 *
 * Deliberately does NOT render bio, home city, country, travel status, stats,
 * tabs, or any count — those must never be passed or shown.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
   * Avatar URL — passed through for parent use; not rendered here (the
   * PassportHero renders the avatar above this component).
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
  return (
    <View style={s.container}>
      {/* "Private account" badge */}
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

const s = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingTop: space.lg,
    paddingBottom: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.md,
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
