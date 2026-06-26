import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  ActivityIndicator,
  StyleSheet,
  Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { UserPlus, UserCheck, X } from 'lucide-react-native';
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
const DISMISSED_KEY = 'people_you_may_know_dismissed';
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface DismissedEntry {
  id: string;
  dismissedAt: number;
}

async function loadDismissed(): Promise<Map<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Map();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON — clear and start fresh
      await AsyncStorage.removeItem(DISMISSED_KEY);
      return new Map();
    }

    if (!Array.isArray(parsed)) {
      // Unexpected shape — clear and start fresh
      await AsyncStorage.removeItem(DISMISSED_KEY);
      return new Map();
    }

    const now = Date.now();
    let migrated = false;

    // Normalize each element: support legacy plain string[] and new DismissedEntry[]
    const entries: DismissedEntry[] = parsed.map((item) => {
      if (typeof item === 'string') {
        migrated = true;
        return { id: item, dismissedAt: now };
      }
      if (item && typeof item === 'object' && typeof (item as DismissedEntry).id === 'string' && typeof (item as DismissedEntry).dismissedAt === 'number') {
        return item as DismissedEntry;
      }
      // Malformed element — treat as fresh dismissal so it eventually expires
      migrated = true;
      return { id: String((item as { id?: unknown })?.id ?? ''), dismissedAt: now };
    }).filter((e) => e.id.length > 0);

    // Prune entries older than TTL
    const active = entries.filter((e) => now - e.dismissedAt < DISMISSED_TTL_MS);

    // Persist if: legacy format was migrated OR entries were pruned
    if (migrated || active.length < entries.length) {
      await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(active));
    }

    return new Map(active.map((e) => [e.id, e.dismissedAt]));
  } catch {
    return new Map();
  }
}

async function saveDismissed(map: Map<string, number>): Promise<void> {
  try {
    const entries: DismissedEntry[] = [...map.entries()].map(([id, dismissedAt]) => ({
      id,
      dismissedAt,
    }));
    await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(entries));
  } catch {
    // silently ignore storage errors
  }
}

interface CardProps {
  user: TravelerSearchResult;
  onFollowed: (userId: string) => void;
  onDismiss: (userId: string) => void;
}

function SuggestionCard({ user, onFollowed, onDismiss }: CardProps) {
  const [following, setFollowing] = useState(user.isFollowing);
  const [toggling, setToggling] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const width = useRef(new Animated.Value(120)).current;
  const marginRight = useRef(new Animated.Value(0)).current;

  async function handleFollow() {
    if (toggling || following) return;
    setToggling(true);
    setFollowing(true);
    const res = await followUser(user.id);
    if (res.ok) {
      animateOut(() => onFollowed(user.id));
    } else {
      setFollowing(false);
    }
    setToggling(false);
  }

  function animateOut(onDone: () => void) {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: false }),
      Animated.timing(scale, { toValue: 0.85, duration: 200, useNativeDriver: false }),
      Animated.sequence([
        Animated.delay(150),
        Animated.timing(width, { toValue: 0, duration: 180, useNativeDriver: false }),
        Animated.timing(marginRight, { toValue: -12, duration: 0, useNativeDriver: false }),
      ]),
    ]).start(() => onDone());
  }

  function handleDismiss() {
    animateOut(() => onDismiss(user.id));
  }

  function handlePress() {
    if (user.username) router.push(`/u/${user.username}` as any);
  }

  const displayName = user.displayName ?? user.username ?? 'Traveler';
  const handle = user.username ? `@${user.username}` : null;
  const reason = user.reason ?? null;

  return (
    <Animated.View style={{ opacity, transform: [{ scale }], width, marginRight, overflow: 'hidden' }}>
      <Pressable style={styles.card} onPress={handlePress}>
        <Pressable
          style={styles.dismissBtn}
          onPress={handleDismiss}
          hitSlop={8}
        >
          <X size={11} color={color.mute} />
        </Pressable>
        {user.avatarUrl ? (
          <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarEmpty]}>
            <Text style={{ fontSize: 20 }}>👤</Text>
          </View>
        )}
        <Text style={styles.cardName} numberOfLines={1}>{displayName}</Text>
        {handle ? <Text style={styles.cardHandle} numberOfLines={1}>{handle}</Text> : null}
        {reason ? <Text style={styles.cardReason} numberOfLines={1}>{reason}</Text> : null}
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
    </Animated.View>
  );
}

interface PeopleYouMayKnowProps {
  refreshKey?: number;
}

export function PeopleYouMayKnow({ refreshKey }: PeopleYouMayKnowProps = {}) {
  const { userId, isAuthed } = useSession();
  const [suggestions, setSuggestions] = useState<TravelerSearchResult[]>([]);
  const [followingCount, setFollowingCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    if (!isAuthed || !userId) { setLoading(false); return; }
    setLoading(true);
    const [statusRes, suggestRes, dismissedMap] = await Promise.all([
      getFollowStatus(userId),
      getSuggestedTravelers(STRIP_LIMIT),
      loadDismissed(),
    ]);
    setDismissed(dismissedMap);
    if (statusRes.ok && statusRes.data) {
      setFollowingCount(statusRes.data.followingCount);
    }
    if (suggestRes.ok && suggestRes.data) {
      const filtered = suggestRes.data
        .filter((u) => !dismissedMap.has(u.id))
        .slice(0, STRIP_LIMIT);
      setSuggestions(filtered);
    }
    setLoading(false);
  }, [userId, isAuthed]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const handleFollowed = useCallback((uid: string) => {
    setSuggestions((prev) => prev.filter((u) => u.id !== uid));
    setFollowingCount((c) => (c !== null ? c + 1 : c));
  }, []);

  const handleDismiss = useCallback((uid: string) => {
    setSuggestions((prev) => prev.filter((u) => u.id !== uid));
    setDismissed((prev) => {
      const next = new Map(prev);
      next.set(uid, Date.now());
      saveDismissed(next);
      return next;
    });
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
          <SuggestionCard
            key={user.id}
            user={user}
            onFollowed={handleFollowed}
            onDismiss={handleDismiss}
          />
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
  dismissBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
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
  cardReason: {
    ...t.small,
    fontSize: 10,
    color: color.signal,
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
