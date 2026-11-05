import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, StyleSheet } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { useSession } from '../../src/context/SessionContext';
import { SettingsScreen, SettingsRow, SettingsSection } from '../../src/components/settings/SettingsUI';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';
import { captureMessagingOwnerRequest } from '../../src/services/messagingOwnerRequest';
import { onDiscoveryScopeChange } from '../../src/services/discoveryViewerScope';
import { placeTarget, getPlaceGovernanceContext, pendingPlaceGovernance, confirmPlaceGovernance, submitPlaceGovernance,
  type PlaceGovernanceContext, type PlaceGovernanceRequest, type PlaceGovernanceIntent } from '../../src/services/placeGovernance';

export default function ReportedPlaceScreen() {
  const adminLoading = useRequireAdmin();
  const { userId, role, isAuthed } = useSession();
  const params = useLocalSearchParams<{ placeId: string; reportId: string }>();
  const [action,setAction]=useState<'withhold'|'restore'|'merge'|'unmerge'>('withhold');
  const [intoId,setIntoId]=useState('');
  const request = useRef<PlaceGovernanceRequest | null>(null);
  const busyRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<PlaceGovernanceContext | null>(null);
  const [intent, setIntent] = useState<PlaceGovernanceIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [prompt, setPrompt] = useState(false);

  useFocusEffect(useCallback(() => {
    setContext(null); setError(null); setDone(false); setPrompt(false); setIntent(null);
    if (adminLoading || !isAuthed || role !== 'admin') return;
    const parsed = placeTarget.safeParse({placeId:params.placeId,reportId:params.reportId,action,intoId:action==='merge'?intoId:undefined});
    const owner = captureMessagingOwnerRequest();
    if (!parsed.success || !owner || owner.ownerId !== userId) {
      owner?.invalidate(); setError('A valid report and current admin session are required.'); return;
    }
    const controller = new AbortController();
    const current: PlaceGovernanceRequest = { owner, target: parsed.data, signal: controller.signal,
      isCurrent: () => request.current === current && !controller.signal.aborted && owner.isCurrent() };
    request.current = current;
    const prior = pendingPlaceGovernance(current);
    if (prior) current.target = {placeId:prior.placeId,reportId:prior.reportId,action:prior.action,intoId:prior.intoId};
    setIntent(prior);
    if (prior) { setError('Recover the pending place action using its original confirmation.'); setBusy(false); }
    else {
      setBusy(true);
      void getPlaceGovernanceContext(current).then(value => { if (current.isCurrent()) setContext(value); })
        .catch(cause => { if (current.isCurrent()) setError(cause instanceof Error ? cause.message : 'Context unavailable.'); })
        .finally(() => { if (current.isCurrent()) setBusy(false); });
    }
    const clear = () => { controller.abort(); owner.invalidate(); request.current = null; busyRef.current = false; };
    const unsubscribe = onDiscoveryScopeChange(() => { if (!owner.isCurrent()) { clear(); setContext(null); setIntent(null); setPrompt(false); setError('Your session changed.'); } });
    return () => { unsubscribe(); clear(); };
  }, [params.placeId, params.reportId, action, intoId, userId, role, isAuthed, adminLoading, attempt]));

  async function submit(current: PlaceGovernanceRequest, pending: PlaceGovernanceIntent) {
    if (!current.isCurrent() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setIntent(pending);
    try {
      await submitPlaceGovernance(current, pending);
      if (current.isCurrent()) { setDone(true); setIntent(null); setContext(null); }
    } catch (cause) {
      if (current.isCurrent()) { setError(cause instanceof Error ? cause.message : 'Result unavailable.'); setIntent(pendingPlaceGovernance(current)); setContext(null); }
    } finally { if (current.isCurrent()) { busyRef.current = false; setBusy(false); } }
  }
  const chosenAction=intent?.action??action;
  const label=chosenAction==='withhold'?'Withhold place':chosenAction==='restore'?'Restore place':chosenAction==='merge'?'Merge place':'Unmerge place';
  return <SettingsScreen title="Review canonical place">
    <SettingsSection title="Choose action">
      {!intent && !busy ? <>{(['withhold','restore','merge','unmerge'] as const).map(value=><SettingsRow key={value} title={value} onPress={()=>setAction(value)} />)}
        {action==='merge'?<TextInput accessibilityLabel="Surviving canonical place ID" placeholder="Surviving canonical place UUID" value={intoId} onChangeText={setIntoId} autoCapitalize="none" />:null}</>:null}
    </SettingsSection>
    <SettingsSection title="Review before acting">
      <Text style={styles.body}>Withholding removes this canonical place and its merged aliases from public place results. Its business opening status and retained reports are separate.</Text>
      <Text style={styles.body}>The report stays open. No person receives an account sanction or Trust penalty.</Text>
      {intent ? <Text selectable style={styles.body}>{intent.action} · {intent.placeId}{intent.intoId?` → ${intent.intoId}`:''} · Reason: {intent.reason}</Text> : null}
      {context ? <Text selectable style={styles.body}>{context.name} · {context.status} · {context.moderationStatus}{context.destinationName?` → ${context.destinationName}`:''}{action==='unmerge'?` · Restored lifecycle: ${context.restoreStatus}`:''}</Text> : null}
      {busy || adminLoading ? <ActivityIndicator /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {done ? <Text style={styles.body}>Action recorded. Return to the queue to review the report’s outcome.</Text> : null}
      {done ? <SettingsRow title="Return to reports" onPress={() => router.replace('/admin/moderation-reports')} /> : null}
      {context && !busy && !done ? <SettingsRow title={`${label}…`} onPress={() => setPrompt(true)} /> : null}
      {intent && !busy ? <SettingsRow title="Retry same place action" onPress={() => { if (request.current) void submit(request.current, intent); }} /> : null}
      {!intent && error && !busy ? <SettingsRow title="Reload context" onPress={() => setAttempt(value => value + 1)} /> : null}
    </SettingsSection>
    <ReasonPromptModal visible={prompt} title={label} destructive
      message="Enter the reason for the linked moderation record." confirmLabel={label}
      onCancel={() => setPrompt(false)} onSubmit={reason => {
        setPrompt(false);
        const current = request.current;
        if (!current?.isCurrent() || !context) return;
        try { void submit(current, confirmPlaceGovernance(current, context, reason)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Confirmation unavailable.'); }
      }} />
  </SettingsScreen>;
}
const styles = StyleSheet.create({ body: { padding: 16, color: '#111827', fontSize: 15 }, error: { padding: 16, color: '#B91C1C' } });
