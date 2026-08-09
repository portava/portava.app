/**
 * Admin — Stamp Studio dashboard.
 * Shows status counts, recent activity, and links to queue + catalog.
 * Requires admin role.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ArrowLeft, Image as ImageIcon, Clock, CheckCircle, AlertTriangle, XCircle, Activity, MapPin, Copy, History } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t, dot} from '../../../src/theme/tokens';
import {
  getAdminStampCatalog,
  getStampWorkerHealth,
  type WorkerHealthWarning,
  type StampWorkerHealth,
} from '../../../src/services/adminStamps';

type StatusCounts = {
  pending_artwork: number;
  review_required: number;
  approved: number;
  rejected: number;
  archived: number;
  retryable_failed: number;
};

export default function StampStudioIndex() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [statusCounts, setStatusCounts] = useState<StatusCounts>({
    pending_artwork: 0, review_required: 0, approved: 0, rejected: 0, archived: 0, retryable_failed: 0,
  });
  const [recentEntries, setRecentEntries] = useState<any[]>([]);
  const [healthWarnings, setHealthWarnings] = useState<WorkerHealthWarning[]>([]);
  const [workerHealth, setWorkerHealth] = useState<StampWorkerHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [res, healthRes] = await Promise.all([
      getAdminStampCatalog({ limit: 10 }),
      getStampWorkerHealth(),
    ]);
    if (res.ok) {
      setStatusCounts((res.data as any).statusCounts ?? {});
      setRecentEntries((res.data as any).entries ?? []);
    }
    if (healthRes.ok) {
      setHealthWarnings(healthRes.data.warnings ?? []);
      setWorkerHealth(healthRes.data.health ?? null);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Tick so the relative "X ago" text stays accurate while the screen is open.
  const [, setClockTick] = useState(0);

  // Lightweight re-fetch of worker health only (no spinners).
  const refreshHealth = useCallback(async () => {
    const healthRes = await getStampWorkerHealth();
    if (healthRes.ok) {
      setHealthWarnings(healthRes.data.warnings ?? []);
      setWorkerHealth(healthRes.data.health ?? null);
    }
  }, []);
  const refreshHealthRef = useRef(refreshHealth);
  refreshHealthRef.current = refreshHealth;

  // Lightweight re-fetch of catalog status counts + recent entries (no spinners).
  const refreshCatalog = useCallback(async () => {
    const res = await getAdminStampCatalog({ limit: 10 });
    if (res.ok) {
      setStatusCounts((res.data as any).statusCounts ?? {});
      setRecentEntries((res.data as any).entries ?? []);
    }
  }, []);
  const refreshCatalogRef = useRef(refreshCatalog);
  refreshCatalogRef.current = refreshCatalog;

  const firstFocusRef = useRef(true);

  // Poll worker health and catalog while the screen is focused; stop when unfocused.
  useFocusEffect(
    useCallback(() => {
      // Refresh right away when returning to the screen so stale data doesn't linger.
      if (!firstFocusRef.current) {
        refreshHealthRef.current();
        refreshCatalogRef.current();
      }
      firstFocusRef.current = false;
      const healthPollId  = setInterval(() => { refreshHealthRef.current(); },  45_000);
      const catalogPollId = setInterval(() => { refreshCatalogRef.current(); }, 60_000);
      const tickId        = setInterval(() => { setClockTick((n) => n + 1); },  30_000);
      return () => {
        clearInterval(healthPollId);
        clearInterval(catalogPollId);
        clearInterval(tickId);
      };
    }, []),
  );

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const STATUS_TILES = [
    { label: 'Pending Artwork', key: 'pending_artwork', tileColor: '#F59E0B', icon: Clock },
    { label: 'Needs Review',    key: 'review_required', tileColor: '#3B82F6', icon: AlertTriangle },
    { label: 'Approved',        key: 'approved',        tileColor: '#10B981', icon: CheckCircle },
    { label: 'Rejected',        key: 'rejected',        tileColor: '#EF4444', icon: XCircle },
  ] as const;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Stamp Studio</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.ink} />
        </View>
      ) : (
        <ScrollView
          testID="stamp-studio-scroll"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
          refreshControl={<RefreshControl testID="stamp-studio-refresh" refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* Worker health warnings */}
          {healthWarnings.map((w) => (
            <View key={w.key} style={styles.warnBanner} testID={`health-warning-${w.key}`} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <AlertTriangle size={18} color="#B45309" strokeWidth={2} />
              <View style={styles.warnBody}>
                <Text style={styles.warnTitle}>
                  {w.key === 'stuck_jobs' ? 'Stuck generation jobs' : 'Backlog growing'}
                </Text>
                <Text style={styles.warnText}>{warningSummary(w)}</Text>
              </View>
            </View>
          ))}

          {/* Worker health strip */}
          {workerHealth && (
            <View style={styles.healthStrip}>
              <View style={styles.healthItem}>
                <View
                  style={[
                    styles.healthDot,
                    { backgroundColor: workerHealth.worker_running && workerHealth.worker_enabled ? '#10B981' : '#EF4444' },
                  ]}
                />
                <Text style={styles.healthText}>
                  {workerHealth.worker_running && workerHealth.worker_enabled
                    ? 'Worker running'
                    : workerHealth.worker_enabled
                      ? 'Worker stopped'
                      : 'Worker disabled'}
                </Text>
              </View>
              <View style={styles.healthItem}>
                <Clock size={14} color={color.mute} strokeWidth={2} />
                <Text style={styles.healthText}>
                  {workerHealth.last_success_at
                    ? `Last artwork ${timeAgo(workerHealth.last_success_at)}`
                    : 'No artwork generated yet'}
                </Text>
              </View>
              <View style={styles.healthItem}>
                <Activity size={14} color={color.mute} strokeWidth={2} />
                <Text style={styles.healthText}>Queued {workerHealth.queue_depth?.queued ?? 0}</Text>
              </View>
            </View>
          )}

          {/* Status tiles */}
          <Text style={styles.sectionTitle}>Catalog Status</Text>
          <View style={styles.tilesRow}>
            {STATUS_TILES.map(({ label, key, tileColor, icon: Icon }) => (
              <Pressable
                key={key}
                style={[styles.tile, { borderLeftColor: tileColor }]}
                onPress={() => router.push(`/admin/stamps/queue?status=${key}` as any)}
              >
                <Icon size={18} color={tileColor} strokeWidth={2} />
                <Text style={[styles.tileCount, { color: tileColor }]}>{statusCounts[key] ?? 0}</Text>
                <Text style={styles.tileLabel}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {/* Quick links */}
          <Text style={styles.sectionTitle}>Actions</Text>
          <View style={styles.linksCol}>
            <Pressable style={styles.linkRow} onPress={() => router.push('/admin/stamps/queue' as any)}>
              <ImageIcon size={18} color={color.deep} strokeWidth={2} />
              <Text style={styles.linkText}>Browse full catalog queue</Text>
            </Pressable>
            <Pressable style={styles.linkRow} onPress={() => router.push('/admin/stamps/queue?status=review_required' as any)}>
              <AlertTriangle size={18} color="#3B82F6" strokeWidth={2} />
              <Text style={styles.linkText}>Review pending artwork ({statusCounts.review_required ?? 0})</Text>
            </Pressable>
            <Pressable style={styles.linkRow} onPress={() => router.push('/admin/stamps/failed' as any)}>
              <XCircle size={18} color="#EF4444" strokeWidth={2} />
              <Text style={styles.linkText}>Failed generation jobs ({statusCounts.retryable_failed ?? 0})</Text>
            </Pressable>
            <Pressable style={styles.linkRow} onPress={() => router.push('/admin/stamps/reconciler-runs' as any)}>
              <History size={18} color={color.deep} strokeWidth={2} />
              <Text style={styles.linkText}>Reconciler run history</Text>
            </Pressable>
            <Pressable style={styles.linkRow} onPress={() => router.push('/admin/stamps/duplicates' as any)}>
              <Copy size={18} color={color.deep} strokeWidth={2} />
              <Text style={styles.linkText}>Duplicate entries</Text>
            </Pressable>
            <Pressable style={styles.linkRow} onPress={() => router.push('/admin/geocode-cache' as any)}>
              <MapPin size={18} color={color.deep} strokeWidth={2} />
              <Text style={styles.linkText}>Geocode Cache</Text>
            </Pressable>
          </View>

          {/* Recent entries */}
          <Text style={styles.sectionTitle}>Recent Catalog Entries</Text>
          {recentEntries.map((entry) => (
            <Pressable
              key={entry.id}
              style={styles.entryRow}
              onPress={() => router.push(`/admin/stamps/${entry.id}` as any)}
            >
              <View style={styles.entryMeta}>
                <Text style={styles.entryName}>{entry.display_name}</Text>
                <Text style={styles.entrySub}>{entry.stamp_type} · {entry.country_code}</Text>
              </View>
              <View style={styles.badgeCol}>
                {(entry.queue_status === 'queued' || entry.queue_status === 'processing') && (
                  <View style={[styles.statusBadge, styles.regenBadge]} testID={`recent-regen-badge-${entry.id}`}>
                    <Text style={[styles.statusText, styles.regenBadgeText]}>
                      {entry.queue_status === 'processing' ? 'regenerating' : 'queued'}
                    </Text>
                  </View>
                )}
                <View style={[styles.statusBadge, { backgroundColor: statusBg(entry.status) }]}>
                  <Text style={styles.statusText}>{entry.status}</Text>
                </View>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function warningSummary(w: WorkerHealthWarning): string {
  if (w.key === 'stuck_jobs') {
    const n = Number((w.details as any)?.stuck_count ?? 0);
    return `${n} job${n === 1 ? '' : 's'} stuck in 'generating' past lock expiry — the worker may have crashed.`;
  }
  const queued = (w.details as any)?.queued;
  const prev = (w.details as any)?.previous_queued;
  return `Queued backlog grew from ${prev ?? '?'} to ${queued ?? '?'} while the worker is enabled — it may be stalled.`;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusBg(status: string) {
  switch (status) {
    case 'approved':        return '#D1FAE5';
    case 'pending_artwork': return '#FEF3C7';
    case 'rejected':        return '#FEE2E2';
    default:                return '#E5E7EB';
  }
}

const styles = StyleSheet.create({
  root:         { flex: 1, backgroundColor: color.paper },
  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:      { marginRight: space.sm },
  title:        { ...t.heading, color: color.ink },
  center:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content:      { padding: space.md, gap: space.sm },
  sectionTitle: { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.md, marginBottom: space.xs },
  healthStrip:  { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: color.haze },
  healthItem:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  healthDot:    { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2 },
  healthText:   { ...t.small, color: color.ink },
  warnBanner:   { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D', borderRadius: radius.md, padding: space.md },
  warnBody:     { flex: 1, gap: 2 },
  warnTitle:    { ...t.body, color: '#92400E', fontWeight: '700' },
  warnText:     { ...t.small, color: '#92400E' },
  tilesRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile:         { flex: 1, minWidth: 140, backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, borderLeftWidth: 4, gap: 4, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  tileCount:    { fontSize: 28, fontWeight: '800', fontFamily: 'Courier' },
  tileLabel:    { ...t.small, color: color.mute },
  linksCol:     { gap: space.xs },
  linkRow:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze },
  linkText:     { ...t.body, color: color.ink, flex: 1 },
  entryRow:     { flexDirection: 'row', alignItems: 'center', backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze },
  entryMeta:    { flex: 1 },
  entryName:    { ...t.body, color: color.ink, fontWeight: '600' },
  entrySub:     { ...t.small, color: color.mute },
  badgeCol:     { alignItems: 'flex-end', gap: 4 },
  statusBadge:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  regenBadge:     { backgroundColor: '#EDE9FE', borderWidth: 1, borderColor: '#C4B5FD' },
  regenBadgeText: { color: '#6D28D9' },
  statusText:   { fontSize: 10, fontWeight: '700', color: color.ink },
});
