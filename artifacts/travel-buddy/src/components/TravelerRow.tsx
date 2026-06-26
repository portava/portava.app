import React, { useState } from 'react';
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { UserCheck, UserPlus, Lock, User, Users, PlaneTakeoff, Sparkles } from 'lucide-react-native';
import { followUser, unfollowUser, type TravelerSearchResult } from '../services/follows';
import { color, space, radius, type as t } from '../theme/tokens';
import { HighlightRing } from './HighlightRing';
import { HighlightViewer } from './HighlightViewer';
import { useHighlightRingState } from '../hooks/useHighlightRingState';

function rowSignalIcon(signal: string) {
  const lower = signal.toLowerCase();
  if (lower.includes('follow')) return <User size={10} color={color.signal} />;
  if (lower.includes('mutual')) return <Users size={10} color={color.signal} />;
  if (lower.includes('style') || lower.includes('interest')) return <Sparkles size={10} color={color.signal} />;
  return <PlaneTakeoff size={10} color={color.signal} />;
}

function RowReasonLines({ reason }: { reason: string }) {
  const parts = reason.split(' · ');
  return (
    <View style={styles.reasonMulti}>
      {parts.map((part, i) => (
        <View key={i} style={styles.reasonRow}>
          {rowSignalIcon(part)}
          <Text style={styles.reasonText} numberOfLines={1}>{part}</Text>
        </View>
      ))}
    </View>
  );
}

interface Props {
  user: TravelerSearchResult;
  isOwnProfile?: boolean;
  onFollowed?: (userId: string) => void;
}

export function TravelerRow({ user, isOwnProfile = false, onFollowed }: Props) {
  const [isFollowing, setIsFollowing] = useState(user.isFollowing);
  const [followerCount, setFollowerCount] = useState(user.followerCount);
  const [toggling, setToggling] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const ringState = useHighlightRingState(user.id);

  async function handleToggle() {
    if (toggling || user.isPrivate) return;
    const wasFollowing = isFollowing;
    setToggling(true);
    setIsFollowing(!wasFollowing);
    setFollowerCount((c) => wasFollowing ? Math.max(0, c - 1) : c + 1);

    const res = wasFollowing
      ? await unfollowUser(user.id)
      : await followUser(user.id);

    if (!res.ok) {
      setIsFollowing(wasFollowing);
      setFollowerCount((c) => wasFollowing ? c + 1 : Math.max(0, c - 1));
    } else if (!wasFollowing) {
      onFollowed?.(user.id);
    }
    setToggling(false);
  }

  function handleRowPress() {
    if (user.username) {
      router.push(`/u/${user.username}` as any);
    }
  }

  const displayName = user.displayName ?? user.username ?? 'Traveler';
  const handle = user.username ? `@${user.username}` : null;

  return (
    <>
    <Pressable style={styles.row} onPress={handleRowPress}>
      <HighlightRing
        hasActive={ringState?.hasActive ?? false}
        allViewed={ringState?.allViewed ?? false}
        size={48}
        ringWidth={2}
        gap={2}
        onPress={ringState?.hasActive ? () => setViewerOpen(true) : undefined}
      >
        {user.avatarUrl ? (
          <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarEmpty]}>
            <Text style={{ fontSize: 22 }}>👤</Text>
          </View>
        )}
      </HighlightRing>

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
        {handle ? <Text style={styles.handle} numberOfLines={1}>{handle}</Text> : null}
        {user.isPrivate ? (
          <View style={styles.privateBadge}>
            <Lock size={10} color={color.mute} />
            <Text style={styles.privateText}>Private</Text>
          </View>
        ) : (
          <Text style={styles.followers}>
            {followerCount === 1 ? '1 follower' : `${followerCount} followers`}
          </Text>
        )}
        {user.reason ? <RowReasonLines reason={user.reason} /> : null}
      </View>

      {!isOwnProfile && !user.isPrivate && (
        <Pressable
          style={[styles.followBtn, isFollowing && styles.followingBtn]}
          onPress={handleToggle}
          disabled={toggling}
        >
          {toggling ? (
            <ActivityIndicator size="small" color={isFollowing ? color.mute : color.onInk} />
          ) : isFollowing ? (
            <>
              <UserCheck size={13} color={color.mute} />
              <Text style={styles.followingText}>Following</Text>
            </>
          ) : (
            <>
              <UserPlus size={13} color={color.onInk} />
              <Text style={styles.followText}>Follow</Text>
            </>
          )}
        </Pressable>
      )}
    </Pressable>
    <HighlightViewer
      visible={viewerOpen}
      highlights={ringState?.highlights ?? []}
      onClose={() => setViewerOpen(false)}
    />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.haze,
  },
  avatarEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0EDE8',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  handle: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: color.mute,
  },
  followers: {
    fontSize: 11,
    color: color.faint,
    marginTop: 1,
  },
  reason: {
    fontSize: 11,
    color: color.signal,
    marginTop: 2,
  },
  reasonMulti: {
    marginTop: 2,
    gap: 2,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reasonText: {
    fontSize: 11,
    color: color.signal,
    flexShrink: 1,
  },
  privateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 2,
  },
  privateText: {
    fontSize: 11,
    color: color.mute,
    fontStyle: 'italic',
  },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.sm - 1,
    borderRadius: radius.pill,
    minWidth: 84,
    justifyContent: 'center',
  },
  followingBtn: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  followText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 12,
  },
  followingText: {
    ...t.bodyStrong,
    color: color.mute,
    fontSize: 12,
  },
});
