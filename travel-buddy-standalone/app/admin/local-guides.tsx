/**
 * Admin — Local guide applications (testing-mode WP-21, PLAT-F38).
 *
 * Closes the "apply → admin approves → guide profile shows" loop: an applicant
 * (gems/guide → Apply) is `applicant` until an admin sets them `active` here.
 * Decline sets `demoted`, the only non-active state the profile table allows
 * for someone who was never approved.
 *
 * Admin-only on the server (isAdmin in routes/hiddenGems.ts); every decision is
 * audit-logged there with the admin's id. A row leaves the list only after the
 * server confirms the status changed — a user with no guide profile answers
 * 404 and a refused write answers an error, and both are shown on the row.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  listGuideApplications,
  setGuideStatus,
  type GuideApplication,
  type GuideStatus,
} from '../../src/services/adminConsole';
import {
  AdminButton,
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminLoading,
  adminStyles as a,
} from '../../src/components/admin/AdminConsoleParts';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: GuideApplication[] };

export default function AdminLocalGuidesScreen() {
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
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData({ state: 'loading' });
    const r = await listGuideApplications();
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

  const decide = useCallback(async (userId: string, status: GuideStatus) => {
    setBusyId(userId);
    setRowError((e) => ({ ...e, [userId]: '' }));
    setDone(null);
    const r = await setGuideStatus(userId, status);
    setBusyId(null);
    if (!r.ok) {
      setRowError((e) => ({ ...e, [userId]: r.error }));
      return;
    }
    setDone(status === 'active' ? 'Approved — their guide profile is now public.' : 'Declined.');
    setData((d) => (d.state === 'ready' ? { state: 'ready', rows: d.rows.filter((g) => g.user_id !== userId) } : d));
  }, []);

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Local guides" subtitle="Approve or decline guide applications" />
      <ScrollView contentContainerStyle={a.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!!done && <Text style={a.notice} accessibilityLiveRegion="polite" testID="guides-done">{done}</Text>}
        {data.state === 'loading' && <AdminLoading testID="guides-loading" />}
        {data.state === 'error' && (
          <AdminError message={`Couldn't load guide applications: ${data.message}`} onRetry={() => void load()} testID="guides-error" />
        )}
        {data.state === 'ready' && data.rows.length === 0 && (
          <AdminEmpty message="No guide applications are waiting." testID="guides-empty" />
        )}
        {data.state === 'ready' && data.rows.map((g) => (
          <View key={g.user_id} style={a.card} testID={`guide-${g.user_id}`}>
            <Text style={a.mono} selectable>{g.user_id}</Text>
            <Text style={a.meta}>
              {(g.city_expertise ?? []).length > 0 ? `Knows: ${(g.city_expertise ?? []).join(', ')}` : 'No cities listed'}
              {` · ${g.contribution_count} contribution${g.contribution_count === 1 ? '' : 's'}`}
            </Text>
            <Text style={a.meta}>Applied {new Date(g.created_at).toLocaleDateString()}</Text>
            <View style={a.row}>
              <AdminButton label="Approve" tone="primary" disabled={busyId === g.user_id} testID={`guide-approve-${g.user_id}`}
                onPress={() => void decide(g.user_id, 'active')} />
              <AdminButton label="Decline" tone="danger" disabled={busyId === g.user_id} testID={`guide-decline-${g.user_id}`}
                onPress={() => void decide(g.user_id, 'demoted')} />
            </View>
            {!!rowError[g.user_id] && <Text style={a.formError} accessibilityRole="alert">Not changed: {rowError[g.user_id]}</Text>}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
