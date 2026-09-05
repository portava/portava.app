/**
 * The shared renderer behind the four §24 / Table-32 intel dashboards
 * (Truth health, Calibration, Decision, Economy).
 *
 * All four read ONE admin endpoint — GET /api/v1/internal/intel/observability —
 * and each screen renders one section of it. They share this component so the
 * rule that matters cannot be implemented four times and drift three ways:
 *
 *   A METRIC THE SERVER DID NOT MEASURE RENDERS AS "Not instrumented",
 *   NEVER AS A ZERO.
 *
 * Formatting is delegated wholly to src/screens/admin/intelObservability.machine
 * (pure, unit-tested); this file adds no numeric branch of its own. A metric's
 * status badge is always drawn next to its figure, so an UPPER_BOUND figure —
 * real, but larger than the truth — can never be mistaken for a measurement.
 *
 * ADMIN ONLY. The server gates the endpoint with requireAdmin; useRequireAdmin
 * additionally keeps a non-admin from ever landing on the screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, CircleHelp, TriangleAlert } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminGet } from '../services/adminApi.ts';
import { useSession } from '../context/SessionContext.tsx';
import { useRequireAdmin } from '../hooks/useRequireAdmin.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import {
  applyObservabilityLoadResult,
  densityGateSummary,
  formatMetricValue,
  metricShareLabel,
  sectionOf,
  statusLabel,
  uninstrumentedCount,
  type ObservabilityDistribution,
  type ObservabilityMetric,
  type ObservabilityReport,
  type ObservabilitySectionKey,
} from '../screens/admin/intelObservability.machine.ts';

const WINDOW_DAYS = 7;

function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ObservabilityMetric['status'] }) {
  const measured = status === 'MEASURED';
  const absent = status === 'UNINSTRUMENTED';
  return (
    <View
      style={[
        s.badge,
        measured && s.badgeMeasured,
        !measured && !absent && s.badgeBound,
        absent && s.badgeAbsent,
      ]}
    >
      <Text style={[s.badgeText, absent && s.badgeTextAbsent]}>{statusLabel(status)}</Text>
    </View>
  );
}

function MetricRow({ metric }: { metric: ObservabilityMetric }) {
  const absent = metric.status === 'UNINSTRUMENTED';
  const share = metricShareLabel(metric);
  return (
    <View style={s.metric} testID={`intel-metric-${metric.key}`}>
      <View style={s.metricHead}>
        <Text style={s.metricLabel}>{metric.label}</Text>
        <StatusBadge status={metric.status} />
      </View>
      <Text style={[s.metricValue, absent && s.metricValueAbsent]} testID={`intel-metric-value-${metric.key}`}>
        {formatMetricValue(metric)}
      </Text>
      {!!share && <Text style={s.metricShare}>{share}</Text>}
      {!!metric.note && <Text style={s.metricNote}>{metric.note}</Text>}
    </View>
  );
}

function DistributionCard({ distribution }: { distribution: ObservabilityDistribution }) {
  const absent = distribution.status === 'UNINSTRUMENTED';
  const buckets = distribution.buckets ?? [];
  const max = buckets.reduce((m, b) => (b.count > m ? b.count : m), 0);
  return (
    <View style={s.dist} testID={`intel-distribution-${distribution.key}`}>
      <View style={s.metricHead}>
        <Text style={s.metricLabel}>{distribution.label}</Text>
        <StatusBadge status={distribution.status} />
      </View>
      {absent ? (
        <Text style={[s.metricValue, s.metricValueAbsent]}>{statusLabel(distribution.status)}</Text>
      ) : (
        buckets.map((b) => (
          <View key={b.key} style={s.bar}>
            <Text style={s.barKey} numberOfLines={1}>{b.key}</Text>
            <View style={s.barTrack}>
              <View style={[s.barFill, { width: max > 0 ? `${Math.round((b.count / max) * 100)}%` : 0 }]} />
            </View>
            <Text style={s.barCount}>{b.count}</Text>
          </View>
        ))
      )}
      {distribution.unknownValues.length > 0 && (
        <View style={s.unknownBox}>
          <TriangleAlert size={14} color={color.warn} />
          <Text style={s.unknownText}>
            Unrecognised value{distribution.unknownValues.length === 1 ? '' : 's'}: {distribution.unknownValues.join(', ')} — the writer emits something this build does not know.
          </Text>
        </View>
      )}
      {!!distribution.note && <Text style={s.metricNote}>{distribution.note}</Text>}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export interface IntelObservabilityDashboardProps {
  /** Which Table-32 section this screen renders. */
  section: ObservabilitySectionKey;
  /** Screen title (matches the PORTAVA_ROUTES entry). */
  title: string;
}

export default function IntelObservabilityDashboard({ section, title }: IntelObservabilityDashboardProps) {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) { router.replace('/(auth)/sign-in' as any); }
  }, [isAuthed, sessionLoading]);

  const [report, setReport]         = useState<ObservabilityReport | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    const res = await adminGet<unknown>(`/api/v1/internal/intel/observability?windowDays=${WINDOW_DAYS}`);
    const { report: loaded, error: loadError } = applyObservabilityLoadResult(res);
    setReport(loaded);
    setError(loadError);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) void load();
  }, [load, isAuthed, sessionLoading]);

  const onPullRefresh = useCallback(() => {
    setRefreshing(true);
    void load({ silent: true });
  }, [load]);

  const current = sectionOf(report, section);
  const absentCount = uninstrumentedCount(current);

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>{title}</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={color.signal} />}
          showsVerticalScrollIndicator={false}
        >
          {!!error && (
            <View style={s.errorBox} testID="intel-observability-error" accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}

          {!!report && !current && !error && (
            <View style={s.errorBox} testID="intel-observability-missing-section">
              <Text style={s.errorText}>This dashboard&apos;s section was not present in the report.</Text>
            </View>
          )}

          {!!current && (
            <>
              <View style={s.meta}>
                <Text style={s.metaLine}>Table 32 — {current.requiredMetrics}</Text>
                <Text style={s.metaSub}>
                  {report?.windowDays ?? 0}-day window · generated {formatDateTime(report?.generatedAt ?? '')}
                </Text>
                {!!report && (
                  <Text style={[s.metaSub, !report.densityGate.certifiable && s.metaWarn]} testID="intel-density-gate">
                    {densityGateSummary(report.densityGate)}
                  </Text>
                )}
              </View>

              {absentCount > 0 && (
                <View style={s.absentBanner} testID="intel-absent-banner">
                  <CircleHelp size={16} color={color.mute} />
                  <Text style={s.absentText}>
                    {absentCount} figure{absentCount === 1 ? '' : 's'} on this dashboard {absentCount === 1 ? 'is' : 'are'} not instrumented.
                    They are shown as &ldquo;{statusLabel('UNINSTRUMENTED')}&rdquo; rather than as zero, because no measurement exists — not because the value is zero.
                  </Text>
                </View>
              )}

              {current.metrics.map((m) => <MetricRow key={m.key} metric={m} />)}
              {current.distributions.map((d) => <DistributionCard key={d.key} distribution={d} />)}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  backBtn: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.title, color: color.ink, flex: 1, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },

  errorBox: { backgroundColor: '#FDECEA', borderRadius: radius.md, padding: space.md },
  errorText: { ...t.body, color: color.signalDim },

  meta: { gap: 2 },
  metaLine: { ...t.small, color: color.mute, fontWeight: '700' },
  metaSub: { ...t.small, color: color.faint },
  metaWarn: { color: color.warn, fontWeight: '700' },

  absentBanner: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  absentText: { ...t.small, color: color.mute, flex: 1 },

  metric: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  metricHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm },
  metricLabel: { ...t.small, color: color.mute, fontWeight: '700', flex: 1 },
  metricValue: { ...t.title, color: color.ink },
  metricValueAbsent: { ...t.body, color: color.faint, fontWeight: '700' },
  metricShare: { ...t.small, color: color.mute },
  metricNote: { ...t.small, color: color.faint },

  badge: { paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1 },
  badgeMeasured: { borderColor: color.success },
  badgeBound: { borderColor: color.warn },
  badgeAbsent: { borderColor: color.haze, backgroundColor: color.paper },
  badgeText: { ...t.small, fontSize: 11, color: color.mute, fontWeight: '700' },
  badgeTextAbsent: { color: color.faint },

  dist: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  barKey: { ...t.small, color: color.mute, width: 120 },
  barTrack: { flex: 1, height: 8, borderRadius: radius.pill, backgroundColor: color.haze, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: radius.pill, backgroundColor: color.deep },
  barCount: { ...t.small, color: color.ink, fontWeight: '700', minWidth: 28, textAlign: 'right' },

  unknownBox: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', marginTop: space.xs },
  unknownText: { ...t.small, color: color.warn, flex: 1 },
});
