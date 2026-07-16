/**
 * Admin — Schema Drift screen.
 * Shows the result of GET /api/admin/health/schema-drift: whether the live
 * database matches the migrations directory, and, when drifted, the missing
 * table.column / SQL functions plus the migration file to apply.
 * "Re-check now" calls the endpoint with ?refresh=true to re-probe the
 * live schema (e.g. to confirm a migration landed).
 * Requires admin role (enforced server-side by requireAdmin middleware).
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
import { ArrowLeft, CheckCircle2, Database, RefreshCw, TriangleAlert } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminGet } from '../../src/services/adminApi';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  applyDriftLoadResult,
  driftCount,
  type SchemaDriftReport,
} from '../../src/screens/admin/schemaDrift.machine';

function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function StatusCard({ report }: { report: SchemaDriftReport }) {
  const ok = report.status === 'ok';
  const n = driftCount(report);
  return (
    <View style={[s.statusCard, ok ? s.statusOk : s.statusDrift]}>
      {ok
        ? <CheckCircle2 size={28} color={color.success} />
        : <TriangleAlert size={28} color={color.warn} />}
      <View style={s.statusText}>
        <Text style={[s.statusTitle, { color: ok ? color.success : color.warn }]}>
          {ok ? 'Schema OK' : `Schema drift detected`}
        </Text>
        <Text style={s.statusSub}>
          {ok
            ? 'All critical columns and functions exist on the live database.'
            : `${n} missing object${n === 1 ? '' : 's'} — apply the listed migration${n === 1 ? '' : 's'}.`}
        </Text>
        {!!report.checkedAt && (
          <Text style={s.statusMeta}>
            Checked {formatDateTime(report.checkedAt)}{report.cached ? ' (cached)' : ''}
          </Text>
        )}
      </View>
    </View>
  );
}

function DriftItem({ name, migration, impact }: { name: string; migration: string; impact: string }) {
  return (
    <View style={s.item}>
      <Text style={s.itemName}>{name}</Text>
      <Text style={s.itemImpact}>{impact}</Text>
      <View style={s.migrationPill}>
        <Database size={12} color={color.mute} />
        <Text style={s.migrationText} numberOfLines={2}>{migration}</Text>
      </View>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SchemaDriftScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) { router.replace('/(auth)/sign-in' as any); }
  }, [isAuthed, sessionLoading]);

  const [report, setReport]         = useState<SchemaDriftReport | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reprobing, setReprobing]   = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const load = useCallback(async (opts?: { refresh?: boolean; silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    const path = opts?.refresh
      ? '/api/admin/health/schema-drift?refresh=true'
      : '/api/admin/health/schema-drift';
    const res = await adminGet<SchemaDriftReport>(path);
    const { report: loaded, error: loadError } = applyDriftLoadResult(res);
    if (loaded) setReport(loaded);
    setError(loadError);
    setLoading(false);
    setRefreshing(false);
    setReprobing(false);
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) load();
  }, [load, isAuthed, sessionLoading]);

  const onPullRefresh = useCallback(() => {
    setRefreshing(true);
    load({ refresh: true, silent: true });
  }, [load]);

  const onReprobe = useCallback(() => {
    setReprobing(true);
    load({ refresh: true, silent: true });
  }, [load]);

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Schema Drift</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.body}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={color.signal} />
          }
          showsVerticalScrollIndicator={false}
        >
          {!!error && (
            <View style={s.errorBox}>
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}

          {report && <StatusCard report={report} />}

          {/* Refresh (re-probe) button */}
          <Pressable
            style={({ pressed }) => [s.reprobeBtn, (pressed || reprobing) && { opacity: 0.7 }]}
            onPress={onReprobe}
            disabled={reprobing || refreshing}
            accessibilityRole="button"
            accessibilityLabel="Re-check the live schema now"
          >
            {reprobing
              ? <ActivityIndicator size="small" color={color.ink} />
              : <RefreshCw size={16} color={color.ink} />}
            <Text style={s.reprobeText}>Re-check now</Text>
          </Pressable>

          {report && report.missingColumns.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>Missing columns</Text>
              {report.missingColumns.map((c) => (
                <DriftItem
                  key={`${c.table}.${c.column}`}
                  name={`${c.table}.${c.column}`}
                  migration={c.migration}
                  impact={c.impact}
                />
              ))}
            </View>
          )}

          {report && report.missingFunctions.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>Missing functions</Text>
              {report.missingFunctions.map((f) => (
                <DriftItem
                  key={f.fn}
                  name={`${f.fn}()`}
                  migration={f.migration}
                  impact={f.impact}
                />
              ))}
            </View>
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
  backBtn: {
    width: 36, height: 36, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { ...t.title, color: color.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },

  errorBox: {
    backgroundColor: '#FDECEA',
    borderRadius: radius.md,
    padding: space.md,
  },
  errorText: { ...t.body, color: color.signalDim },

  statusCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    padding: space.lg,
    borderWidth: 1,
  },
  statusOk:    { borderColor: color.success },
  statusDrift: { borderColor: color.warn },
  statusText:  { flex: 1, gap: 2 },
  statusTitle: { ...t.body, fontWeight: '800' },
  statusSub:   { ...t.body, color: color.mute },
  statusMeta:  { ...t.small, color: color.faint, marginTop: space.xs },

  reprobeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingVertical: space.md,
  },
  reprobeText: { ...t.body, fontWeight: '700', color: color.ink },

  section: { gap: space.sm, marginTop: space.sm },
  sectionTitle: { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  item: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  itemName:   { ...t.body, fontWeight: '700', color: color.ink },
  itemImpact: { ...t.small, color: color.mute },
  migrationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space.xs,
  },
  migrationText: { ...t.small, color: color.mute, flex: 1 },
});
