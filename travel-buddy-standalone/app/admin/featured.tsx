/**
 * Admin — Featured by @Portava management screen.
 *
 * Lists all portava_featured rows with status badges and provides a
 * "Reseed from @Portava" action that repopulates the table from @Portava's
 * top posts when the carousel is empty or depleted.
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
import { adminGet, adminPost } from '../../src/services/adminApi';

// ── Types ──────────────────────────────────────────────────────────────────────

interface FeaturedPost {
  id: string;
  content: string | null;
  authorId: string;
  primaryMediaType: string | null;
  city: string | null;
  likeCount: number;
  saveCount: number;
}

interface FeaturedItem {
  id: string;
  postId: string;
  category: string;
  featuredAt: string;
  approvedBy: string | null;
  status: string;
  creatorPermissionRequestedAt: string | null;
  creatorPermissionGrantedAt: string | null;
  createdAt: string;
  post: FeaturedPost | null;
}

interface ListResponse {
  items: FeaturedItem[];
  total: number;
  page: number;
}

interface ReseedResponse {
  seeded: number;
  skipped: number;
  categories?: string[];
  seededAt?: string;
  message?: string;
}

// ── Filters ───────────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { key: '',                    label: 'All' },
  { key: 'live',                label: 'Live' },
  { key: 'pending_permission',  label: 'Pending Permission' },
  { key: 'declined',            label: 'Declined' },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: string): { label: string; bg: string; fg: string } {
  switch (status) {
    case 'live':               return { label: 'Live',               bg: '#D1FAE5', fg: '#059669' };
    case 'pending_permission': return { label: 'Pending Permission', bg: '#FEF3C7', fg: '#D97706' };
    case 'declined':           return { label: 'Declined',           bg: '#FEE2E2', fg: '#DC2626' };
    default:                   return { label: status,               bg: '#F3F4F6', fg: '#6B7280' };
  }
}

function fmtCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ── Reseed banner ─────────────────────────────────────────────────────────────

interface ReseedBannerProps {
  result: ReseedResponse;
  onDismiss: () => void;
}

function ReseedBanner({ result, onDismiss }: ReseedBannerProps) {
  const noOp = result.seeded === 0;
  return (
    <View style={[s.banner, noOp ? s.bannerInfo : s.bannerSuccess]}>
      <View style={s.bannerContent}>
        <Text style={[s.bannerTitle, noOp ? s.bannerTitleInfo : s.bannerTitleSuccess]}>
          {noOp ? 'Nothing to seed' : `Seeded ${result.seeded} post${result.seeded === 1 ? '' : 's'}`}
        </Text>
        <Text style={s.bannerBody}>
          {result.message
            ? result.message
            : `${result.seeded} new featured row${result.seeded === 1 ? '' : 's'} added, ${result.skipped} already live.`}
        </Text>
        {result.categories && result.categories.length > 0 && (
          <Text style={s.bannerCategories}>
            Categories: {result.categories.map(fmtCategory).join(', ')}
          </Text>
        )}
      </View>
      <Pressable onPress={onDismiss} style={s.bannerClose}>
        <Text style={s.bannerCloseText}>✕</Text>
      </Pressable>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminFeaturedScreen() {
  useRequireAdmin();
  const { isAuthed, loading: sessionLoading } = useSession();

  const [items, setItems]           = useState<FeaturedItem[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [statusFilter, setStatus]   = useState('');
  const [reseeding, setReseeding]   = useState(false);
  const [reseedResult, setReseedResult] = useState<ReseedResponse | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (p = 1, append = false) => {
    if (!isAuthed) return;
    setError(null);
    const qs = new URLSearchParams({ page: String(p), limit: '30' });
    if (statusFilter) qs.set('status', statusFilter);
    const res = await adminGet<ListResponse>(`/api/admin/featured?${qs}`);
    if (!mounted.current) return;
    if (!res.ok) { setError(res.error); return; }
    setItems((prev) => append ? [...prev, ...res.data.items] : res.data.items);
    setTotal(res.data.total);
    setPage(p);
  }, [isAuthed, statusFilter]);

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

  const onReseed = () => {
    Alert.alert(
      'Reseed from @Portava?',
      'This will add @Portava\'s top posts to the Featured carousel for any category that doesn\'t already have a live row. Existing live rows are left unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reseed',
          onPress: async () => {
            if (!mounted.current) return;
            setReseeding(true);
            setReseedResult(null);
            const res = await adminPost<ReseedResponse>('/api/admin/featured/reseed');
            if (!mounted.current) return;
            setReseeding(false);
            if (!res.ok) {
              Alert.alert('Reseed failed', res.error);
              return;
            }
            setReseedResult(res.data);
            // Reload the list to reflect newly seeded rows
            load(1);
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
          <View>
            <Text style={s.title}>Featured by @Portava</Text>
            <Text style={s.subtitle}>{total} total</Text>
          </View>
          <Pressable
            style={[s.reseedBtn, reseeding && s.reseedBtnDisabled]}
            onPress={onReseed}
            disabled={reseeding}
          >
            {reseeding ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={s.reseedBtnText}>Reseed from @Portava</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* Reseed result banner */}
      {reseedResult && (
        <ReseedBanner
          result={reseedResult}
          onDismiss={() => setReseedResult(null)}
        />
      )}

      {/* Status filters */}
      <View style={s.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
          {STATUS_FILTERS.map((f) => (
            <Pressable
              key={f.key || 'all'}
              style={[s.chip, statusFilter === f.key && s.chipActive]}
              onPress={() => setStatus(f.key)}
            >
              <Text style={[s.chipText, statusFilter === f.key && s.chipTextActive]}>{f.label}</Text>
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
          <Pressable
            style={s.retryBtn}
            onPress={() => { setLoading(true); load(1).finally(() => { if (mounted.current) setLoading(false); }); }}
          >
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyTitle}>No featured rows yet</Text>
              <Text style={s.emptyBody}>
                Tap "Reseed from @Portava" above to populate the Featured carousel from @Portava's top posts.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const badge = statusBadge(item.status);
            return (
              <View style={s.card}>
                {/* Top row: category + status badge */}
                <View style={s.cardTop}>
                  <Text style={s.category}>{fmtCategory(item.category)}</Text>
                  <View style={[s.badge, { backgroundColor: badge.bg }]}>
                    <Text style={[s.badgeText, { color: badge.fg }]}>{badge.label}</Text>
                  </View>
                </View>

                {/* Post content preview */}
                {item.post?.content ? (
                  <Text style={s.content} numberOfLines={2}>{item.post.content}</Text>
                ) : null}

                {/* Meta */}
                <View style={s.meta}>
                  {item.post?.city ? (
                    <Text style={s.metaText}>📍 {item.post.city}</Text>
                  ) : null}
                  {item.post ? (
                    <Text style={s.metaText}>
                      ❤️ {item.post.likeCount}  🔖 {item.post.saveCount}
                      {item.post.primaryMediaType ? `  · ${item.post.primaryMediaType}` : ''}
                    </Text>
                  ) : null}
                  <Text style={s.metaText}>Featured: {fmtDate(item.featuredAt)}</Text>
                  {item.status === 'pending_permission' && item.creatorPermissionRequestedAt ? (
                    <Text style={s.metaText}>Permission requested: {fmtDate(item.creatorPermissionRequestedAt)}</Text>
                  ) : null}
                  {item.status === 'live' && item.creatorPermissionGrantedAt ? (
                    <Text style={s.metaText}>Permission granted: {fmtDate(item.creatorPermissionGrantedAt)}</Text>
                  ) : null}
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#F9FAFB' },
  header:           { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backBtn:          { marginBottom: 8 },
  backText:         { fontSize: 14, color: '#3B82F6' },
  headerRow:        { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title:            { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle:         { fontSize: 13, color: '#6B7280', marginTop: 2 },
  reseedBtn:        { backgroundColor: '#7C3AED', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9, alignItems: 'center', justifyContent: 'center', minWidth: 60 },
  reseedBtnDisabled:{ opacity: 0.6 },
  reseedBtnText:    { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  // Reseed result banner
  banner:           { marginHorizontal: 16, marginTop: 12, borderRadius: 10, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  bannerSuccess:    { backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#6EE7B7' },
  bannerInfo:       { backgroundColor: '#F0F9FF', borderWidth: 1, borderColor: '#BAE6FD' },
  bannerContent:    { flex: 1, gap: 2 },
  bannerTitle:      { fontSize: 14, fontWeight: '700' },
  bannerTitleSuccess: { color: '#065F46' },
  bannerTitleInfo:  { color: '#0C4A6E' },
  bannerBody:       { fontSize: 13, color: '#374151', lineHeight: 18 },
  bannerCategories: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  bannerClose:      { padding: 4 },
  bannerCloseText:  { fontSize: 14, color: '#9CA3AF' },
  // Filters
  filterBar:        { backgroundColor: '#FFFFFF', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  filterRow:        { paddingHorizontal: 16, gap: 8 },
  chip:             { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  chipActive:       { backgroundColor: '#EFF6FF', borderColor: '#3B82F6' },
  chipText:         { fontSize: 13, color: '#6B7280' },
  chipTextActive:   { color: '#3B82F6', fontWeight: '600' },
  // List
  list:             { padding: 16, gap: 12 },
  card:             { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#E5E7EB', gap: 8 },
  cardTop:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  category:         { fontSize: 12, fontWeight: '600', color: '#7C3AED', textTransform: 'uppercase', letterSpacing: 0.5 },
  badge:            { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText:        { fontSize: 11, fontWeight: '700' },
  content:          { fontSize: 14, color: '#374151', lineHeight: 20 },
  meta:             { gap: 2 },
  metaText:         { fontSize: 12, color: '#6B7280' },
  // States
  centered:         { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyWrap:        { paddingTop: 60, paddingHorizontal: 32, alignItems: 'center', gap: 10 },
  emptyTitle:       { fontSize: 16, fontWeight: '600', color: '#374151', textAlign: 'center' },
  emptyBody:        { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 20 },
  errorText:        { fontSize: 15, color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:         { paddingHorizontal: 20, paddingVertical: 8, backgroundColor: '#3B82F6', borderRadius: 8 },
  retryText:        { color: '#FFFFFF', fontWeight: '600' },
});
