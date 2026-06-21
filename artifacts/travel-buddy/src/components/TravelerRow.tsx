import React, { useState } from 'react';
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { UserCheck, UserPlus, Lock } from 'lucide-react-native';
import { followUser, unfollowUser, type TravelerSearchResult } from '../services/follows';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  user: TravelerSearchResult;
  isOwnProfile?: boolean;
}

export function TravelerRow({ user, isOwnProfile = false }: Props) {
  const [isFollowing, setIsFollowing] = useState(user.isFollowing);
  const [followerCount, setFollowerCount] = useState(user.followerCount);
  const [toggling, setToggling] = useState(false);

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
    <Pressable style={styles.row} onPress={handleRowPress}>
      {user.avatarUrl ? (
        <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarEmpty]}>
          <Text style={{ fontSize: 22 }}>👤</Text>
        </View>
      )}

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
