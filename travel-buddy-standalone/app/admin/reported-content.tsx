import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Text, StyleSheet } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { useSession } from '../../src/context/SessionContext';
import { SettingsScreen, SettingsRow, SettingsSection } from '../../src/components/settings/SettingsUI';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';
import { captureMessagingOwnerRequest } from '../../src/services/messagingOwnerRequest';
import { onDiscoveryScopeChange } from '../../src/services/discoveryViewerScope';
import { removalTarget, getContentRemovalContext, pendingContentRemoval, confirmContentRemoval, submitContentRemoval,
  type ContentRemovalContext, type ContentRemovalRequest, type ContentRemovalIntent } from '../../src/services/reportedContentRemoval';

export default function ReportedContentScreen() {
  const adminLoading = useRequireAdmin();
  const { userId, role, isAuthed } = useSession();
  const params = useLocalSearchParams<{ subjectType: string; subjectId: string; reportId: string }>();
  const request = useRef<ContentRemovalRequest | null>(null);
  const busyRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<ContentRemovalContext | null>(null);
  const [intent, setIntent] = useState<ContentRemovalIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [prompt, setPrompt] = useState(false);

  useFocusEffect(useCallback(() => {
    setContext(null); setError(null); setDone(false); setPrompt(false); setIntent(null);
    if (adminLoading || !isAuthed || role !== 'admin') return;
    const parsed = removalTarget.safeParse(params);
    const owner = captureMessagingOwnerRequest();
    if (!parsed.success || !owner || owner.ownerId !== userId) {
      owner?.invalidate(); setError('A valid report and current admin session are required.'); return;
    }
    const controller = new AbortController();
    const current: ContentRemovalRequest = { owner, target: parsed.data, signal: controller.signal,
      isCurrent: () => request.current === current && !controller.signal.aborted && owner.isCurrent() };
    request.current = current;
    const prior = pendingContentRemoval(current);
    setIntent(prior);
    if (prior) { setError('Recover the pending removal using its original confirmation.'); setBusy(false); }
    else {
      setBusy(true);
      void getContentRemovalContext(current).then(value => { if (current.isCurrent()) setContext(value); })
        .catch(cause => { if (current.isCurrent()) setError(cause instanceof Error ? cause.message : 'Context unavailable.'); })
        .finally(() => { if (current.isCurrent()) setBusy(false); });
    }
    const clear = () => { controller.abort(); owner.invalidate(); request.current = null; busyRef.current = false; };
    const unsubscribe = onDiscoveryScopeChange(() => { if (!owner.isCurrent()) { clear(); setContext(null); setIntent(null); setPrompt(false); setError('Your session changed.'); } });
    return () => { unsubscribe(); clear(); };
  }, [params.subjectType, params.subjectId, params.reportId, userId, role, isAuthed, adminLoading, attempt]));

  async function submit(current: ContentRemovalRequest, pending: ContentRemovalIntent) {
    if (!current.isCurrent() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setIntent(pending);
    try {
      await submitContentRemoval(current, pending);
      if (current.isCurrent()) { setDone(true); setIntent(null); setContext(null); }
    } catch (cause) {
      if (current.isCurrent()) { setError(cause instanceof Error ? cause.message : 'Result unavailable.'); setIntent(pendingContentRemoval(current)); setContext(null); }
    } finally { if (current.isCurrent()) { busyRef.current = false; setBusy(false); } }
  }
  const listing = params.subjectType === 'buddy_listing';
  return <SettingsScreen title={listing ? 'Suspend reported listing' : 'Remove reported content'}>
    <SettingsSection title="Review before acting">
      <Text style={styles.body}>{listing
        ? 'Suspends this Buddy listing and records the reason. Existing bookings are not cancelled.'
        : params.subjectType === 'event' ? 'Archives this event and hides it from normal discovery. Attendance history is retained.'
        : 'Removes this item from normal retrieval and records the reason. Its retained evidence is not erased.'}</Text>
      <Text style={styles.body}>The report stays open. This action does not apply an account sanction or Trust penalty.</Text>
      {context ? <Text selectable style={styles.body}>{context.preview || 'This item has no text preview. Inspect the reported item before acting.'}</Text> : null}
      {busy || adminLoading ? <ActivityIndicator /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {done ? <Text style={styles.body}>Action recorded. Return to the queue to review the report’s outcome.</Text> : null}
      {done ? <SettingsRow title="Return to reports" onPress={() => router.replace('/admin/moderation-reports')} /> : null}
      {context && !busy && !done ? <SettingsRow title={listing ? 'Suspend listing…' : 'Remove content…'} onPress={() => setPrompt(true)} /> : null}
      {intent && !busy ? <SettingsRow title="Retry same removal" onPress={() => { if (request.current) void submit(request.current, intent); }} /> : null}
      {!intent && error && !busy ? <SettingsRow title="Reload context" onPress={() => setAttempt(value => value + 1)} /> : null}
    </SettingsSection>
    <ReasonPromptModal visible={prompt} title={listing ? 'Suspend this listing' : 'Remove this item'} destructive
      message="Enter the reason for the linked moderation record." confirmLabel={listing ? 'Suspend listing' : 'Remove content'}
      onCancel={() => setPrompt(false)} onSubmit={reason => {
        setPrompt(false);
        const current = request.current;
        if (!current?.isCurrent() || !context) return;
        try { void submit(current, confirmContentRemoval(current, context, reason)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Confirmation unavailable.'); }
      }} />
  </SettingsScreen>;
}
const styles = StyleSheet.create({ body: { padding: 16, color: '#111827', fontSize: 15 }, error: { padding: 16, color: '#B91C1C' } });
