/**
 * Pending Posts Screen
 *
 * Shows the authenticated user's posts that are waiting to be published
 * (pending_location_exit, pending_delay, pending_safety_review).
 *
 * For each post the user can:
 *   • Release now — strips the geotag and publishes immediately
 *   • Make private — cancels + sets visibility=private
 *   • Cancel — cancels the delayed publish, leaving the post as a draft
 *
 * Geofence exit detection is handled by the background task registered in
 * useGeofenceMonitor (app/(tabs)/_layout.tsx) — no on-screen polling needed.
 */

import React, { useCallback, useEffect, useState } from 'react';
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
import { router } from 'expo-router';
import { ArrowLeft, Clock, MapPin, XCircle, Zap } from 'lucide-react-native';
import { color, space, radius, type as t } from '../src/theme/tokens';
import {
  getPendingPosts,
  publishWithoutLocation,
  cancelDelayedPublish,
  changeLocationPrivacy,
  type PendingPostRow,
} from '../src/services/posts';
import { NavBarFiller, useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';

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
  onReleaseNow: () => void;
  onCancel: () => void;
  onMakePrivate: () => void;
}

function PendingPostCard({ post, onReleaseNow, onCancel, onMakePrivate }: PostCardProps) {
  const preview = post.content.replace(/^\[[^\]]+\]\s*/, '').slice(0, 120);
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View style={[s.statusChip, { backgroundColor: statusColor(post) + '18' }]}>
          <Clock size={12} color={statusColor(post)} />
          <Text style={[s.statusText, { color: statusColor(post) }]}>{statusLabel(post)}</Text>
        </View>
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
        <Pressable style={s.actionBtn} onPress={onReleaseNow}>
          <Zap size={14} color={color.deep} />
          <Text style={s.actionBtnText}>Release now</Text>
        </Pressable>
        <Pressable style={[s.actionBtn, s.privateBtn]} onPress={onMakePrivate}>
          <XCircle size={14} color={color.mute} />
          <Text style={[s.actionBtnText, { color: color.mute }]}>Make private</Text>
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

  const navBarScrollHandler = useNavBarScrollHandler();

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

  async function handleMakePrivate(post: PendingPostRow) {
    Alert.alert(
      'Make post private?',
      "The post will be saved to your profile but visible only to you.",
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Make private',
          style: 'default',
          onPress: async () => {
            const result = await changeLocationPrivacy(post.id, 'hidden');
            if (result.ok) {
              setPosts((prev) => prev.filter((p) => p.id !== post.id));
            } else {
              Alert.alert('Error', result.message ?? 'Could not update post');
            }
          },
        },
      ],
    );
  }

  async function handleReleaseNow(post: PendingPostRow) {
    Alert.alert(
      'Release now?',
      "Your post will go public immediately without showing your location.",
      [
        { text: 'Keep waiting', style: 'cancel' },
        {
          text: 'Release now',
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
              onReleaseNow={() => handleReleaseNow(item)}
              onMakePrivate={() => handleMakePrivate(item)}
              onCancel={() => handleCancel(item)}
            />
          )}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListFooterComponent={<NavBarFiller />}
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
  title: { ...t.heading, color: color.ink },
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
  privateBtn: { borderColor: color.mute + '40' },
  actionBtnText: { ...t.small, fontWeight: '700', color: color.deep },
});
