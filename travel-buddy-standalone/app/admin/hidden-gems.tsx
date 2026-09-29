/**
 * Admin — Hidden gem review (testing-mode WP-21, PLAT-F39).
 *
 * Closes the submit → approved loop in the app: a submitted gem is `pending`
 * and never appears in Hidden Gems until an admin approves it here.
 *   Pending  — Approve (→ active, the submitter's stamp is awarded server-side)
 *              or Reject (→ hidden), with an optional note.
 *   Reported — Uphold (gem hidden, author charged GEM_DISPUTED) or Dismiss
 *              (gem restored, report count cleared).
 *
 * Admin-only on the server (isAdmin in routes/hiddenGems.ts). A row leaves the
 * list only after the server says the decision was recorded; a refusal is
 * shown on the row and the row stays.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, Text, TextInput, View } from 'react-native';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  listPendingGems,
  listReportedGems,
  resolveGemReports,
  verifyGem,
  type PendingGem,
  type ReportedGem,
} from '../../src/services/adminConsole';
import {
  AdminButton,
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminLoading,
  adminStyles as a,
} from '../../src/components/admin/AdminConsoleParts';

type Tab = 'pending' | 'reported';
type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: T[] };

function place(g: { city: string | null; country: string | null }): string {
  return [g.city, g.country].filter(Boolean).join(', ') || 'No location';
}

export default function AdminHiddenGemsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  const [tab, setTab] = useState<Tab>('pending');
  const [pending, setPending] = useState<Load<PendingGem>>({ state: 'loading' });
  const [reported, setReported] = useState<Load<ReportedGem>>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async (which: Tab) => {
    if (which === 'pending') {
      setPending({ state: 'loading' });
      const r = await listPendingGems();
      setPending(r.ok ? { state: 'ready', rows: r.data } : { state: 'error', message: r.error });
    } else {
      setReported({ state: 'loading' });
      const r = await listReportedGems();
      setReported(r.ok ? { state: 'ready', rows: r.data } : { state: 'error', message: r.error });
    }
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) void load(tab);
  }, [tab, load, isAuthed, sessionLoading]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(tab);
    setRefreshing(false);
  }, [load, tab]);

  const act = useCallback(async (id: string, run: () => Promise<{ ok: boolean; error?: string }>, which: Tab) => {
    setBusyId(id);
    setRowError((e) => ({ ...e, [id]: '' }));
    const r = await run();
    setBusyId(null);
    if (!r.ok) {
      setRowError((e) => ({ ...e, [id]: (r as { error?: string }).error ?? 'The decision was not recorded.' }));
      return;
    }
    // Recorded on the server: only now does the row leave its queue.
    if (which === 'pending') setPending((p) => (p.state === 'ready' ? { state: 'ready', rows: p.rows.filter((g) => g.id !== id) } : p));
    else setReported((p) => (p.state === 'ready' ? { state: 'ready', rows: p.rows.filter((g) => g.id !== id) } : p));
  }, []);

  const current = tab === 'pending' ? pending : reported;

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Hidden gem review" subtitle="Approve submitted gems and resolve reports" />
      <View style={a.tabs}>
        <AdminButton label="Pending" tone={tab === 'pending' ? 'primary' : 'neutral'} onPress={() => setTab('pending')} testID="gems-tab-pending" />
        <AdminButton label="Reported" tone={tab === 'reported' ? 'primary' : 'neutral'} onPress={() => setTab('reported')} testID="gems-tab-reported" />
      </View>
      <KeyboardSafeView
        contentContainerStyle={a.body}
        scrollViewProps={{ refreshControl: <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> }}
      >
        {current.state === 'loading' && <AdminLoading testID="gems-loading" />}
        {current.state === 'error' && (
          <AdminError message={`Couldn't load the ${tab} queue: ${current.message}`} onRetry={() => void load(tab)} testID="gems-error" />
        )}
        {current.state === 'ready' && current.rows.length === 0 && (
          <AdminEmpty message={tab === 'pending' ? 'No gems are waiting for review.' : 'No gems have open reports.'} testID="gems-empty" />
        )}

        {tab === 'pending' && pending.state === 'ready' && pending.rows.map((g) => (
          <View key={g.id} style={a.card} testID={`gem-pending-${g.id}`}>
            <Text style={a.cardTitle}>{g.name}</Text>
            <Text style={a.meta}>{[g.category, place(g)].filter(Boolean).join(' · ')}</Text>
            <Text style={a.meta}>Submitted {new Date(g.created_at).toLocaleDateString()}{g.sensitivity_level ? ` · sensitivity ${g.sensitivity_level}` : ''}</Text>
            <TextInput
              style={a.input}
              placeholder="Note (optional, kept with the decision)"
              value={notes[g.id] ?? ''}
              onChangeText={(v) => setNotes((n) => ({ ...n, [g.id]: v }))}
              maxLength={500}
              accessibilityLabel={`Note for ${g.name}`}
            />
            <View style={a.row}>
              <AdminButton label="Approve" tone="primary" disabled={busyId === g.id} testID={`gem-approve-${g.id}`}
                onPress={() => void act(g.id, () => verifyGem(g.id, 'approved', notes[g.id]), 'pending')} />
              <AdminButton label="Reject" tone="danger" disabled={busyId === g.id} testID={`gem-reject-${g.id}`}
                onPress={() => void act(g.id, () => verifyGem(g.id, 'rejected', notes[g.id]), 'pending')} />
            </View>
            {!!rowError[g.id] && <Text style={a.formError} accessibilityRole="alert">Not recorded: {rowError[g.id]}</Text>}
          </View>
        ))}

        {tab === 'reported' && reported.state === 'ready' && reported.rows.map((g) => (
          <View key={g.id} style={a.card} testID={`gem-reported-${g.id}`}>
            <Text style={a.cardTitle}>{g.name}</Text>
            <Text style={a.meta}>{place(g)} · {g.report_count} report{g.report_count === 1 ? '' : 's'} · {g.status}</Text>
            <View style={a.row}>
              <AdminButton label="Uphold (hide gem)" tone="danger" disabled={busyId === g.id} testID={`gem-uphold-${g.id}`}
                onPress={() => void act(g.id, () => resolveGemReports(g.id, 'upheld'), 'reported')} />
              <AdminButton label="Dismiss reports" disabled={busyId === g.id} testID={`gem-dismiss-${g.id}`}
                onPress={() => void act(g.id, () => resolveGemReports(g.id, 'dismissed'), 'reported')} />
            </View>
            {!!rowError[g.id] && <Text style={a.formError} accessibilityRole="alert">Not recorded: {rowError[g.id]}</Text>}
          </View>
        ))}
      </KeyboardSafeView>
    </View>
  );
}
