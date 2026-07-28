/**
 * Admin — @Portava post list.
 *
 * Lists all posts authored by the @portava account with status badges
 * (scheduled / live / cancelled) and swipe-to-delete for scheduled items.
 *
 * Requires admin role (enforced by useRequireAdmin hook + server-side).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { useSession } from '../../src/context/SessionContext';
import { adminDelete, adminGet } from '../../src/services/adminApi';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PortavaPost {
  id: string;
  content: string;
  category: string | null;
  postStatus: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  visibility: string;
  mediaUrls: string[];
  locationCity: string | null;
  locationCountry: string | null;
  status: string;
  createdAt: string;
  updatedAt: string | null;
}

interface ListResponse {
  posts: PortavaPost[];
  total: number;
  page: number;
}

// ── Filters ───────────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { key: 'all',       label: 'All' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'published', label: 'Live' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;

type StatusKey = (typeof STATUS_FILTERS)[number]['key'];

const CATEGORY_FILTERS = [
  { key: '',                      label: 'All categories' },
  { key: 'hidden_gem',            label: 'Hidden Gem' },
  { key: 'inspiration',           label: 'Inspiration' },
  { key: 'festival',              label: 'Festival' },
  { key: 'restaurant',            label: 'Restaurant' },
  { key: 'beach_resort',          label: 'Beach Resort' },
  { key: 'nightlife',             label: 'Nightlife' },
  { key: 'neighborhood',          label: 'Neighborhood' },
  { key: 'trending_destination',  label: 'Trending Destination' },
  { key: 'travel_tip',            label: 'Travel Tip' },
  { key: 'hotel',                 label: 'Hotel' },
  { key: 'featured_creator',      label: 'Featured Creator' },
  { key: 'destination_of_week',   label: 'Destination of Week' },
  { key: 'community_spotlight',   label: 'Community Spotlight' },
] as const;

// ── Badge helpers ─────────────────────────────────────────────────────────────

function statusBadge(postStatus: string): { label: string; bg: string; fg: string } {
  if (postStatus === 'pending_delay')  return { label: 'Scheduled', bg: '#FEF3C7', fg: '#D97706' };
  if (postStatus === 'published')      return { label: 'Live',      bg: '#D1FAE5', fg: '#059669' };
  if (postStatus === 'canceled')       return { label: 'Cancelled', bg: '#FEE2E2', fg: '#DC2626' };
  return { label: postStatus, bg: '#F3F4F6', fg: '#6B7280' };
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtCategory(cat: string | null): string {
  if (!cat) return '';
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PortavaPostsScreen() {
  useRequireAdmin();
  const { isAuthed, loading: sessionLoading } = useSession();

  const [posts, setPosts]           = useState<PortavaPost[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [statusFilter, setStatus]   = useState<StatusKey>('all');
  const [categoryFilter, setCategory] = useState('');
  const [deleting, setDeleting]       = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (p = 1, append = false) => {
    if (!isAuthed) return;
    setError(null);
    const qs = new URLSearchParams({ page: String(p), limit: '30' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    if (categoryFilter) qs.set('category', categoryFilter);
    const res = await adminGet<ListResponse>(`/api/admin/portava/posts?${qs}`);
    if (!mounted.current) return;
    if (!res.ok) { setError(res.error); return; }
    setPosts((prev) => append ? [...prev, ...res.data.posts] : res.data.posts);
    setTotal(res.data.total);
    setPage(p);
  }, [isAuthed, statusFilter, categoryFilter]);

  useEffect(() => {
    if (sessionLoading || !isAuthed) return;
    setLoading(true);
    load(1).finally(() => { if (mounted.current) setLoading(false); });
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(1);
    if (mounted.current) setRefreshing(false);
  };

  const onLoadMore = () => {
    const totalPages = Math.ceil(total / 30);
    if (page < totalPages && !loading) load(page + 1, true);
  };

  const onDelete = (post: PortavaPost) => {
    const isScheduled = post.postStatus === 'pending_delay';
    const action = isScheduled ? 'Cancel this scheduled post?' : 'Unpublish this post?';
    Alert.alert(
      isScheduled ? 'Cancel post' : 'Unpublish post',
      action,
      [
        { text: 'No', style: 'cancel' },
        {
          text: isScheduled ? 'Cancel post' : 'Unpublish',
          style: 'destructive',
          onPress: async () => {
            setDeleting(post.id);
            const res = await adminDelete(`/api/admin/portava/posts/${post.id}`);
            if (!mounted.current) return;
            setDeleting(null);
            if (!res.ok) {
              Alert.alert('Error', res.error);
              return;
            }
            setPosts((prev) => prev.filter((p) => p.id !== post.id));
            setTotal((t) => Math.max(0, t - 1));
          },
        },
      ],
    );
  };

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <View style={s.headerRow}>
          <Text style={s.title}>@Portava Posts</Text>
          <Pressable style={s.newBtn} onPress={() => router.push('/admin/portava-post' as any)}>
            <Text style={s.newBtnText}>+ New</Text>
          </Pressable>
        </View>
        <Text style={s.subtitle}>{total} total</Text>
      </View>

      {/* Status filters */}
      <View style={s.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
          {STATUS_FILTERS.map((f) => (
            <Pressable
              key={f.key}
              style={[s.chip, statusFilter === f.key && s.chipActive]}
              onPress={() => setStatus(f.key)}
            >
              <Text style={[s.chipText, statusFilter === f.key && s.chipTextActive]}>{f.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Category filters */}
      <View style={s.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
          {CATEGORY_FILTERS.map((f) => (
            <Pressable
              key={f.key || 'all-cat'}
              style={[s.chip, categoryFilter === f.key && s.chipActivePurple]}
              onPress={() => setCategory(f.key)}
            >
              <Text style={[s.chipText, categoryFilter === f.key && s.chipTextActivePurple]}>{f.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Body */}
      {loading && !refreshing ? (
        <View style={s.centered}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      ) : error ? (
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable style={s.retryBtn} onPress={() => { setLoading(true); load(1).finally(() => setLoading(false)); }}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.centered}>
              <Text style={s.emptyText}>No posts yet</Text>
            </View>
          }
          renderItem={({ item: post }) => {
            const badge = statusBadge(post.postStatus);
            const isDeletable = post.postStatus === 'pending_delay' || post.postStatus === 'published';
            return (
              <View style={s.card}>
                {/* Top row: category + badge */}
                <View style={s.cardTop}>
                  {post.category ? (
                    <Text style={s.category}>{fmtCategory(post.category)}</Text>
                  ) : (
                    <Text style={s.categoryNone}>No category</Text>
                  )}
                  <View style={[s.badge, { backgroundColor: badge.bg }]}>
                    <Text style={[s.badgeText, { color: badge.fg }]}>{badge.label}</Text>
                  </View>
                </View>

                {/* Content preview */}
                <Text style={s.content} numberOfLines={3}>{post.content}</Text>

                {/* Meta */}
                <View style={s.meta}>
                  {post.locationCity ? (
                    <Text style={s.metaText}>📍 {post.locationCity}{post.locationCountry ? `, ${post.locationCountry}` : ''}</Text>
                  ) : null}
                  {post.mediaUrls.length > 0 ? (
                    <Text style={s.metaText}>🖼 {post.mediaUrls.length} media</Text>
                  ) : null}
                  {post.postStatus === 'pending_delay' && post.scheduledAt ? (
                    <Text style={s.metaText}>🕐 Scheduled: {fmtDate(post.scheduledAt)}</Text>
                  ) : post.publishedAt ? (
                    <Text style={s.metaText}>✅ Published: {fmtDate(post.publishedAt)}</Text>
                  ) : null}
                  <Text style={s.metaText}>Created: {fmtDate(post.createdAt)}</Text>
                </View>

                {/* Actions */}
                {isDeletable && (
                  <View style={s.actions}>
                    <Pressable
                      style={s.deleteBtn}
                      onPress={() => onDelete(post)}
                      disabled={deleting === post.id}
                    >
                      {deleting === post.id ? (
                        <ActivityIndicator size="small" color="#DC2626" />
                      ) : (
                        <Text style={s.deleteBtnText}>
                          {post.postStatus === 'pending_delay' ? 'Cancel' : 'Unpublish'}
                        </Text>
                      )}
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#F9FAFB' },
  header:         { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backBtn:        { marginBottom: 8 },
  backText:       { fontSize: 14, color: '#3B82F6' },
  headerRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title:          { fontSize: 22, fontWeight: '700', color: '#111827' },
  newBtn:         { backgroundColor: '#3B82F6', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  newBtnText:     { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  subtitle:       { fontSize: 13, color: '#6B7280', marginTop: 2 },
  filterBar:      { backgroundColor: '#FFFFFF', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  filterRow:      { paddingHorizontal: 16, gap: 8 },
  chip:           { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  chipActive:     { backgroundColor: '#EFF6FF', borderColor: '#3B82F6' },
  chipText:       { fontSize: 13, color: '#6B7280' },
  chipTextActive:       { color: '#3B82F6', fontWeight: '600' },
  chipActivePurple:     { backgroundColor: '#EDE9FE', borderColor: '#7C3AED' },
  chipTextActivePurple: { color: '#7C3AED', fontWeight: '600' },
  list:           { padding: 16, gap: 12 },
  card:           { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#E5E7EB', gap: 8 },
  cardTop:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  category:       { fontSize: 12, fontWeight: '600', color: '#7C3AED', textTransform: 'uppercase', letterSpacing: 0.5 },
  categoryNone:   { fontSize: 12, color: '#9CA3AF' },
  badge:          { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText:      { fontSize: 11, fontWeight: '700' },
  content:        { fontSize: 14, color: '#374151', lineHeight: 20 },
  meta:           { gap: 2 },
  metaText:       { fontSize: 12, color: '#6B7280' },
  actions:        { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 4 },
  deleteBtn:      { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: '#FCA5A5', backgroundColor: '#FEF2F2', minWidth: 80, alignItems: 'center' },
  deleteBtnText:  { fontSize: 13, color: '#DC2626', fontWeight: '600' },
  centered:       { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText:      { fontSize: 15, color: '#6B7280' },
  errorText:      { fontSize: 15, color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:       { paddingHorizontal: 20, paddingVertical: 8, backgroundColor: '#3B82F6', borderRadius: 8 },
  retryText:      { color: '#FFFFFF', fontWeight: '600' },
});
