/**
 * Admin — Account deletions.
 *
 * Settings lets a person schedule their account for deletion and shows the
 * date, but in production nothing ran on that date: the scheduled worker is
 * behind `account_deletion_worker_enabled`, which is OFF, and the manual admin
 * route (POST /admin/deletion-requests/:id/execute) had no screen.
 *
 * PRODUCT CALL (2026-11-04): deletions must actually happen (the privacy
 * policy promises it, and the App Store requires it), so the worker gets
 * switched on. Migration 2073 asks for one real request to be run through the
 * admin route first, with every step coming back ok. This screen is that step:
 * it lists pending requests, runs one by hand, and shows every step of the
 * cascade. The worker shares the cascade (AccountDeletionService), so a clean
 * run here is what makes switching the flag safe.
 *
 * Admin-only on the server (requireAdmin); useRequireAdmin only keeps a
 * non-admin from landing here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useSession } from '../../src/context/SessionContext';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  executeDeletionRequest,
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
  const workerOn = useFeatureFlags().isEnabled('account_deletion_worker_enabled');
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  const [data, setData] = useState<Load>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DeletionOutcome | null>(null);

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

  const run = useCallback(async (userId: string) => {
    setBusyId(userId);
    setRowError((e) => ({ ...e, [userId]: '' }));
    setResult(null);
    const r = await executeDeletionRequest(userId);
    setBusyId(null);
    if (!r.ok) {
      setRowError((e) => ({ ...e, [userId]: r.error }));
      return;
    }
    setResult(r.data);
    setData((d) => (d.state === 'ready' ? { state: 'ready', rows: d.rows.filter((x) => x.user_id !== userId) } : d));
  }, []);

  const confirmRun = useCallback((userId: string) => {
    Alert.alert(
      'Delete this account now?',
      'This permanently deletes the account, its posts and media, and the sign-in. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete now', style: 'destructive', onPress: () => void run(userId) },
      ],
    );
  }, [run]);

  const now = Date.now();

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Account deletions" subtitle="Pending requests; run one by hand and see every step" />
      <ScrollView contentContainerStyle={a.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={a.card} testID="deletion-worker-state">
          <Text style={a.meta}>
            {workerOn
              ? 'Automatic deletion is ON: the worker runs due requests on its own (it polls every 15 minutes while the server is up).'
              : 'Automatic deletion is OFF: nothing runs on a scheduled date until account_deletion_worker_enabled is switched on.'}
          </Text>
          {!workerOn && (
            <Text style={a.meta}>
              Run one request here first. When every step comes back ok, turn the flag on in Feature flags.
            </Text>
          )}
          <View style={a.row}>
            <AdminButton label="Open feature flags" onPress={() => router.push('/admin/feature-flags' as any)} testID="deletion-open-flags" />
          </View>
        </View>

        {result && (
          <View style={a.card} testID="deletion-result">
            <Text style={a.notice} accessibilityLiveRegion="polite">
              {result.ok ? 'Deleted. Every step finished.' : 'Finished with problems. Check the steps below.'}
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
          const due = !!r.scheduled_at && new Date(r.scheduled_at).getTime() <= now;
          return (
            <View key={r.user_id} style={a.card} testID={`deletion-${r.user_id}`}>
              <Text style={a.mono} selectable>{r.user_id}</Text>
              <Text style={a.meta}>Requested {day(r.requested_at)} · {due ? 'Due now' : `Due ${day(r.scheduled_at)}`}</Text>
              <View style={a.row}>
                <AdminButton label="Delete now" tone="danger" disabled={busyId === r.user_id} testID={`deletion-run-${r.user_id}`}
                  onPress={() => confirmRun(r.user_id)} />
              </View>
              {!!rowError[r.user_id] && <Text style={a.formError} accessibilityRole="alert">Not deleted: {rowError[r.user_id]}</Text>}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
