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
import { UserPlus, UserCheck, X, User, Users, PlaneTakeoff, Sparkles, RefreshCw } from 'lucide-react-native';
import {
  getSuggestedTravelers,
  getFollowStatus,
  followUser,
  clearSuggestionsSeen,
  type TravelerSearchResult,
} from '../services/follows';
import { useSession } from '../context/SessionContext';
import { color, space, radius, type as t } from '../theme/tokens';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity';

const FOLLOWING_THRESHOLD = 10;
const STRIP_LIMIT = 5;
const DISMISSED_KEY = 'people_you_may_know_dismissed';
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const UNDO_TIMEOUT_MS = 4000;

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
      await AsyncStorage.removeItem(DISMISSED_KEY);
      return new Map();
    }

    if (!Array.isArray(parsed)) {
      await AsyncStorage.removeItem(DISMISSED_KEY);
      return new Map();
    }

    const now = Date.now();
    let migrated = false;

    const entries: DismissedEntry[] = parsed.map((item) => {
      if (typeof item === 'string') {
        migrated = true;
        return { id: item, dismissedAt: now };
      }
      if (item && typeof item === 'object' && typeof (item as DismissedEntry).id === 'string' && typeof (item as DismissedEntry).dismissedAt === 'number') {
        return item as DismissedEntry;
      }
      migrated = true;
      return { id: String((item as { id?: unknown })?.id ?? ''), dismissedAt: now };
    }).filter((e) => e.id.length > 0);

    const active = entries.filter((e) => now - e.dismissedAt < DISMISSED_TTL_MS);

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

function signalIcon(signal: string) {
  const lower = signal.toLowerCase();
  if (lower.includes('follow')) return <User size={9} color={color.signal} />;
  if (lower.includes('mutual')) return <Users size={9} color={color.signal} />;
  if (lower.includes('style') || lower.includes('interest')) return <Sparkles size={9} color={color.signal} />;
  return <PlaneTakeoff size={9} color={color.signal} />;
}

function CardReasonLines({ reason }: { reason: string }) {
  const parts = reason.split(' · ');
  return (
    <View style={styles.cardReasonMulti}>
      {parts.map((part, i) => (
        <View key={i} style={styles.cardReasonRow}>
          {signalIcon(part)}
          <Text style={styles.cardReasonText} numberOfLines={1}>{part}</Text>
        </View>
      ))}
    </View>
  );
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

  const displayName = primaryIdentityText({ displayName: user.displayName, username: user.username });
  const handle = secondaryIdentityText({ displayName: user.displayName, username: user.username });
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
        {reason ? <CardReasonLines reason={reason} /> : null}
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

interface UndoToastProps {
  visible: boolean;
  onUndo: () => void;
}

function UndoToast({ visible, onUndo }: UndoToastProps) {
  const translateY = useRef(new Animated.Value(20)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const prevVisible = useRef(false);

  useEffect(() => {
    if (visible && !prevVisible.current) {
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else if (!visible && prevVisible.current) {
      Animated.parallel([
        Animated.timing(translateY, { toValue: 20, duration: 180, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
    prevVisible.current = visible;
  }, [visible, translateY, opacity]);

  return (
    <Animated.View
      style={[styles.toast, { opacity, transform: [{ translateY }] }]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <Text style={styles.toastLabel}>Suggestion removed</Text>
      <Pressable onPress={onUndo} hitSlop={8}>
        <Text style={styles.toastUndo}>Undo</Text>
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
  const [refreshing, setRefreshing] = useState(false);
  const [dismissed, setDismissed] = useState<Map<string, number>>(new Map());

  // Undo state — ref holds live pending data to avoid stale closures in timer
  const pendingRef = useRef<{ user: TravelerSearchResult; index: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  // Track whether we have ever displayed suggestions — determines whether the
  // empty state shows "See new faces" (user ran through the list) vs. hiding
  // (server returned 0 suggestions on initial load with no interaction).
  const [hasHadSuggestions, setHasHadSuggestions] = useState(false);
  useEffect(() => {
    if (suggestions.length > 0) setHasHadSuggestions(true);
  }, [suggestions.length]);

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

  const handleRefresh = useCallback(async () => {
    if (refreshing || loading) return;
    setRefreshing(true);
    // Clear locally-dismissed entries so previously-skipped people reappear.
    // Must happen before load() so loadDismissed() sees an empty store and the
    // filter in load() doesn't exclude anyone the user dismissed days ago.
    await AsyncStorage.removeItem(DISMISSED_KEY);
    setDismissed(new Map());
    await clearSuggestionsSeen();
    await load();
    setRefreshing(false);
  }, [refreshing, loading, load]);

  // Commit a pending dismissal to AsyncStorage + dismissed state
  const commitPending = useCallback((user: TravelerSearchResult) => {
    setDismissed((prev) => {
      const next = new Map(prev);
      next.set(user.id, Date.now());
      saveDismissed(next);
      return next;
    });
  }, []);

  const handleFollowed = useCallback((uid: string) => {
    setSuggestions((prev) => prev.filter((u) => u.id !== uid));
    setFollowingCount((c) => (c !== null ? c + 1 : c));
  }, []);

  const handleDismiss = useCallback((uid: string) => {
    setSuggestions((prev) => {
      const index = prev.findIndex((u) => u.id === uid);
      const user = prev[index];
      if (!user) return prev;

      // If another dismissal was pending, commit it first
      if (pendingRef.current) {
        commitPending(pendingRef.current.user);
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      pendingRef.current = { user, index };
      setToastVisible(true);

      timerRef.current = setTimeout(() => {
        if (pendingRef.current?.user.id === uid) {
          commitPending(pendingRef.current.user);
          pendingRef.current = null;
        }
        timerRef.current = null;
        setToastVisible(false);
      }, UNDO_TIMEOUT_MS);

      return prev.filter((u) => u.id !== uid);
    });
  }, [commitPending]);

  const handleUndo = useCallback(() => {
    if (!pendingRef.current) return;

    const { user, index } = pendingRef.current;
    pendingRef.current = null;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Re-insert at the original position (clamped to current list length)
    setSuggestions((prev) => {
      const insertAt = Math.min(index, prev.length);
      const next = [...prev];
      next.splice(insertAt, 0, user);
      return next;
    });

    setToastVisible(false);
  }, []);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Commit any pending dismissal so it isn't lost
      if (pendingRef.current) {
        commitPending(pendingRef.current.user);
      }
    };
  }, [commitPending]);

  // Hide: not authed, still loading with no data, following >= threshold
  if (!isAuthed) return null;
  if (loading && suggestions.length === 0) return null;
  if (followingCount !== null && followingCount >= FOLLOWING_THRESHOLD) return null;
  // Hide only if server returned 0 suggestions on first load with no prior interaction
  if (suggestions.length === 0 && !toastVisible && !hasHadSuggestions) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>People you may know</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleRefresh}
            hitSlop={8}
            disabled={refreshing || loading}
            style={styles.refreshBtn}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={color.signal} />
            ) : (
              <RefreshCw size={15} color={color.signal} />
            )}
          </Pressable>
          <Pressable onPress={() => router.push('/(tabs)/discovery' as any)}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>
      </View>
      {suggestions.length === 0 && !toastVisible ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>You've seen everyone for now</Text>
          <Pressable
            style={[styles.newFacesBtn, (refreshing || loading) && styles.newFacesBtnDisabled]}
            onPress={handleRefresh}
            disabled={refreshing || loading}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <>
                <Sparkles size={13} color={color.onInk} />
                <Text style={styles.newFacesBtnText}>See new faces</Text>
              </>
            )}
          </Pressable>
        </View>
      ) : (
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
      )}
      <UndoToast visible={toastVisible} onUndo={handleUndo} />
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  refreshBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
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
  cardReasonMulti: {
    width: '100%',
    gap: 3,
  },
  cardReasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  cardReasonText: {
    ...t.small,
    fontSize: 10,
    color: color.signal,
    flexShrink: 1,
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
  emptyState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.md,
  },
  emptyText: {
    ...t.body,
    color: color.mute,
    fontSize: 13,
    flex: 1,
  },
  newFacesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    minWidth: 44,
    justifyContent: 'center',
  },
  newFacesBtnDisabled: {
    opacity: 0.5,
  },
  newFacesBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 13,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    backgroundColor: color.ink,
    borderRadius: radius.md,
  },
  toastLabel: {
    ...t.body,
    color: color.onInk,
    fontSize: 13,
  },
  toastUndo: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 13,
  },
});
