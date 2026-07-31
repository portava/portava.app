/**
 * Admin — Place mismatch reports queue.
 *
 * Lists reports submitted by users who think a post has been tagged to the
 * wrong place.  Admins can:
 *   • Accept  — nulls canonical_place_id so the post is re-resolved automatically.
 *   • Reject  — closes the report with no change to the post.
 *
 * Resolved reports are visible on a second tab.
 *
 * Requires admin role (enforced by useRequireAdmin hook + server-side).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  listPlaceMismatchReports,
  resolvePlaceMismatchReport,
  type PlaceMismatchReport,
} from '../../src/services/adminPlaceMismatch';

// ── Tab helpers ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'pending',  label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
] as const;

type Tab = (typeof TABS)[number]['key'];

// ── Row component ──────────────────────────────────────────────────────────────

interface RowProps {
  item: PlaceMismatchReport;
  tab: Tab;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  actioning: string | null;
}

function ReportRow({ item, tab, onAccept, onReject, actioning }: RowProps) {
  const busy = actioning === item.id;

  return (
    <View style={s.row}>
      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={s.postId} numberOfLines={1}>
            {item.post_content
              ? item.post_content.slice(0, 80) + (item.post_content.length > 80 ? '…' : '')
              : <Text style={s.mono}>{item.post_id.slice(0, 8)}…</Text>}
          </Text>
          {tab === 'resolved' && item.resolved_action ? (
            <View
              style={[
                s.badge,
                item.resolved_action === 'accept' ? s.badgeAccept : s.badgeReject,
              ]}
            >
              <Text
                style={[
                  s.badgeText,
                  item.resolved_action === 'accept' ? s.badgeAcceptText : s.badgeRejectText,
                ]}
              >
                {item.resolved_action === 'accept' ? 'Accepted' : 'Rejected'}
              </Text>
            </View>
          ) : null}
        </View>

        {(item.place_name ?? item.reported_place_id) ? (
          <Text style={s.meta}>
            Place&nbsp;
            <Text style={item.place_name ? s.placeName : s.mono}>
              {item.place_name ?? `${item.reported_place_id!.slice(0, 8)}…`}
            </Text>
          </Text>
        ) : null}

        {item.reason ? (
          <Text style={s.reason} numberOfLines={3}>{item.reason}</Text>
        ) : null}

        <Text style={s.footer}>
          Reporter&nbsp;
          <Text style={s.mono}>{item.reporter_id.slice(0, 8)}…</Text>
          {'  ·  '}
          {new Date(item.created_at).toLocaleDateString()}
          {item.resolved_at
            ? `  ·  resolved ${new Date(item.resolved_at).toLocaleDateString()}`
            : null}
        </Text>
      </View>

      {tab === 'pending' && (
        <View style={s.actions}>
          {busy ? (
            <ActivityIndicator size="small" color="#3B82F6" />
          ) : (
            <>
              <Pressable
                style={[s.btn, s.btnAccept]}
                onPress={() => onAccept(item.id)}
                accessibilityLabel="Accept report"
              >
                <Text style={s.btnAcceptText}>Accept</Text>
              </Pressable>
              <Pressable
                style={[s.btn, s.btnReject]}
                onPress={() => onReject(item.id)}
                accessibilityLabel="Reject report"
              >
                <Text style={s.btnRejectText}>Reject</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export default function PlaceMismatchReportsScreen() {
  useRequireAdmin();
  const { isAuthed, loading: sessionLoading } = useSession();

  const [tab, setTab]               = useState<Tab>('pending');
  const [reports, setReports]       = useState<PlaceMismatchReport[]>([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [cursor, setCursor]         = useState<string | undefined>(undefined);
  const [hasMore, setHasMore]       = useState(false);
  const [actioning, setActioning]   = useState<string | null>(null);

  // ── Data loading ─────────────────────────────────────────────────────────────

  const load = useCallback(async (opts: { append?: boolean; before?: string } = {}) => {
    if (!isAuthed) return;
    try {
      setError(null);
      const data = await listPlaceMismatchReports({
        status: tab,
        limit:  PAGE_SIZE,
        before: opts.before,
      });
      setReports((prev) =>
        opts.append ? [...prev, ...data.reports] : data.reports,
      );
      setTotal(data.total);
      const last = data.reports[data.reports.length - 1];
      setCursor(last?.id);
      setHasMore(data.reports.length === PAGE_SIZE);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load reports');
    }
  }, [isAuthed, tab]);

  useEffect(() => {
    if (sessionLoading || !isAuthed) return;
    setLoading(true);
    setReports([]);
    setCursor(undefined);
    setHasMore(false);
    load().finally(() => setLoading(false));
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = async () => {
    setRefreshing(true);
    setCursor(undefined);
    await load();
    setRefreshing(false);
  };

  const onLoadMore = () => {
    if (!hasMore || loading || refreshing) return;
    load({ append: true, before: cursor });
  };

  // ── Actions ───────────────────────────────────────────────────────────────────

  const handleAction = useCallback(
    async (reportId: string, action: 'accept' | 'reject') => {
      const label = action === 'accept' ? 'accept' : 'reject';
      const message =
        action === 'accept'
          ? "This will clear the post\u2019s place assignment so it can be re-resolved automatically."
          : 'The report will be closed with no change to the post.';

      Alert.alert(
        `${label.charAt(0).toUpperCase() + label.slice(1)} report?`,
        message,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: label.charAt(0).toUpperCase() + label.slice(1),
            style: action === 'accept' ? 'default' : 'destructive',
            onPress: async () => {
              setActioning(reportId);
              try {
                await resolvePlaceMismatchReport(reportId, action);
                // Optimistically remove from the pending list
                setReports((prev) => prev.filter((r) => r.id !== reportId));
                setTotal((t) => Math.max(0, t - 1));
              } catch (e: any) {
                Alert.alert('Error', e?.message ?? 'Failed to resolve report');
              } finally {
                setActioning(null);
              }
            },
          },
        ],
      );
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <Text style={s.title}>Place Mismatch Reports</Text>
        <Text style={s.subtitle}>{total} {tab}</Text>
      </View>

      {/* Tabs */}
      <View style={s.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            style={[s.tabBtn, tab === t.key && s.tabBtnActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[s.tabText, tab === t.key && s.tabTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
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
            onPress={() => {
              setLoading(true);
              load().finally(() => setLoading(false));
            }}
          >
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(r) => r.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.centered}>
              <Text style={s.emptyText}>No {tab} reports</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ReportRow
              item={item}
              tab={tab}
              onAccept={(id) => handleAction(id, 'accept')}
              onReject={(id) => handleAction(id, 'reject')}
              actioning={actioning}
            />
          )}
        />
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#F9FAFB' },

  header:         { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backBtn:        { marginBottom: 8 },
  backText:       { fontSize: 14, color: '#3B82F6' },
  title:          { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle:       { fontSize: 13, color: '#6B7280', marginTop: 2, textTransform: 'capitalize' },

  tabs:           { flexDirection: 'row', backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  tabBtn:         { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive:   { borderBottomColor: '#3B82F6' },
  tabText:        { fontSize: 14, fontWeight: '500', color: '#6B7280' },
  tabTextActive:  { color: '#3B82F6', fontWeight: '700' },

  list:           { padding: 16, gap: 10 },

  row:            { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#E5E7EB', gap: 10 },
  rowBody:        { gap: 4 },
  rowTop:         { flexDirection: 'row', alignItems: 'center', gap: 8 },
  postId:         { fontSize: 14, fontWeight: '600', color: '#111827', flex: 1 },
  mono:           { fontFamily: 'monospace', fontSize: 13 },
  placeName:      { fontSize: 13, fontWeight: '500', color: '#374151' },
  meta:           { fontSize: 12, color: '#6B7280' },
  reason:         { fontSize: 13, color: '#374151', marginTop: 2 },
  footer:         { fontSize: 11, color: '#9CA3AF', marginTop: 2 },

  badge:          { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeAccept:    { backgroundColor: '#D1FAE5' },
  badgeReject:    { backgroundColor: '#FEE2E2' },
  badgeText:      { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  badgeAcceptText:{ color: '#065F46' },
  badgeRejectText:{ color: '#991B1B' },

  actions:        { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  btn:            { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 7 },
  btnAccept:      { backgroundColor: '#D1FAE5', borderWidth: 1, borderColor: '#6EE7B7' },
  btnAcceptText:  { fontSize: 13, fontWeight: '600', color: '#065F46' },
  btnReject:      { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5' },
  btnRejectText:  { fontSize: 13, fontWeight: '600', color: '#991B1B' },

  centered:       { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText:      { fontSize: 15, color: '#6B7280' },
  errorText:      { fontSize: 15, color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:       { paddingHorizontal: 20, paddingVertical: 8, backgroundColor: '#3B82F6', borderRadius: 8 },
  retryText:      { color: '#FFFFFF', fontWeight: '600' },
});
