/**
 * Admin — Stamp Studio reconciler run history.
 * Lists recent catalog-reconciler runs newest-first with per-run counts
 * (resolved / flagged / skipped / enqueued / combos). Runs that ended with a
 * fatal error carry a red badge and show the error message, so "did it run
 * and did it succeed?" is answerable without hitting the API by hand.
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
import { ArrowLeft, CheckCircle2, History, Play, TriangleAlert } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import {
  getReconcilerRuns,
  triggerReconcilerRun,
  type ReconcilerRun,
} from '../../../src/services/adminStamps';

const COUNT_FIELDS: Array<{ key: keyof ReconcilerRun; label: string }> = [
  { key: 'resolved', label: 'resolved' },
  { key: 'flagged',  label: 'flagged' },
  { key: 'skipped',  label: 'skipped' },
  { key: 'enqueued', label: 'enqueued' },
  { key: 'combos',   label: 'combos' },
];

export default function ReconcilerRunsScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [runs, setRuns]             = useState<ReconcilerRun[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [running, setRunning]       = useState(false);

  const load = useCallback(async () => {
    const res = await getReconcilerRuns(50);
    if (res.ok) {
      setRuns(res.data.runs ?? []);
      setLoadError(null);
    } else {
      setLoadError((res as any).error ?? 'Failed to load run history');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const startRun = useCallback(async () => {
    setRunning(true);
    const res = await triggerReconcilerRun();
    if (!res.ok) {
      Alert.alert('Error', (res as any).error ?? 'Failed to run reconciler');
    }
    // Refresh the history either way — a failed run may still have logged a row.
    await load();
    setRunning(false);
  }, [load]);

  const onRunNow = useCallback(() => {
    if (running) return;
    Alert.alert(
      'Run reconciler now?',
      'This resolves all unlinked stamps against the catalog. It is idempotent and safe to re-run, but may take a moment.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Run now', onPress: () => { startRun(); } },
      ],
    );
  }, [running, startRun]);

  const renderRun = ({ item }: { item: ReconcilerRun }) => {
    const failed = !!item.fatalError;
    return (
      <View style={styles.row} testID={`run-row-${item.id ?? 'unknown'}`}>
        <View style={styles.rowIcon}>
          {failed ? (
            <TriangleAlert size={18} color="#DC2626" strokeWidth={2} />
          ) : (
            <CheckCircle2 size={18} color="#16A34A" strokeWidth={2} />
          )}
        </View>
        <View style={styles.rowMeta}>
          <View style={styles.rowTopLine}>
            <Text style={styles.rowDate}>
              {item.ranAt ? new Date(item.ranAt).toLocaleString() : 'Unknown time'}
            </Text>
            {failed ? (
              <View style={styles.fatalBadge} testID="run-fatal-badge">
                <Text style={styles.fatalBadgeText}>Fatal error</Text>
              </View>
            ) : null}
            {item.parseError ? (
              <View style={styles.parseBadge}>
                <Text style={styles.parseBadgeText}>Unparsed summary</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.countsRow}>
            {COUNT_FIELDS.map(({ key, label }) => (
              <View key={key} style={styles.countPill}>
                <Text style={styles.countValue}>{Number(item[key] ?? 0)}</Text>
                <Text style={styles.countLabel}>{label}</Text>
              </View>
            ))}
          </View>
          {item.fatalError ? (
            <Text style={styles.fatalText} numberOfLines={3}>{item.fatalError}</Text>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Reconciler Runs</Text>
        <Text style={styles.count}>{runs.length}</Text>
        <Pressable
          testID="run-now-btn"
          onPress={onRunNow}
          disabled={running}
          style={[styles.runBtn, running && styles.runBtnDisabled]}
          accessibilityState={{ disabled: running }}
        >
          {running ? (
            <ActivityIndicator size="small" color="#FFFFFF" testID="run-now-spinner" />
          ) : (
            <Play size={14} color="#FFFFFF" strokeWidth={2} />
          )}
          <Text style={styles.runBtnText}>{running ? 'Running…' : 'Run now'}</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.ink} /></View>
      ) : (
        <FlatList
          testID="reconciler-runs-list"
          data={runs}
          keyExtractor={(item, index) => item.id ?? `run-${index}`}
          renderItem={renderRun}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <History size={28} color={color.mute} strokeWidth={1.5} />
              <Text style={styles.empty}>
                {loadError ?? 'No reconciler runs recorded yet'}
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:       { flex: 1, backgroundColor: color.paper },
  header:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:    { marginRight: space.sm },
  title:      { ...t.heading, color: color.ink, flex: 1 },
  count:      { ...t.small, color: color.mute },
  runBtn:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.ink, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, marginLeft: space.sm },
  runBtnDisabled: { opacity: 0.5 },
  runBtnText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  center:     { flex: 1, justifyContent: 'center', alignItems: 'center' },
  row:        { flexDirection: 'row', paddingHorizontal: space.md, paddingVertical: space.md, gap: space.sm },
  rowIcon:    { paddingTop: 2 },
  rowMeta:    { flex: 1 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  rowDate:    { ...t.body, color: color.ink, fontWeight: '600' },
  fatalBadge:     { backgroundColor: '#FEE2E2', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  fatalBadgeText: { fontSize: 10, fontWeight: '700', color: '#B91C1C' },
  parseBadge:     { backgroundColor: '#FEF3C7', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  parseBadgeText: { fontSize: 10, fontWeight: '700', color: '#92400E' },
  countsRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  countPill:  { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.haze, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  countValue: { fontSize: 12, fontWeight: '700', color: color.ink },
  countLabel: { fontSize: 11, color: color.mute },
  fatalText:  { ...t.small, color: '#DC2626', marginTop: 6 },
  sep:        { height: 1, backgroundColor: color.haze, marginLeft: space.md },
  emptyWrap:  { alignItems: 'center', gap: space.xs, padding: space.xl },
  empty:      { color: color.mute, textAlign: 'center' },
});
