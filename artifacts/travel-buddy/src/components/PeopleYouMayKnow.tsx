import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { UserPlus, UserCheck } from 'lucide-react-native';
import {
  getSuggestedTravelers,
  getFollowStatus,
  followUser,
  type TravelerSearchResult,
} from '../services/follows';
import { useSession } from '../context/SessionContext';
import { color, space, radius, type as t } from '../theme/tokens';

const FOLLOWING_THRESHOLD = 10;
const STRIP_LIMIT = 5;

interface CardProps {
  user: TravelerSearchResult;
  onFollowed: (userId: string) => void;
}

function SuggestionCard({ user, onFollowed }: CardProps) {
  const [following, setFollowing] = useState(user.isFollowing);
  const [toggling, setToggling] = useState(false);

  async function handleFollow() {
    if (toggling || following) return;
    setToggling(true);
    setFollowing(true);
    const res = await followUser(user.id);
    if (res.ok) {
      onFollowed(user.id);
    } else {
      setFollowing(false);
    }
    setToggling(false);
  }

  function handlePress() {
    if (user.username) router.push(`/u/${user.username}` as any);
  }

  const displayName = user.displayName ?? user.username ?? 'Traveler';
  const handle = user.username ? `@${user.username}` : null;

  return (
    <Pressable style={styles.card} onPress={handlePress}>
      {user.avatarUrl ? (
        <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarEmpty]}>
          <Text style={{ fontSize: 20 }}>👤</Text>
        </View>
      )}
      <Text style={styles.cardName} numberOfLines={1}>{displayName}</Text>
      {handle ? <Text style={styles.cardHandle} numberOfLines={1}>{handle}</Text> : null}
      <Pressable
        style={[styles.followBtn, following && styles.followingBtn]}
        onPress={handleFollow}
        disabled={toggling || following}
      >
        {toggling ? (
          <ActivityIndicator size="small" color={following ? color.mute : color.onInk} />
        ) : following ? (
          <>
            <UserCheck size={11} color={color.mute} />
            <Text style={styles.followingText}>Following</Text>
          </>
        ) : (
          <>
            <UserPlus size={11} color={color.onInk} />
            <Text style={styles.followText}>Follow</Text>
          </>
        )}
      </Pressable>
    </Pressable>
  );
}

export function PeopleYouMayKnow() {
  const { userId, isAuthed } = useSession();
  const [suggestions, setSuggestions] = useState<TravelerSearchResult[]>([]);
  const [followingCount, setFollowingCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isAuthed || !userId) { setLoading(false); return; }
    setLoading(true);
    const [statusRes, suggestRes] = await Promise.all([
      getFollowStatus(userId),
      getSuggestedTravelers(STRIP_LIMIT),
    ]);
    if (statusRes.ok && statusRes.data) {
      setFollowingCount(statusRes.data.followingCount);
    }
    if (suggestRes.ok && suggestRes.data) {
      setSuggestions(suggestRes.data.slice(0, STRIP_LIMIT));
    }
    setLoading(false);
  }, [userId, isAuthed]);

  useEffect(() => { load(); }, [load]);

  const handleFollowed = useCallback((uid: string) => {
    setSuggestions((prev) => prev.filter((u) => u.id !== uid));
    setFollowingCount((c) => (c !== null ? c + 1 : c));
  }, []);

  // Hide: not authed, still loading with no data, following >= threshold, or no suggestions
  if (!isAuthed) return null;
  if (loading && suggestions.length === 0) return null;
  if (followingCount !== null && followingCount >= FOLLOWING_THRESHOLD) return null;
  if (suggestions.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>People you may know</Text>
        <Pressable onPress={() => router.push('/(tabs)/discovery' as any)}>
          <Text style={styles.seeAll}>See all</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {suggestions.map((user) => (
          <SuggestionCard key={user.id} user={user} onFollowed={handleFollowed} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    marginBottom: space.md,
  },
  title: {
    ...t.title,
    color: color.ink,
    fontSize: 17,
  },
  seeAll: {
    ...t.small,
    color: color.signal,
    fontWeight: '700',
  },
  strip: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  card: {
    width: 120,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    alignItems: 'center',
    gap: 5,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.haze,
    marginBottom: 2,
  },
  avatarEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0EDE8',
  },
  cardName: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 12,
    textAlign: 'center',
    width: '100%',
  },
  cardHandle: {
    fontFamily: 'Courier',
    fontSize: 10,
    color: color.mute,
    textAlign: 'center',
    width: '100%',
  },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    backgroundColor: color.signal,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    width: '100%',
    marginTop: 2,
  },
  followingBtn: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  followText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 11,
  },
  followingText: {
    ...t.bodyStrong,
    color: color.mute,
    fontSize: 11,
  },
});
