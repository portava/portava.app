/**
 * PrivateProfileWall — lock section rendered BELOW the passport header.
 *
 * The passport header (PassportIdentityCard / PassportHero) is always shown
 * by the parent screen with the user's avatar, name, and @handle — the
 * header is intentionally public. This component renders ONLY the
 * private-account badge, the lock message, and the friend-request button.
 *
 * Never renders avatar, name, handle, bio, location, stats, or tabs.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Lock } from 'lucide-react-native';
import { PrivateRequestButton } from '../ui/PrivateRequestButton.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

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

export function PrivateProfileWall({
  profile,
  friendRequestPending = false,
  isOwnProfile = false,
  onRequestSent,
}: Props) {
  return (
    <View style={s.container}>
      <View style={s.privateBadge}>
        <Lock size={11} color={color.mute} />
        <Text style={s.privateBadgeText}>Private account</Text>
      </View>

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
