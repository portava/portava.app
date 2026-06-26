/**
 * Pending Posts Screen
 *
 * Shows the authenticated user's posts that are waiting to be published
 * (pending_location_exit, pending_delay, pending_safety_review).
 *
 * For each post the user can:
 *   • Publish without location (strips geotag, publishes immediately)
 *   • Change delay (change to delayed_until_time with a future time)
 *   • Make private (cancel + set visibility=private) — not yet wired
 *   • Cancel (cancels the delayed publish)
 *
 * Geofence monitoring: when the device is outside the post's geofence
 * radius and has been for ≥ CONFIRMATION_WINDOW_MS, the screen
 * automatically calls POST /api/location/exit-geofence.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { ArrowLeft, Clock, MapPin, XCircle, Eye } from 'lucide-react-native';
import { color, space, radius, type as t } from '../src/theme/tokens';
import {
  getPendingPosts,
  publishWithoutLocation,
  cancelDelayedPublish,
  changeLocationPrivacy,
  exitGeofence,
  type PendingPostRow,
} from '../src/services/posts';

const CONFIRMATION_WINDOW_MS = 8 * 60 * 1_000; // 8 minutes

function distanceMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function statusLabel(post: PendingPostRow): string {
  switch (post.postStatus) {
    case 'pending_location_exit': return 'Waiting to leave';
    case 'pending_delay':
      if (post.publishEligibleAt) {
        const d = new Date(post.publishEligibleAt);
        return `Publishing at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
      return 'Pending delay';
    case 'pending_safety_review': return 'Under review';
    default: return post.postStatus ?? 'Pending';
  }
}

function statusColor(post: PendingPostRow): string {
  switch (post.postStatus) {
    case 'pending_location_exit': return color.deep;
    case 'pending_delay': return '#8B5CF6';
    case 'pending_safety_review': return color.warn;
    default: return color.mute;
  }
}

interface PostCardProps {
  post: PendingPostRow;
  onPublishWithoutLocation: () => void;
  onCancel: () => void;
  exited: boolean;
}

function PendingPostCard({ post, onPublishWithoutLocation, onCancel, exited }: PostCardProps) {
  const preview = post.content.replace(/^\[[^\]]+\]\s*/, '').slice(0, 120);
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View style={[s.statusChip, { backgroundColor: statusColor(post) + '18' }]}>
          <Clock size={12} color={statusColor(post)} />
          <Text style={[s.statusText, { color: statusColor(post) }]}>{statusLabel(post)}</Text>
        </View>
        {exited && post.postStatus === 'pending_location_exit' && (
          <View style={s.exitedBadge}>
            <Text style={s.exitedText}>Exited geofence ✓</Text>
          </View>
        )}
      </View>

      {preview.length > 0 && (
        <Text style={s.preview} numberOfLines={2}>{preview}</Text>
      )}

      {(post.locationName || post.locationCity) && (
        <View style={s.locRow}>
          <MapPin size={12} color={color.mute} />
          <Text style={s.locText}>
            {post.locationName ?? post.locationCity}
            {post.locationCity && post.locationName ? ` · ${post.locationCity}` : ''}
          </Text>
        </View>
      )}

      <View style={s.actions}>
        <Pressable style={s.actionBtn} onPress={onPublishWithoutLocation}>
          <Eye size={14} color={color.deep} />
          <Text style={s.actionBtnText}>Publish now (no location)</Text>
        </Pressable>
        <Pressable style={[s.actionBtn, s.cancelBtn]} onPress={onCancel}>
          <XCircle size={14} color={color.signal} />
          <Text style={[s.actionBtnText, { color: color.signal }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function PendingPostsScreen() {
  const [posts, setPosts] = useState<PendingPostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exitedPostIds = useRef<Set<string>>(new Set());
  const outsinceTimes = useRef<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    const result = await getPendingPosts();
    if (result.ok && result.data) {
      setPosts(result.data);
      setError(null);
    } else {
      setError(result.message ?? 'Could not load pending posts');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Geofence monitoring ──────────────────────────────────────────────────────
  useEffect(() => {
    const geofencePosts = posts.filter(
      (p) =>
        p.postStatus === 'pending_location_exit' &&
        !exitedPostIds.current.has(p.id),
    );
    if (geofencePosts.length === 0) return;

    let sub: Location.LocationSubscription | null = null;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 50 },
        async (loc) => {
          const now = Date.now();
          for (const post of geofencePosts) {
            if (!post.locationLat || !post.locationLng) continue;
            const dist = distanceMeters(
              loc.coords.latitude,
              loc.coords.longitude,
              post.locationLat,
              post.locationLng,
            );
            const radius = post.geofenceRadiusMeters ?? 400;
            if (dist > radius) {
              const firstOutside = outsinceTimes.current.get(post.id);
              if (!firstOutside) {
                outsinceTimes.current.set(post.id, now);
              } else if (now - firstOutside >= CONFIRMATION_WINDOW_MS) {
                // Confirmed exit — notify server
                exitedPostIds.current.add(post.id);
                outsinceTimes.current.delete(post.id);
                await exitGeofence({
                  postId: post.id,
                  lat: loc.coords.latitude,
                  lng: loc.coords.longitude,
                });
                load(); // refresh to get updated publish_eligible_at
              }
            } else {
              // Re-entered — reset the timer
              outsinceTimes.current.delete(post.id);
            }
          }
        },
      );
    })();

    return () => { sub?.remove(); };
  }, [posts, load]);

  async function handlePublishWithoutLocation(post: PendingPostRow) {
    Alert.alert(
      'Publish without location?',
      "Your post will go public immediately but won't show where you are.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Publish',
          style: 'default',
          onPress: async () => {
            const result = await publishWithoutLocation(post.id);
            if (result.ok) {
              setPosts((prev) => prev.filter((p) => p.id !== post.id));
            } else {
              Alert.alert('Error', result.message ?? 'Could not publish');
            }
          },
        },
      ],
    );
  }

  async function handleCancel(post: PendingPostRow) {
    Alert.alert(
      'Cancel this post?',
      "The post won't be published. You can still edit and re-post it.",
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel post',
          style: 'destructive',
          onPress: async () => {
            const result = await cancelDelayedPublish(post.id);
            if (result.ok) {
              setPosts((prev) => prev.filter((p) => p.id !== post.id));
            } else {
              Alert.alert('Error', result.message ?? 'Could not cancel');
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={s.back}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <Text style={s.title}>Pending Posts</Text>
        </View>
        <View style={s.center}>
          <ActivityIndicator color={color.deep} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={s.back}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Pending Posts</Text>
      </View>

      {error ? (
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      ) : posts.length === 0 ? (
        <View style={s.center}>
          <Clock size={40} color={color.haze} />
          <Text style={s.emptyTitle}>No pending posts</Text>
          <Text style={s.emptySub}>Posts waiting to share will appear here.</Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
          contentContainerStyle={s.list}
          renderItem={({ item }) => (
            <PendingPostCard
              post={item}
              exited={exitedPostIds.current.has(item.id)}
              onPublishWithoutLocation={() => handlePublishWithoutLocation(item)}
              onCancel={() => handleCancel(item)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={color.deep}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: space.lg, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  back: { padding: 4 },
  title: { ...t.headingMd, color: color.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: space.xl },
  errorText: { ...t.body, color: color.signal },
  emptyTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
  list: { padding: space.md, gap: space.md },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: color.haze,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  statusChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill,
  },
  statusText: { ...t.small, fontWeight: '700', fontSize: 11 },
  exitedBadge: {
    paddingHorizontal: 8, paddingVertical: 3,
    backgroundColor: color.success + '18', borderRadius: radius.pill,
  },
  exitedText: { ...t.small, color: color.success, fontWeight: '700', fontSize: 11 },
  preview: { ...t.body, color: color.ink, fontSize: 14 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  locText: { ...t.small, color: color.mute },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paper,
  },
  cancelBtn: { borderColor: color.signal + '40' },
  actionBtnText: { ...t.small, fontWeight: '700', color: color.deep },
});
