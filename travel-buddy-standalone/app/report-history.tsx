import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, ActivityIndicator, Pressable,
  StyleSheet, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { fetchMyReports, type MyReport } from '../src/services/reports';
import { NavBarFiller, useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';

const STATUS_LABEL: Record<string, string> = {
  pending:    'Under review',
  reviewed:   'Reviewed',
  resolved:   'Resolved',
  dismissed:  'Dismissed',
};

const STATUS_COLOR: Record<string, string> = {
  pending:   '#92400E',
  reviewed:  '#1D4ED8',
  resolved:  '#065F46',
  dismissed: color.faint,
};

const TARGET_LABEL: Record<string, string> = {
  user:    'User',
  profile: 'Profile',
  message: 'Message',
  thread:  'Thread',
  trip:    'Trip',
  post:    'Post',
  place:   'Place',
  event:   'Event',
};

const REASON_LABEL: Record<string, string> = {
  harassment:    'Harassment or bullying',
  spam:          'Spam',
  hate_speech:   'Hate speech',
  violence:      'Violence',
  impersonation: 'Impersonation',
  nudity:        'Nudity',
  misinformation: 'Misinformation',
  other:         'Other',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function ReportCard({ report }: { report: MyReport }) {
  const status = STATUS_LABEL[report.status] ?? report.status;
  const statusColor = STATUS_COLOR[report.status] ?? color.faint;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.targetType}>{TARGET_LABEL[report.target_type] ?? report.target_type}</Text>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
        </View>
      </View>
      <Text style={styles.reason}>{REASON_LABEL[report.reason_code] ?? report.reason_code}</Text>
      {report.reason_detail ? (
        <Text style={styles.detail} numberOfLines={2}>{report.reason_detail}</Text>
      ) : null}
      <Text style={styles.time}>{relativeTime(report.created_at)}</Text>
    </View>
  );
}

export default function ReportHistoryScreen() {
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState<MyReport[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navBarScrollHandler = useNavBarScrollHandler();
  const PAGE = 20;

  const load = useCallback(async (reset = true) => {
    if (reset) { setLoading(true); setError(null); }
    else setLoadingMore(true);
    const offset = reset ? 0 : reports.length;
    const res = await fetchMyReports({ limit: PAGE, offset });
    if (reset) setLoading(false); else setLoadingMore(false);
    if (!res.ok) {
      setError(res.message ?? 'Could not load report history.');
      return;
    }
    if (reset) {
      setReports(res.reports);
    } else {
      setReports((prev) => [...prev, ...res.reports]);
    }
    setTotal(res.total);
  }, [reports.length]);

  useFocusEffect(useCallback(() => { load(true); }, []));

  const loadMore = useCallback(() => {
    if (loadingMore || reports.length >= total) return;
    load(false);
  }, [loadingMore, reports.length, total, load]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Report History</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => load(true)}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(r) => r.id}
          contentContainerStyle={[styles.list, reports.length === 0 && { flex: 1 }]}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => load(true)} tintColor={color.signal} />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyIcon}>🛡️</Text>
              <Text style={styles.emptyTitle}>No reports yet</Text>
              <Text style={styles.emptyBody}>Reports you file will appear here.</Text>
            </View>
          }
          ListFooterComponent={
            <>
              {loadingMore ? (
                <View style={{ padding: space.lg, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={color.mute} />
                </View>
              ) : null}
              <NavBarFiller />
            </>
          }
          renderItem={({ item }) => <ReportCard report={item} />}
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  backBtn: {
    padding: space.xs,
    marginLeft: -space.xs,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: space.sm,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  emptyBody: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    fontSize: 13,
  },
  list: {
    padding: space.lg,
    paddingBottom: space.xxxl,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  targetType: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  reason: {
    ...t.body,
    color: color.ink,
    fontSize: 13,
  },
  detail: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  time: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
    marginTop: 2,
  },
});
