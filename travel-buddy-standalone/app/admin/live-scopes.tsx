/**
 * Admin — Live-label scopes (testing-mode WP-21, SEN-F06).
 *
 * A place shows a LIVE crowd label only inside a promoted scope
 * (intel_live_promoted_scopes). This screen is the in-app form of the runbook
 * docs/architecture/intel-live-scope-promotion-runbook.md:
 *   - list the scopes the serve path honours right now (or every row, the audit trail);
 *   - promote a (zone, claim type) with a review horizon and the provenance the
 *     server requires — what was assessed and why the promoter signs for it;
 *   - withdraw a scope with a reason (the row is kept; serving stops at once).
 *
 * Admin-only on the server (requireAdmin in routes/admin.ts), which also gates
 * on `intel_live_scope_admin_surface_enabled` and, for writes, the 2430 writer
 * flag. When either is off the server says so and the message is shown as it is
 * — a closed surface is never rendered as "no scopes".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  buildPromoteBody,
  listLiveScopes,
  promoteLiveScope,
  withdrawLiveScope,
  type LiveScope,
} from '../../src/services/adminConsole';
import {
  AdminButton,
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminLoading,
  adminStyles as a,
} from '../../src/components/admin/AdminConsoleParts';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: LiveScope[] };

export default function AdminLiveScopesScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  const [includeInactive, setIncludeInactive] = useState(false);
  const [data, setData] = useState<Load>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const [zoneId, setZoneId] = useState('');
  const [claimType, setClaimType] = useState('');
  const [horizon, setHorizon] = useState('14');
  const [reasoning, setReasoning] = useState('');
  const [assessment, setAssessment] = useState('{}');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [withdrawReason, setWithdrawReason] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData({ state: 'loading' });
    const r = await listLiveScopes(includeInactive);
    setData(r.ok ? { state: 'ready', rows: r.data } : { state: 'error', message: r.error });
  }, [includeInactive]);

  useEffect(() => {
    if (!sessionLoading && isAuthed) void load();
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const promote = useCallback(async () => {
    setFormError(null);
    setNotice(null);
    const built = buildPromoteBody({ zoneId, claimType, horizonDays: Number(horizon), reasoning, assessmentJson: assessment });
    if (!built.ok) { setFormError(built.error); return; }
    setSubmitting(true);
    const r = await promoteLiveScope(built.body);
    setSubmitting(false);
    if (!r.ok) { setFormError(r.error); return; }
    setNotice(`${r.data.scopeKey}: ${r.data.action.replace(/_/g, ' ')} until ${new Date(r.data.expiresAt).toLocaleDateString()}.`);
    void load();
  }, [zoneId, claimType, horizon, reasoning, assessment, load]);

  const withdraw = useCallback(async (scope: LiveScope) => {
    const reason = (withdrawReason[scope.scope_key] ?? '').trim();
    if (!reason) { setRowError((e) => ({ ...e, [scope.scope_key]: 'Give a reason to withdraw.' })); return; }
    setBusyKey(scope.scope_key);
    setRowError((e) => ({ ...e, [scope.scope_key]: '' }));
    const r = await withdrawLiveScope(scope.zone_id, scope.claim_type, reason);
    setBusyKey(null);
    if (!r.ok) { setRowError((e) => ({ ...e, [scope.scope_key]: r.error })); return; }
    setNotice(`${r.data.scopeKey}: ${r.data.action.replace(/_/g, ' ')}.`);
    void load();
  }, [withdrawReason, load]);

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Live-label scopes" subtitle="Where places may show LIVE crowd labels" />
      <KeyboardSafeView
        contentContainerStyle={a.body}
        scrollViewProps={{ refreshControl: <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> }}
      >
        {!!notice && <Text style={a.notice} accessibilityLiveRegion="polite" testID="scopes-notice">{notice}</Text>}

        <View style={a.row}>
          <AdminButton label="In force" tone={!includeInactive ? 'primary' : 'neutral'} onPress={() => setIncludeInactive(false)} testID="scopes-active" />
          <AdminButton label="All, with withdrawn and expired" tone={includeInactive ? 'primary' : 'neutral'} onPress={() => setIncludeInactive(true)} testID="scopes-all" />
        </View>

        {data.state === 'loading' && <AdminLoading testID="scopes-loading" />}
        {data.state === 'error' && (
          <AdminError message={`Couldn't load live scopes: ${data.message}`} onRetry={() => void load()} testID="scopes-error" />
        )}
        {data.state === 'ready' && data.rows.length === 0 && (
          <AdminEmpty message={includeInactive ? 'No scope has ever been promoted.' : 'No scope is promoted right now — no place shows a LIVE label.'} testID="scopes-empty" />
        )}
        {data.state === 'ready' && data.rows.map((sc) => (
          <View key={sc.scope_key} style={a.card} testID={`scope-${sc.scope_key}`}>
            <Text style={a.cardTitle}>{sc.claim_type} · {sc.zone_id ?? 'all zones'}</Text>
            <Text style={a.meta}>
              {sc.state} · promoted {new Date(sc.promoted_at).toLocaleDateString()}
              {sc.expires_at ? ` · review by ${new Date(sc.expires_at).toLocaleDateString()}` : ''}
            </Text>
            {!!sc.withdrawn_reason && <Text style={a.meta}>Withdrawn: {sc.withdrawn_reason}</Text>}
            {sc.state === 'active' && (
              <>
                <TextInput
                  style={a.input}
                  placeholder="Reason to withdraw"
                  value={withdrawReason[sc.scope_key] ?? ''}
                  onChangeText={(v) => setWithdrawReason((w) => ({ ...w, [sc.scope_key]: v }))}
                  maxLength={1000}
                  accessibilityLabel={`Reason to withdraw ${sc.scope_key}`}
                />
                <View style={a.row}>
                  <AdminButton label="Withdraw" tone="danger" disabled={busyKey === sc.scope_key}
                    onPress={() => void withdraw(sc)} testID={`scope-withdraw-${sc.scope_key}`} />
                </View>
              </>
            )}
            {!!rowError[sc.scope_key] && <Text style={a.formError} accessibilityRole="alert">{rowError[sc.scope_key]}</Text>}
          </View>
        ))}

        <Text style={a.sectionTitle}>Promote a scope</Text>
        <View style={a.card}>
          <Text style={a.label}>Zone id (leave empty for the zone-less scope)</Text>
          <TextInput style={a.input} value={zoneId} onChangeText={setZoneId} autoCapitalize="none" accessibilityLabel="Zone id" testID="promote-zone" />
          <Text style={a.label}>Claim type</Text>
          <TextInput style={a.input} value={claimType} onChangeText={setClaimType} autoCapitalize="none" placeholder="e.g. crowd_level" accessibilityLabel="Claim type" testID="promote-claim" />
          <Text style={a.label}>Review horizon (days, 1–90)</Text>
          <TextInput style={a.input} value={horizon} onChangeText={setHorizon} keyboardType="number-pad" accessibilityLabel="Review horizon in days" testID="promote-horizon" />
          <Text style={a.label}>Why you are promoting it</Text>
          <TextInput style={a.input} value={reasoning} onChangeText={setReasoning} multiline maxLength={4000} accessibilityLabel="Reasoning" testID="promote-reasoning" />
          <Text style={a.label}>Density-gate assessment (JSON, from report:intel-funnel)</Text>
          <TextInput style={[a.input, a.mono]} value={assessment} onChangeText={setAssessment} multiline autoCapitalize="none" accessibilityLabel="Assessment JSON" testID="promote-assessment" />
          {!!formError && <Text style={a.formError} accessibilityRole="alert" testID="promote-error">{formError}</Text>}
          <View style={a.row}>
            <AdminButton label={submitting ? 'Promoting…' : 'Promote'} tone="primary" disabled={submitting} onPress={() => void promote()} testID="promote-submit" />
          </View>
        </View>
      </KeyboardSafeView>
    </View>
  );
}
