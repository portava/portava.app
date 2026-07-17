import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { fetchReviews, type TrustReview } from '../../src/services/trustAdmin';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';

const STATUS_FILTERS = ['all', 'open', 'in_progress'] as const;
const TYPE_FILTERS   = ['all', 'gaming_suspected', 'appeal', 'admin_flagged'] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];
type TypeFilter   = (typeof TYPE_FILTERS)[number];

const STATUS_COLORS: Record<string, string> = {
  open:        '#F59E0B',
  in_progress: '#3B82F6',
  resolved:    '#10B981',
  dismissed:   '#9CA3AF',
};

const TYPE_LABELS: Record<string, string> = {
  gaming_suspected: '🎮 Gaming',
  appeal:           '📣 Appeal',
  admin_flagged:    '🚩 Flagged',
};

function ReviewRow({ item, onPress }: { item: TrustReview; onPress: () => void }) {
  const statusColor = STATUS_COLORS[item.status] ?? '#9CA3AF';
  return (
    <Pressable style={styles.row} onPress={onPress} android_ripple={{ color: '#E5E7EB' }}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowType}>{TYPE_LABELS[item.review_type] ?? item.review_type}</Text>
        <Text style={styles.rowUserId} numberOfLines={1}>{item.user_id}</Text>
        <Text style={styles.rowDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
      </View>
      <View style={[styles.statusBadge, { backgroundColor: statusColor + '22', borderColor: statusColor }]}>
        <Text style={[styles.statusText, { color: statusColor }]}>{item.status}</Text>
      </View>
    </Pressable>
  );
}

export default function TrustReviewsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();
  const [reviews, setReviews]       = useState<TrustReview[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter]     = useState<TypeFilter>('all');

  useEffect(() => {
    if (!sessionLoading && !isAuthed) { router.replace('/(auth)/sign-in' as any); }
  }, [isAuthed, sessionLoading]);

  const load = useCallback(async (p = 1, append = false) => {
    if (!isAuthed) return;

    try {
      setError(null);
      const data = await fetchReviews({
        page:   p,
        limit:  30,
        status: statusFilter === 'all' ? undefined : statusFilter,
        type:   typeFilter   === 'all' ? undefined : typeFilter,
      });
      setReviews((prev) => append ? [...prev, ...data.reviews] : data.reviews);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load reviews');
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    if (sessionLoading || !isAuthed) return;
    setLoading(true);
    load(1).finally(() => setLoading(false));
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(1);
    setRefreshing(false);
  };

  const onLoadMore = () => {
    const totalPages = Math.ceil(total / 30);
    if (page < totalPages && !loading) load(page + 1, true);
  };

  const onPressRow = (item: TrustReview) => {
    router.push({ pathname: '/admin/trust-detail' as any, params: { userId: item.user_id } });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color="#111827" />
        </Pressable>
        <Text style={styles.title}>Trust Review Queue</Text>
        <Text style={styles.subtitle}>{total} open item{total !== 1 ? 's' : ''}</Text>
      </View>

      <View style={styles.filters}>
        <FlatList
          data={STATUS_FILTERS as unknown as StatusFilter[]}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => `status-${f}`}
          renderItem={({ item: f }) => (
            <TouchableOpacity
              style={[styles.chip, statusFilter === f && styles.chipActive]}
              onPress={() => setStatusFilter(f)}
            >
              <Text style={[styles.chipText, statusFilter === f && styles.chipTextActive]}>
                {f === 'all' ? 'All Status' : f.replace('_', ' ')}
              </Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingHorizontal: 16 }}
        />
      </View>

      <View style={styles.filters}>
        <FlatList
          data={TYPE_FILTERS as unknown as TypeFilter[]}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => `type-${f}`}
          renderItem={({ item: f }) => (
            <TouchableOpacity
              style={[styles.chip, typeFilter === f && styles.chipActive]}
              onPress={() => setTypeFilter(f)}
            >
              <Text style={[styles.chipText, typeFilter === f && styles.chipTextActive]}>
                {f === 'all' ? 'All Types' : TYPE_LABELS[f] ?? f}
              </Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingHorizontal: 16 }}
        />
      </View>

      {loading && !refreshing ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      ) : error ? (
        <View style={styles.centered} testID="trust-reviews-error" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load(1)}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : reviews.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No reviews match these filters</Text>
        </View>
      ) : (
        <FlatList
          data={reviews}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <ReviewRow item={item} onPress={() => onPressRow(item)} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.3}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  header:    { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  backBtn:   { padding: 4, marginBottom: 6 },
  title:     { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle:  { fontSize: 13, color: '#6B7280', marginTop: 2 },

  filters: { marginVertical: 4 },

  chip:          { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#D1D5DB', marginRight: 8, backgroundColor: '#fff' },
  chipActive:    { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  chipText:      { fontSize: 12, color: '#374151' },
  chipTextActive:{ color: '#fff' },

  row:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff' },
  rowLeft:  { flex: 1 },
  rowType:  { fontSize: 14, fontWeight: '600', color: '#111827' },
  rowUserId:{ fontSize: 12, color: '#6B7280', marginTop: 2, maxWidth: 240 },
  rowDate:  { fontSize: 11, color: '#9CA3AF', marginTop: 1 },

  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  statusText:  { fontSize: 11, fontWeight: '600' },

  sep:       { height: 1, backgroundColor: '#F3F4F6' },
  centered:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:  { backgroundColor: '#3B82F6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: '#fff', fontWeight: '600' },
  emptyText: { color: '#9CA3AF', fontSize: 15 },
});
