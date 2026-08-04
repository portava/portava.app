/**
 * Admin — Content reports queue.
 * Read-only list of all user-submitted content reports.
 * Requires admin role (enforced by useRequireAdmin hook + server-side).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { fetchAdminReports, type ContentReport } from '../../src/services/reportsAdmin';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';

const STATUS_FILTERS = ['open', 'in_review', 'resolved', 'dismissed', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const SEVERITY_COLOR: Record<string, string> = {
  high:   '#EF4444',
  normal: '#6B7280',
  low:    '#9CA3AF',
};

const TYPE_EMOJI: Record<string, string> = {
  user:    '👤',
  profile: '👤',
  message: '💬',
  thread:  '🧵',
  trip:    '✈️',
  post:    '📝',
  place:   '📍',
  event:   '📅',
};

export default function ContentReportsScreen() {
  useRequireAdmin();
  const { isAuthed, loading: sessionLoading } = useSession();

  const [reports, setReports]         = useState<ContentReport[]>([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');

  const load = useCallback(async (p = 1, append = false) => {
    if (!isAuthed) return;
    try {
      setError(null);
      const data = await fetchAdminReports({
        page:   p,
        limit:  30,
        status: statusFilter,
      });
      setReports((prev) => (append ? [...prev, ...data.reports] : data.reports));
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load reports');
    }
  }, [isAuthed, statusFilter]);

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

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <Text style={s.title}>Content Reports</Text>
        <Text style={s.subtitle}>{total} total</Text>
      </View>

      <View style={s.filters}>
        <FlatList
          data={STATUS_FILTERS as unknown as StatusFilter[]}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => `sf-${f}`}
          contentContainerStyle={s.filterRow}
          renderItem={({ item: f }) => (
            <Pressable
              style={[s.chip, statusFilter === f && s.chipActive]}
              onPress={() => setStatusFilter(f)}
            >
              <Text style={[s.chipText, statusFilter === f && s.chipTextActive]}>
                {f === 'in_review' ? 'In Review' : f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </Pressable>
          )}
        />
      </View>

      {loading && !refreshing ? (
        <View style={s.centered}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      ) : error ? (
        <View
          style={s.centered}
          testID="content-reports-error"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <Text style={s.errorText}>{error}</Text>
          <Pressable style={s.retryBtn} onPress={() => { setLoading(true); load(1).finally(() => setLoading(false)); }}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.centered}>
              <Text style={s.emptyText}>No reports</Text>
            </View>
          }
          renderItem={({ item: r }) => (
            <View style={s.row}>
              <Text style={s.emoji}>{TYPE_EMOJI[r.target_type] ?? '📋'}</Text>
              <View style={s.rowBody}>
                <View style={s.rowTop}>
                  <Text style={s.reason}>{r.reason_code.replace(/_/g, ' ')}</Text>
                  <View style={[s.badge, { backgroundColor: `${SEVERITY_COLOR[r.severity] ?? '#6B7280'}22` }]}>
                    <Text style={[s.badgeText, { color: SEVERITY_COLOR[r.severity] ?? '#6B7280' }]}>
                      {r.severity}
                    </Text>
                  </View>
                </View>
                <Text style={s.target}>{r.target_type} · {r.target_id.slice(0, 8)}…</Text>
                {r.reason_detail ? (
                  <Text style={s.detail} numberOfLines={2}>{r.reason_detail}</Text>
                ) : null}
                <Text style={s.meta}>{new Date(r.created_at).toLocaleDateString()} · {r.status} · reporter: {r.reporter_id.slice(0, 8)}…</Text>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#F9FAFB' },
  header:       { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backBtn:      { marginBottom: 8 },
  backText:     { fontSize: 14, color: '#3B82F6' },
  title:        { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle:     { fontSize: 13, color: '#6B7280', marginTop: 2 },
  filters:      { backgroundColor: '#FFFFFF', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  filterRow:    { paddingHorizontal: 16, gap: 8 },
  chip:         { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  chipActive:   { backgroundColor: '#EFF6FF', borderColor: '#3B82F6' },
  chipText:     { fontSize: 13, color: '#6B7280' },
  chipTextActive: { color: '#3B82F6', fontWeight: '600' },
  list:         { padding: 16, gap: 10 },
  row:          { flexDirection: 'row', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#E5E7EB' },
  emoji:        { fontSize: 20, paddingTop: 2 },
  rowBody:      { flex: 1, gap: 4 },
  rowTop:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reason:       { fontSize: 14, fontWeight: '600', color: '#111827', textTransform: 'capitalize', flex: 1 },
  badge:        { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badgeText:    { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  target:       { fontSize: 12, color: '#6B7280' },
  detail:       { fontSize: 13, color: '#374151' },
  meta:         { fontSize: 11, color: '#9CA3AF' },
  centered:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText:    { fontSize: 15, color: '#6B7280' },
  errorText:    { fontSize: 15, color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:     { paddingHorizontal: 20, paddingVertical: 8, backgroundColor: '#3B82F6', borderRadius: 8 },
  retryText:    { color: '#FFFFFF', fontWeight: '600' },
});
