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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  fetchModerationReports,
  reviewModerationReport,
  fetchReportedReviewRemovalContext,
  removeReportedReview,
  newReportedReviewOperationId,
  ReportedReviewRemovalError,
  type ReportedReviewRemovalContext,
  type ReportedReviewRemovalIntent,
  type ReportedReviewRequest,
  type ModerationReport,
  type ModerationReportStatus,
  type ModerationReviewDecision,
  type ModerationSubjectSnapshot,
  type ModerationCapturedContent,
} from '../../src/services/reportsAdmin';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';
import { reportModerationHandoff } from '../../src/services/adminUsers';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../../src/services/messagingOwnerRequest';
import { onDiscoveryScopeChange } from '../../src/services/discoveryViewerScope';
import { supabase } from '../../src/lib/supabase';

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

/** A string field of an `ok` snapshot, or null. */
function str(s: Record<string, unknown>, k: string): string | null {
  const v = s[k];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * What the moderator is shown about the reported thing, read from the keys the
 * SERVER emits for each subject type (artifacts/api-server/src/lib/
 * moderationReportSnapshots.ts READERS): `excerpt` for a post, comment, message
 * or review; `displayName`/`tagline` for a buddy listing; `title` for an event;
 * `caption` for media; `name`/`address` for a place; `name`/`handle` for a
 * person. The test renders every entry of a fixture GENERATED from those
 * readers (fixtures/moderationSubjectSnapshots.json), so this cannot drift from
 * the server again without a test going red. A failed read is never "deleted".
 */
export function snapshotLine(subjectType: string, s: ModerationSubjectSnapshot | undefined): string {
  if (!s || s.state === 'unsupported') return 'No preview for this kind of report.';
  if (s.state === 'unavailable') return 'The reported content could not be read right now — it may still exist. Reload to try again.';
  if (s.state === 'not_found') return 'The reported content no longer exists.';
  const o = s as Record<string, unknown>;
  switch (subjectType) {
    case 'post':
    case 'comment':
    case 'message': {
      if (o.deleted === true) return 'Its author deleted it before review, so its text is no longer available here.';
      return str(o, 'excerpt') ?? 'Reported content is present (no text to preview).';
    }
    case 'review': {
      const text = str(o, 'excerpt');
      const rating = typeof o.rating === 'number' ? `${o.rating}★` : null;
      return [rating, text].filter(Boolean).join(' · ') || 'Reported review is present (no text to preview).';
    }
    case 'buddy_listing':
      return [str(o, 'displayName'), str(o, 'tagline')].filter(Boolean).join(' — ') || 'Reported listing is present (no name to preview).';
    case 'event':
      return [str(o, 'title'), str(o, 'city')].filter(Boolean).join(' · ') || 'Reported event is present (no title to preview).';
    case 'media':
      return str(o, 'caption') ?? (str(o, 'mediaType') ? `A ${str(o, 'mediaType')} with no caption.` : 'Reported media is present (no caption).');
    case 'place':
      return [str(o, 'name'), str(o, 'address')].filter(Boolean).join(' — ') || 'Reported place is present (no name).';
    case 'user': {
      const name = str(o, 'name');
      const handle = str(o, 'handle');
      return [name, handle ? `@${handle}` : null].filter(Boolean).join(' ') || 'Reported person (no name to show).';
    }
    default:
      return 'Reported content is present (no preview for this kind).';
  }
}

/**
 * The reported thing's own moderation-relevant state, read from the status key
 * the SERVER emits for its subject type (moderationReportSnapshots.ts READERS):
 * a person's `accountStatus`, media's `moderationStatus`, a review's
 * `reviewState`, an event's `eventState`, a buddy listing's `listingStatus`.
 * A moderator deciding on a report needs to see whether the media is already
 * rejected or the person already deactivated (wave-5 verifier, VL5b N3). The
 * value is shown as the server sent it; nothing is inferred. Null when the
 * snapshot is not `ok` or carries no such key.
 */
const SUBJECT_STATE_KEYS: Readonly<Record<string, { key: string; label: string }>> = {
  user: { key: 'accountStatus', label: 'Account' },
  media: { key: 'moderationStatus', label: 'Media moderation' },
  review: { key: 'reviewState', label: 'Review' },
  event: { key: 'eventState', label: 'Event' },
  buddy_listing: { key: 'listingStatus', label: 'Listing' },
};

/**
 * Lead ruling Q-L23 / D-38a: the copy of the reported content taken WHEN IT WAS
 * REPORTED (moderators only), so a moderator can judge a report whose author
 * edited or deleted the content before review. Rendered with the same per-type
 * keys as the live snapshot. Null when there is no capture to show — none taken,
 * or the server has no capture table — and a failed read is said, never hidden.
 */
export function capturedLine(subjectType: string, c: ModerationCapturedContent | undefined): string | null {
  if (!c || c.state === 'none' || c.state === 'not_deployed') return null;
  if (c.state === 'unavailable') return 'The copy taken when this was reported could not be read right now. Reload to try again.';
  // The STORED outcome of the read made at report time is permanent: a reload
  // changes nothing, so it is never phrased as "right now" (V-L6d F5).
  if (c.capture.capture_state === 'unavailable') return 'When reported: the content could not be read at that moment, so no copy was kept.';
  if (c.capture.capture_state === 'not_found') return 'When reported: the content was already gone.';
  if (c.capture.capture_state === 'unsupported') return 'When reported: no copy is kept for this kind of report.';
  const snap = { state: c.capture.capture_state, ...c.capture.snapshot } as ModerationSubjectSnapshot;
  return `When reported: ${snapshotLine(subjectType, snap)}`;
}

export function snapshotState(subjectType: string, s: ModerationSubjectSnapshot | undefined): string | null {
  if (!s || s.state !== 'ok') return null;
  const spec = SUBJECT_STATE_KEYS[subjectType];
  if (!spec) return null;
  const v = str(s as Record<string, unknown>, spec.key);
  return v ? `${spec.label}: ${v}` : null;
}

type RemovalView = { request: ReportedReviewRequest; context: ReportedReviewRemovalContext | null; error: string | null; busy: boolean };
type PendingRemoval = { owner: MessagingOwnerRequest; intent: ReportedReviewRemovalIntent; busy: boolean };

function canInspectReviewRemoval(report: ModerationReport): boolean {
  return report.subject_type === 'review' && ['open', 'reviewing'].includes(report.status)
    && report.subject_snapshot?.state === 'ok' && ['published', 'hidden'].includes(String(report.subject_snapshot.reviewState));
}

export default function ModerationReportsScreen() {
  useRequireAdmin();
  const { userId, isAuthed, loading: sessionLoading } = useSession();

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
  const [removalView, setRemovalView] = useState<RemovalView | null>(null);
  const [removalPrompt, setRemovalPrompt] = useState<{ request: ReportedReviewRequest } | null>(null);
  const removalPromptRef = useRef<typeof removalPrompt>(null);
  const [, refreshRemoval] = useState(0);
  const activeRemoval = useRef<{ request: ReportedReviewRequest; controller: AbortController } | null>(null);
  const pendingRemoval = useRef<PendingRemoval | null>(null);
  const mounted = useRef(false);
  const focused = useRef(false);
  const focusEpoch = useRef(0);
  const removalIdentity = useRef('');
  removalIdentity.current = `${userId ?? ''}:${isAuthed}:${sessionLoading}:${statusFilter}`;

  const closeRemoval = useCallback((discardPending = false) => {
    const active = activeRemoval.current;
    activeRemoval.current = null;
    active?.controller.abort();
    if (active?.request.owner !== pendingRemoval.current?.owner) active?.request.owner.invalidate();
    if (discardPending) {
      pendingRemoval.current?.owner.invalidate();
      pendingRemoval.current = null;
    }
    setRemovalView(null);
    removalPromptRef.current = null;
    setRemovalPrompt(null);
  }, []);

  const blurRemoval = useCallback(() => {
    focused.current = false;
    focusEpoch.current += 1;
    closeRemoval();
  }, [closeRemoval]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    focusEpoch.current += 1;
    refreshRemoval(value => value + 1);
    return blurRemoval;
  }, [blurRemoval]));

  useEffect(() => {
    mounted.current = true;
    const checkOwner = () => {
      if ((activeRemoval.current && !activeRemoval.current.request.owner.isCurrent())
        || (pendingRemoval.current && !pendingRemoval.current.owner.isCurrent())) closeRemoval(true);
    };
    const unsubscribe = onDiscoveryScopeChange(checkOwner);
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') closeRemoval(true);
      else checkOwner();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      data.subscription.unsubscribe();
      activeRemoval.current?.controller.abort();
      activeRemoval.current?.request.owner.invalidate();
      activeRemoval.current = null;
      removalPromptRef.current = null;
      pendingRemoval.current?.owner.invalidate();
      pendingRemoval.current = null;
    };
  }, [closeRemoval]);

  useEffect(() => { closeRemoval(!isAuthed || sessionLoading); }, [userId, isAuthed, sessionLoading, statusFilter, closeRemoval]);

  const openRemoval = async (report: ModerationReport | null) => {
    if (!mounted.current || !focused.current) return;
    const pending = pendingRemoval.current;
    if (report && !canInspectReviewRemoval(report)) return;
    if (pending && !pending.owner.isCurrent()) { closeRemoval(true); return; }
    if (pending && report && pending.intent.reportId !== report.id.toLowerCase()) {
      Alert.alert('Unresolved removal', 'Recover the pending removal result before confirming another.'); return;
    }
    closeRemoval();
    const owner = pending?.owner ?? captureMessagingOwnerRequest();
    if (!owner || owner.ownerId !== userId || !isAuthed || sessionLoading) {
      Alert.alert('Removal unavailable', 'A current signed-in admin session is required.'); return;
    }
    const reviewId = pending?.intent.reviewId ?? report?.subject_id.toLowerCase();
    const reportId = pending?.intent.reportId ?? report?.id.toLowerCase();
    if (!reviewId || !reportId) return;
    const controller = new AbortController();
    const identity = removalIdentity.current;
    const epoch = focusEpoch.current;
    const request: ReportedReviewRequest = {
      owner, reviewId, reportId, signal: controller.signal,
      isCurrent: () => mounted.current && focused.current && epoch === focusEpoch.current
        && activeRemoval.current?.request === request && identity === removalIdentity.current
        && !controller.signal.aborted && owner.isCurrent(),
    };
    activeRemoval.current = { request, controller };
    setRemovalView({ request, context: null, error: pending ? 'Recover the submitted operation using its original confirmation and reason.' : null, busy: pending?.busy ?? true });
    if (pending) return;
    try {
      const context = await fetchReportedReviewRemovalContext(request);
      if (request.isCurrent()) setRemovalView({ request, context, error: null, busy: false });
    } catch (error) {
      if (request.isCurrent()) setRemovalView({ request, context: null, error: error instanceof Error ? error.message : 'Removal context unavailable.', busy: false });
    }
  };

  const submitRemoval = async (request: ReportedReviewRequest, pending: PendingRemoval) => {
    if (!request.isCurrent() || pendingRemoval.current !== pending || pending.busy) return;
    pending.busy = true;
    setRemovalView(previous => previous?.request === request ? { ...previous, busy: true, error: null } : previous);
    try {
      await removeReportedReview(request, pending.intent);
      if (!request.isCurrent()) return;
      pendingRemoval.current = null;
      closeRemoval();
      void load(1);
    } catch (error) {
      if (!request.isCurrent()) return;
      const knownRefusal = error instanceof ReportedReviewRemovalError && [400, 401, 403, 404, 409].includes(error.status);
      if (knownRefusal) pendingRemoval.current = null;
      setRemovalView({ request, context: null, busy: false,
        error: error instanceof Error ? error.message : 'Result unknown. Retry the same operation to recover it.' });
    } finally {
      pending.busy = false;
      if (mounted.current && pending.owner.isCurrent()) {
        setRemovalView(previous => previous?.request.owner === pending.owner ? { ...previous, busy: false } : previous);
        refreshRemoval(value => value + 1);
      }
    }
  };

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
    closeRemoval();
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
        <Pressable onPress={() => { blurRemoval(); router.back(); }} style={s.backBtn} accessibilityRole="button">
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
              onPress={() => { closeRemoval(); setStatusFilter(f); }}
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

      {focused.current && pendingRemoval.current && !removalView && pendingRemoval.current.owner.isCurrent() ? (
        <Pressable style={s.actionBtn} accessibilityRole="button" testID="review-removal-recover" onPress={() => { void openRemoval(null); }}>
          <Text style={s.actionText}>Recover pending review removal</Text>
        </Pressable>
      ) : null}
      {removalView && removalView.request.isCurrent() ? (
        <View style={s.row}>
          {removalView.context ? (
            <Text style={s.snapshot} testID="review-removal-preview">Current review: {removalView.context.review.rating}★ · {removalView.context.review.body ?? 'No review text.'}</Text>
          ) : null}
          <Text style={s.meta}>This removes the review and records your reason. It does not close the report or sanction its author.</Text>
          {removalView.error ? <Text style={s.errorText} accessibilityRole="alert" testID="review-removal-error">{removalView.error}</Text> : null}
          {removalView.busy ? <ActivityIndicator size="small" /> : null}
          {removalView.context && !pendingRemoval.current && !removalView.busy ? (
            <Pressable style={s.actionBtn} accessibilityRole="button" testID="review-removal-confirm" onPress={() => {
              if (removalView.request.isCurrent() && !pendingRemoval.current) {
                const nextPrompt = { request: removalView.request };
                removalPromptRef.current = nextPrompt;
                setRemovalPrompt(nextPrompt);
              }
            }}><Text style={s.actionText}>Remove review…</Text></Pressable>
          ) : null}
          {pendingRemoval.current && !removalView.busy ? (
            <Pressable style={s.actionBtn} accessibilityRole="button" testID="review-removal-retry" onPress={() => {
              const pending = pendingRemoval.current;
              if (pending && pending.owner === removalView.request.owner) void submitRemoval(removalView.request, pending);
            }}><Text style={s.actionText}>Retry same removal</Text></Pressable>
          ) : null}
          <Pressable style={s.actionBtnMuted} accessibilityRole="button" testID="review-removal-close" onPress={() => closeRemoval()}>
            <Text style={s.actionText}>Close</Text>
          </Pressable>
        </View>
      ) : null}

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
                {snapshotLine(r.subject_type, r.subject_snapshot)}
              </Text>
              {capturedLine(r.subject_type, r.captured_content) ? (
                <Text
                  style={[s.snapshot, r.captured_content?.state === 'unavailable' && s.snapshotBad]}
                  testID={`modq-captured-${r.id}`}
                >
                  {capturedLine(r.subject_type, r.captured_content)}
                </Text>
              ) : null}
              {snapshotState(r.subject_type, r.subject_snapshot) ? (
                <Text style={s.meta} testID={`modq-subject-state-${r.id}`}>
                  {snapshotState(r.subject_type, r.subject_snapshot)}
                </Text>
              ) : null}
              <Text style={s.meta}>{new Date(r.created_at).toLocaleString()}</Text>
              {canInspectReviewRemoval(r) ? (
                <Pressable style={s.actionBtn} accessibilityRole="button" testID={`modq-review-removal-context-${r.id}`}
                  onPress={() => { void openRemoval(r); }}>
                  <Text style={s.actionText}>Inspect review removal…</Text>
                </Pressable>
              ) : null}
              {reportModerationHandoff(r) ? (
                <Pressable
                  style={s.actionBtn}
                  accessibilityRole="button"
                  disabled={actioningId !== null}
                  testID={`modq-moderate-${r.id}`}
                  onPress={() => {
                    const handoff = reportModerationHandoff(r);
                    if (handoff) {
                      blurRemoval();
                      router.push({ pathname: '/admin/user-moderation', params: { ...handoff } });
                    }
                  }}
                >
                  <Text style={s.actionText}>Moderate reported user…</Text>
                </Pressable>
              ) : null}
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

      {removalPrompt && removalView?.context && removalPrompt.request === removalView.request && removalPrompt.request.isCurrent() ? (
        <ReasonPromptModal visible title="Remove this reported review" confirmLabel="Remove review" destructive
          message="Required reason for the linked admin audit. The report status is unchanged; no sanction is applied."
          onCancel={() => { removalPromptRef.current = null; setRemovalPrompt(null); }}
          onSubmit={value => {
            if (removalPromptRef.current !== removalPrompt) return;
            removalPromptRef.current = null;
            const request = removalPrompt.request;
            const context = removalView.context;
            setRemovalPrompt(null);
            if (!request.isCurrent() || !context || pendingRemoval.current) return;
            const reason = value.trim();
            if (!reason || Array.from(reason).length > 1000) {
              setRemovalView(previous => previous?.request === request ? { ...previous, error: 'Enter a reason of 1–1000 characters.' } : previous); return;
            }
            const pending: PendingRemoval = { owner: request.owner, busy: false, intent: Object.freeze({
              operationId: newReportedReviewOperationId(), reviewId: context.reviewId, reportId: context.reportId,
              reviewToken: context.reviewToken, reportToken: context.reportToken, reason,
            }) };
            pendingRemoval.current = pending;
            void submitRemoval(request, pending);
          }}
        />
      ) : null}
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
