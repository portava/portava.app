/**
 * Admin — User reports (the moderation queue).
 *
 * The in-app Report button writes `moderation_reports` (src/services/moderation.ts).
 * The older Content Reports screen reads the legacy `reports` table, so until this
 * screen no client could see — let alone close — a report a person filed in the
 * app (census-trust TV-4a; verifier finding 10, 2026-10-06).
 *
 * Reads GET /api/admin/moderation/reports and acts through
 * POST /api/admin/moderation/reports/:id/review. The rules this screen holds:
 *   - a queue that FAILED to load is an announced error with a retry, never
 *     "no reports";
 *   - a reported item whose snapshot could not be READ says so — it is not
 *     shown as deleted content — and a page with failed snapshot reads says it
 *     is incomplete;
 *   - a decision changes the row only after the server confirmed it; a refusal
 *     (someone else closed it first, or try again) leaves the row as it was and
 *     says why;
 *   - the moderator's note goes to the server's audit record only; the reporter
 *     never sees it (migration 3700).
 * Requires admin role (useRequireAdmin + server-side requireAdmin).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  fetchModerationReports,
  reviewModerationReport,
  type ModerationReport,
  type ModerationReportStatus,
  type ModerationReviewDecision,
  type ModerationSubjectSnapshot,
} from '../../src/services/reportsAdmin';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';

const STATUS_FILTERS = ['open', 'reviewing', 'actioned', 'dismissed', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** MODERATION_REPORT_TRANSITIONS on the server: terminal states move nowhere. */
const NEXT: Record<ModerationReportStatus, ModerationReviewDecision[]> = {
  open: ['reviewing', 'actioned', 'dismissed'],
  reviewing: ['actioned', 'dismissed'],
  actioned: [],
  dismissed: [],
};

const DECISION_LABEL: Record<ModerationReviewDecision, string> = {
  reviewing: 'Start review',
  actioned: 'Action',
  dismissed: 'Dismiss',
};

const PAGE = 30;

/** What the moderator is shown about the reported thing. A failed read is never "deleted". */
export function snapshotLine(s: ModerationSubjectSnapshot | undefined): string {
  if (!s || s.state === 'unsupported') return 'No preview for this kind of report.';
  if (s.state === 'unavailable') return 'The reported content could not be read right now — it may still exist. Reload to try again.';
  if (s.state === 'not_found') return 'The reported content no longer exists.';
  const text = ['text', 'content', 'body', 'title', 'name', 'caption', 'display_name', 'handle']
    .map((k) => s[k])
    .find((v) => typeof v === 'string' && v.trim().length > 0) as string | undefined;
  return text ? text.slice(0, 280) : 'Reported content is present (no text to preview).';
}

export default function ModerationReportsScreen() {
  useRequireAdmin();
  const { isAuthed, loading: sessionLoading } = useSession();

  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [incomplete, setIncomplete] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ report: ModerationReport; decision: ModerationReviewDecision } | null>(null);

  const load = useCallback(async (p = 1, append = false) => {
    if (!isAuthed) return;
    try {
      setError(null);
      const data = await fetchModerationReports({ page: p, limit: PAGE, status: statusFilter });
      setReports((prev) => (append ? [...prev, ...data.reports] : data.reports));
      setTotal(data.total);
      setPage(p);
      setIncomplete(data.snapshotsUnavailableFor ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the moderation queue');
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
    if (page < Math.ceil(total / PAGE) && !loading) load(page + 1, true);
  };

  const decide = async (report: ModerationReport, decision: ModerationReviewDecision, note: string | null) => {
    setActioningId(report.id);
    try {
      const out = await reviewModerationReport(report.id, decision, note);
      const status = out?.report?.status ?? decision;
      setReports((prev) => prev.map((r) => (r.id === report.id ? { ...r, status } : r)));
    } catch (e: any) {
      Alert.alert('Nothing was changed', e?.message ?? 'The review could not be recorded.');
    } finally {
      setActioningId(null);
    }
  };

  const onPress = (report: ModerationReport, decision: ModerationReviewDecision) => {
    if (decision === 'reviewing') { void decide(report, decision, null); return; }
    setPrompt({ report, decision });
  };

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn} accessibilityRole="button">
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <Text style={s.title}>User Reports</Text>
        <Text style={s.subtitle}>{total} in this view · reports filed with the in-app Report button</Text>
      </View>

      <View style={s.filters}>
        <FlatList
          data={STATUS_FILTERS as unknown as StatusFilter[]}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => `mf-${f}`}
          contentContainerStyle={s.filterRow}
          renderItem={({ item: f }) => (
            <Pressable
              style={[s.chip, statusFilter === f && s.chipActive]}
              onPress={() => setStatusFilter(f)}
              accessibilityRole="button"
              accessibilityState={{ selected: statusFilter === f }}
              testID={`modq-filter-${f}`}
            >
              <Text style={[s.chipText, statusFilter === f && s.chipTextActive]}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </Pressable>
          )}
        />
      </View>

      {incomplete.length > 0 && !error ? (
        <View style={s.warn} testID="modq-incomplete" accessibilityRole="alert">
          <Text style={s.warnText}>
            Some reported items could not be read ({incomplete.join(', ')}). Their rows say so; reload before deciding on them.
          </Text>
        </View>
      ) : null}

      {loading && !refreshing ? (
        <View style={s.centered}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      ) : error ? (
        <View style={s.centered} testID="modq-error" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={s.errorText}>{error}</Text>
          <Pressable
            style={s.retryBtn}
            accessibilityRole="button"
            testID="modq-retry"
            onPress={() => { setLoading(true); load(1).finally(() => setLoading(false)); }}
          >
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
            <View style={s.centered} testID="modq-empty">
              <Text style={s.emptyText}>No reports</Text>
            </View>
          }
          renderItem={({ item: r }) => (
            <View style={s.row} testID={`modq-row-${r.id}`}>
              <View style={s.rowTop}>
                <Text style={s.reason}>{r.category.replace(/_/g, ' ')}</Text>
                <Text style={s.meta}>{r.subject_type}</Text>
                <Text style={s.status} testID={`modq-status-${r.id}`}>{r.status}</Text>
              </View>
              {r.details ? <Text style={s.details}>Reporter: “{r.details}”</Text> : null}
              <Text
                style={[s.snapshot, r.subject_snapshot?.state === 'unavailable' && s.snapshotBad]}
                testID={`modq-snapshot-${r.id}`}
              >
                {snapshotLine(r.subject_snapshot)}
              </Text>
              <Text style={s.meta}>{new Date(r.created_at).toLocaleString()}</Text>
              {NEXT[r.status]?.length ? (
                <View style={s.actions}>
                  {actioningId === r.id ? (
                    <ActivityIndicator size="small" color="#3B82F6" />
                  ) : (
                    NEXT[r.status].map((d) => (
                      <Pressable
                        key={d}
                        style={[s.actionBtn, d === 'dismissed' && s.actionBtnMuted]}
                        onPress={() => onPress(r, d)}
                        accessibilityRole="button"
                        testID={`modq-${d}-${r.id}`}
                      >
                        <Text style={s.actionText}>{DECISION_LABEL[d]}</Text>
                      </Pressable>
                    ))
                  )}
                </View>
              ) : null}
            </View>
          )}
        />
      )}

      <ReasonPromptModal
        visible={prompt !== null}
        title={prompt ? `${DECISION_LABEL[prompt.decision]} this report` : ''}
        message="Optional note for the audit record. The person who reported it never sees this note."
        placeholder="Note (optional)"
        confirmLabel={prompt ? DECISION_LABEL[prompt.decision] : 'Confirm'}
        requireValue={false}
        destructive={prompt?.decision === 'actioned'}
        onCancel={() => setPrompt(null)}
        onSubmit={(value) => {
          const p = prompt;
          setPrompt(null);
          if (p) void decide(p.report, p.decision, value || null);
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  header: { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 8 },
  backBtn: { paddingVertical: 6 },
  backText: { color: '#3B82F6', fontSize: 15 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  filters: { paddingVertical: 6 },
  filterRow: { paddingHorizontal: 16, gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#E5E7EB' },
  chipActive: { backgroundColor: '#1F2937' },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#FFFFFF' },
  warn: { marginHorizontal: 16, marginBottom: 6, padding: 10, borderRadius: 8, backgroundColor: '#FEF3C7' },
  warnText: { fontSize: 13, color: '#92400E' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: '#B91C1C', textAlign: 'center', marginBottom: 12 },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: '#3B82F6' },
  retryText: { color: '#FFFFFF', fontWeight: '600' },
  emptyText: { color: '#6B7280' },
  list: { padding: 16, gap: 10 },
  row: { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reason: { fontSize: 15, fontWeight: '600', color: '#111827', textTransform: 'capitalize' },
  meta: { fontSize: 12, color: '#6B7280' },
  status: { marginLeft: 'auto', fontSize: 12, fontWeight: '600', color: '#374151' },
  details: { fontSize: 13, color: '#374151' },
  snapshot: { fontSize: 13, color: '#111827' },
  snapshotBad: { color: '#B45309' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  actionBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#1F2937' },
  actionBtnMuted: { backgroundColor: '#6B7280' },
  actionText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
});
