/** Admin recovery and explicit permanent deletion, using the existing request. */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  executeDeletionRequest,
  recoverDeletionRequest,
  reconcileDeletionRequest,
  listDeletionRequests,
  type DeletionOutcome,
  type DeletionRequest,
} from '../../src/services/adminConsole';
import {
  AdminButton,
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminLoading,
  adminStyles as a,
} from '../../src/components/admin/AdminConsoleParts';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: DeletionRequest[] };

function day(iso: string | null): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString();
}

export default function AdminDeletionRequestsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  const [data, setData] = useState<Load>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DeletionOutcome | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [recoveredNotice, setRecoveredNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData({ state: 'loading' });
    const r = await listDeletionRequests();
    setData(r.ok ? { state: 'ready', rows: r.data } : { state: 'error', message: r.error });
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) void load();
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const run = useCallback(async (row: DeletionRequest) => {
    const userId = row.user_id;
    if (!userId) return;
    const key = row.id;
    setBusyId(key);
    setRowError((e) => ({ ...e, [key]: '' }));
    setResult(null);
    const r = await executeDeletionRequest(userId, row.recovery_generation, reasons[key]?.trim() ?? '');
    setBusyId(null);
    if (!r.ok) {
      setRowError((e) => ({ ...e, [key]: r.error }));
      await load();
      return;
    }
    setResult(r.data);
    setData((d) => (d.state === 'ready' ? { state: 'ready', rows: d.rows.filter((x) => x.id !== key) } : d));
  }, [reasons, load]);

  const confirmRun = useCallback((row: DeletionRequest) => {
    Alert.alert(
      'Delete this account now?',
      'This permanently deletes the account, its posts and media, and the sign-in. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete now', style: 'destructive', onPress: () => void run(row) },
      ],
    );
  }, [run]);

  const recover = useCallback(async (row: DeletionRequest) => {
    if (!row.user_id) return;
    setBusyId(row.id); setRowError(e => ({ ...e, [row.id]: '' })); setRecoveredNotice(null);
    const r = await recoverDeletionRequest(row.user_id, row.recovery_generation, reasons[row.id]?.trim() ?? '');
    setBusyId(null);
    if (!r.ok) { setRowError(e => ({ ...e, [row.id]: r.error })); return; }
    setRecoveredNotice(r.data.accountStatus === 'active' ? 'Profile recovered. Existing moderation restrictions still apply.' : 'Profile recovered to its previous deactivated state.');
    setData(d => d.state === 'ready' ? { state: 'ready', rows: d.rows.filter(x => x.id !== row.id) } : d);
  }, [reasons]);

  const reconcile = useCallback(async (row: DeletionRequest) => {
    if (!row.deletion_request_id || !row.can_reconcile) return;
    setBusyId(row.id); setRowError(old => ({ ...old, [row.id]: '' }));
    const result = await reconcileDeletionRequest(row.deletion_request_id, row.recovery_generation, reasons[row.id]?.trim() ?? '');
    setBusyId(null);
    if (!result.ok) { setRowError(old => ({ ...old, [row.id]: result.error })); return; }
    setRecoveredNotice('Permanent deletion was verified.');
    setData(old => old.state === 'ready' ? { state: 'ready', rows: old.rows.filter(item => item.id !== row.id) } : old);
  }, [reasons]);


  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Account deletions" subtitle="Recover profiles or explicitly permanently delete them" />
      <ScrollView contentContainerStyle={a.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={a.card} testID="deletion-retention-policy">
          <Text style={a.meta}>Users can recover their own profiles for 90 days. Admin recovery remains available until an admin permanently deletes the profile.</Text>
          <Text style={a.meta}>Permanent deletion cannot be undone. Recovery does not lift bans or suspensions.</Text>
        </View>
        {recoveredNotice && <Text style={a.notice} accessibilityLiveRegion="polite" testID="deletion-recovered">{recoveredNotice}</Text>}

        {result && (
          <View style={a.card} testID="deletion-result">
            <Text style={a.notice} accessibilityLiveRegion="polite">
              {result.ok ? 'Permanent deletion verified.' : 'Finished with problems. Check the steps below.'}
            </Text>
            {result.steps.map((s) => (
              <Text key={s.step} style={s.ok ? a.meta : a.formError} testID={`deletion-step-${s.step}`}>
                {s.ok ? '✓' : '✗'} {s.step}{typeof s.count === 'number' ? ` (${s.count})` : ''}{s.error ? `: ${s.error}` : ''}
              </Text>
            ))}
            {result.warnings.map((w) => <Text key={w} style={a.formError}>Warning: {w}</Text>)}
          </View>
        )}

        {data.state === 'loading' && <AdminLoading testID="deletions-loading" />}
        {data.state === 'error' && (
          <AdminError message={`Couldn't load deletion requests: ${data.message}`} onRetry={() => void load()} testID="deletions-error" />
        )}
        {data.state === 'ready' && data.rows.length === 0 && (
          <AdminEmpty message="No accounts are waiting to be deleted." testID="deletions-empty" />
        )}
        {data.state === 'ready' && data.rows.map((r) => {
          const canRecover = !!r.user_id && r.status === 'pending' && r.recovery_verified === true && !r.execution_started_at;
          const disabled = busyId !== null || !r.recovery_generation || (reasons[r.id]?.trim().length ?? 0) < 3;
          return (
            <View key={r.id} style={a.card} testID={`deletion-${r.id}`}>
              <Text style={a.mono} selectable>{r.user_id ?? `Deletion receipt ${r.id}`}</Text>
              <Text style={a.meta}>Deleted {day(r.requested_at)} · {canRecover ? 'Recoverable by an admin' : r.status === 'executing' ? 'Permanent deletion in progress; reconcile an interrupted attempt before retrying' : r.status === 'failed' ? 'Permanent deletion incomplete; recovery is unavailable' : 'Recovery requires an integrity review'}</Text>
              <TextInput style={a.input} accessibilityLabel="Reason for profile recovery or permanent deletion" placeholder="Reason for this action" value={reasons[r.id] ?? ''} onChangeText={value => setReasons(old => ({ ...old, [r.id]: value }))} testID={`deletion-reason-${r.id}`} />
              <View style={a.row}>
                <AdminButton label="Recover profile" disabled={disabled || !canRecover} testID={`deletion-recover-${r.id}`} onPress={() => void recover(r)} />
                <AdminButton label="Permanently delete" tone="danger" disabled={disabled || !r.user_id || r.status === 'executing'} testID={`deletion-run-${r.id}`}
                  onPress={() => confirmRun(r)} />
                {r.can_reconcile && <AdminButton label="Check deletion result" disabled={disabled || !r.deletion_request_id} testID={`deletion-reconcile-${r.id}`} onPress={() => void reconcile(r)} />}
              </View>
              {!!rowError[r.id] && <Text style={a.formError} accessibilityRole="alert">Action not completed: {rowError[r.id]}</Text>}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
