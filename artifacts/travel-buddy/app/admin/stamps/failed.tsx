/**
 * Admin — Stamp Studio failed generation jobs.
 * Lists queue jobs stuck in retryable_failed and lets an admin re-queue them
 * (resets status → queued, attempts → 0).
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
import { ArrowLeft, RefreshCw, XCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import {
  getAdminStampQueue,
  requeueFailedJob,
  type GenerationQueueJob,
} from '../../../src/services/adminStamps';

export default function FailedJobsScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [jobs, setJobs]             = useState<GenerationQueueJob[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId]         = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getAdminStampQueue({ status: 'retryable_failed', limit: 100 });
    if (res.ok) setJobs(res.data.jobs ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const onRequeue = useCallback((job: GenerationQueueJob) => {
    const name = job.universal_stamp_catalog?.display_name ?? job.catalog_id;
    Alert.alert(
      'Re-queue job?',
      `Artwork generation for "${name}" will be retried from scratch (attempts reset to 0).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Re-queue',
          onPress: async () => {
            setBusyId(job.id);
            const res = await requeueFailedJob(job.id);
            setBusyId(null);
            if (res.ok) {
              setJobs((prev) => prev.filter((j) => j.id !== job.id));
            } else {
              Alert.alert('Error', (res as any).error ?? 'Failed to re-queue job');
            }
          },
        },
      ],
    );
  }, []);

  const renderJob = ({ item }: { item: GenerationQueueJob }) => {
    const cat = item.universal_stamp_catalog;
    return (
      <View style={styles.row}>
        <View style={styles.rowMeta}>
          <Text style={styles.rowName} numberOfLines={1}>
            {cat?.display_name ?? item.catalog_id}
          </Text>
          {cat ? (
            <Text style={styles.rowSub}>{cat.stamp_type} · {cat.country_code}</Text>
          ) : null}
          <Text style={styles.rowSub}>
            {item.attempts}/{item.max_attempts} attempts · failed {new Date(item.updated_at).toLocaleString()}
          </Text>
          {item.last_error ? (
            <Text style={styles.rowError} numberOfLines={2}>{item.last_error}</Text>
          ) : null}
        </View>
        <Pressable
          style={styles.requeueBtn}
          onPress={() => onRequeue(item)}
          disabled={busyId === item.id}
        >
          {busyId === item.id ? (
            <ActivityIndicator size="small" color={color.onInk} />
          ) : (
            <>
              <RefreshCw size={14} color={color.onInk} strokeWidth={2} />
              <Text style={styles.requeueText}>Re-queue</Text>
            </>
          )}
        </Pressable>
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Failed Generation Jobs</Text>
        <Text style={styles.count}>{jobs.length}</Text>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.ink} /></View>
      ) : (
        <FlatList
          data={jobs}
          keyExtractor={(item) => item.id}
          renderItem={renderJob}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <XCircle size={28} color={color.mute} strokeWidth={1.5} />
              <Text style={styles.empty}>No failed generation jobs</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: color.paper },
  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:     { marginRight: space.sm },
  title:       { ...t.heading, color: color.ink, flex: 1 },
  count:       { ...t.small, color: color.mute },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center' },
  row:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.md, gap: space.sm },
  rowMeta:     { flex: 1 },
  rowName:     { ...t.body, color: color.ink, fontWeight: '600' },
  rowSub:      { ...t.small, color: color.mute },
  rowError:    { ...t.small, color: '#DC2626', marginTop: 2 },
  requeueBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.ink, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8 },
  requeueText: { fontSize: 12, fontWeight: '700', color: color.onInk },
  sep:         { height: 1, backgroundColor: color.haze, marginLeft: space.md },
  emptyWrap:   { alignItems: 'center', gap: space.xs, padding: space.xl },
  empty:       { color: color.mute },
});
