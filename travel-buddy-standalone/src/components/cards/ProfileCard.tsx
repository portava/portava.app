/**
 * ProfileCard — shared card for user/buddy profile surfaces.
 * Avatar, display name, handle, trust score, follow button.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';
import { color, space, radius, shadow, typography, layout } from '../../theme/tokens.ts';

export interface ProfileCardProps {
  id: string;
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
  trustScore?: number | null;
  isVerified?: boolean;
  bio?: string | null;
  isFollowing?: boolean;
  /** True when this account is private — shows Request/Pending instead of Follow/Following */
  isPrivate?: boolean;
  /** True when the viewer has already sent a follow request (pending approval) */
  requestPending?: boolean;
  onPress: () => void;
  onFollow?: () => void;
  /** Called when the viewer taps "Request" on a private account */
  onRequest?: () => void;
}

export function ProfileCard({
  displayName, handle, avatarUrl, trustScore, isVerified, bio,
  isFollowing, isPrivate, requestPending, onPress, onFollow, onRequest,
}: ProfileCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${displayName}${handle ? ` @${handle}` : ''}`}
    >
      <View style={styles.topRow}>
        <AvatarImage
          uri={avatarUrl ?? undefined}
          user={{ displayName }}
          size={52}
          style={styles.avatar}
        />
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
            {isVerified ? (
              <ShieldCheck size={14} color={color.success} />
            ) : null}
          </View>
          {handle ? (
            <Text style={styles.handle} numberOfLines={1}>@{handle}</Text>
          ) : null}
          {trustScore != null ? (
            <Text style={styles.trust}>Trust score: {trustScore}</Text>
          ) : null}
        </View>

        {/* Private account: show Request / Pending instead of Follow / Following */}
        {isPrivate && !isFollowing ? (
          requestPending ? (
            <View style={[styles.followBtn, styles.followBtnActive]}>
              <Text style={[styles.followBtnText, styles.followBtnTextActive]}
                accessibilityLabel="Pending">
                Pending
              </Text>
            </View>
          ) : onRequest ? (
            <Pressable
              style={({ pressed }) => [styles.followBtn, pressed && { opacity: 0.7 }]}
              onPress={(e) => { e.stopPropagation?.(); onRequest(); }}
              accessibilityRole="button"
              accessibilityLabel="Request to follow"
            >
              <Text style={styles.followBtnText}>Request</Text>
            </Pressable>
          ) : null
        ) : onFollow ? (
          /* Public account (or already following a private one): Follow / Following */
          <Pressable
            style={({ pressed }) => [styles.followBtn, isFollowing && styles.followBtnActive, pressed && { opacity: 0.7 }]}
            onPress={(e) => { e.stopPropagation?.(); onFollow(); }}
            accessibilityRole="button"
            accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
          >
            <Text style={[styles.followBtnText, isFollowing && styles.followBtnTextActive]}>
              {isFollowing ? 'Following' : 'Follow'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {bio ? (
        <Text style={styles.bio} numberOfLines={2}>{bio}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
    padding: space.md,
    marginBottom: space.sm,
    gap: space.sm,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  avatar: {
    borderRadius: 26,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  name: {
    ...typography.cardTitle,
    color: color.ink,
    flex: 1,
  },
  handle: {
    ...typography.caption,
    color: color.mute,
  },
  trust: {
    ...typography.metadata,
    color: color.deep,
  },
  followBtn: {
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.ink,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    flexShrink: 0,
  },
  followBtnActive: {
    borderColor: color.haze,
    backgroundColor: color.haze,
  },
  followBtnText: {
    ...typography.button,
    color: color.ink,
    fontSize: 12,
  },
  followBtnTextActive: {
    color: color.mute,
  },
  bio: {
    ...typography.caption,
    color: color.mute,
  },
});
