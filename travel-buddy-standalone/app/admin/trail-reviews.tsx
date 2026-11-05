import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin.ts';
import { useSession } from '../../src/context/SessionContext.tsx';
import { useInputAccountEpoch } from '../../src/platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { AdminButton, AdminEmpty, AdminError, AdminHeader, AdminLoading, adminStyles as a } from '../../src/components/admin/AdminConsoleParts.tsx';
import { decidePendingTrailReview, getPendingTrailReviews, type PendingTrailReview, type TrailReviewCursor } from '../../src/services/trailReviewsAdmin.ts';

export default function TrailReviewsScreen() {
  const pending = useRequireAdmin();
  const { isAuthed, role } = useSession();
  const epoch = useInputAccountEpoch();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  return <View style={[a.screen, { paddingTop: insets.top }]}>
    <AdminHeader title="Trail review" subtitle="Review new Trails before they appear in Discovery" />
    {pending ? <AdminLoading /> : isAuthed && role === 'admin' && focused ? <ReviewQueue key={epoch} /> : null}
  </View>;
}

function ReviewQueue() {
  const [rows, setRows] = useState<PendingTrailReview[]>([]);
  const [next, setNext] = useState<TrailReviewCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ trail: PendingTrailReview; decision: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const list = useRef<FlatList<PendingTrailReview>>(null);
  function select(trail: PendingTrailReview, decision: 'approve' | 'reject') {
    if (busy.current) return;
    setSelected({ trail, decision }); setReason(''); setError(null);
    list.current?.scrollToOffset({ offset: 0, animated: true });
  }

  async function load(after: TrailReviewCursor | null = null) {
    if (busy.current) return;
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    setLoading(true); setError(null);
    try {
      const result = await getPendingTrailReviews(controller.signal, after);
      if (!alive.current || read.current !== controller || controller.signal.aborted) return;
      setRows(previous => after ? [...new Map([...previous, ...result.trails].map(row => [row.id, row])).values()] : result.trails);
      setNext(result.next);
    } catch (err) {
      if (alive.current && read.current === controller && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'The queue could not be loaded.');
    } finally { if (alive.current && read.current === controller) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; read.current?.abort(); write.current?.abort(); };
  }, []);

  async function confirm() {
    if (!selected || busy.current) return;
    const intent = selected;
    if (intent.decision === 'reject' && !reason.trim()) { setError('Enter a reason to explain the rejection to its creator.'); return; }
    busy.current = true; setSaving(true); setError(null); setNotice(null);
    read.current?.abort(); read.current = null; setLoading(false);
    const controller = new AbortController(); write.current = controller;
    try {
      await decidePendingTrailReview(intent.trail.id, intent.decision, reason, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setRows(previous => previous.filter(row => row.id !== intent.trail.id));
      setSelected(null); setReason('');
      setNotice(intent.decision === 'approve' ? 'Trail approved.' : 'Trail rejected. Its creator can see your reason.');
    } catch (err) {
      if (alive.current && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'The decision could not be confirmed.');
    } finally { if (alive.current) { busy.current = false; setSaving(false); } }
  }

  return <FlatList ref={list} data={rows} keyExtractor={item => item.id} contentContainerStyle={a.body} keyboardShouldPersistTaps="handled"
    ListHeaderComponent={<>
      <AdminButton label="Refresh queue" disabled={saving || loading} onPress={() => { setSelected(null); setReason(''); void load(); }} />
      {notice ? <Text style={a.notice} accessibilityLiveRegion="polite">{notice}</Text> : null}
      {error ? <AdminError message={error} onRetry={() => { if (!busy.current) { setSelected(null); void load(); } }} /> : null}
      {selected ? <View style={a.card} testID="trail-review-confirmation">
        <Text style={a.cardTitle}>{selected.decision === 'approve' ? 'Approve' : 'Reject'} “{selected.trail.title}”?</Text>
        <Text style={a.meta}>{selected.decision === 'approve' ? 'This Trail will become eligible to appear in Discovery.' : 'The Trail stays private to its creator. Explain what needs to change.'}</Text>
        <TextInput accessibilityLabel={selected.decision === 'reject' ? 'Rejection reason' : 'Review note (optional)'}
          placeholder={selected.decision === 'reject' ? 'Reason for rejection' : 'Review note (optional)'} value={reason} onChangeText={setReason}
          multiline maxLength={500} editable={!saving} style={a.input} />
        <View style={a.row}>
          <AdminButton label={saving ? 'Saving decision…' : 'Confirm decision'} onPress={() => { void confirm(); }} disabled={saving || (selected.decision === 'reject' && !reason.trim())} tone="primary" />
          <AdminButton label="Cancel" onPress={() => { setSelected(null); setReason(''); }} disabled={saving} />
        </View>
      </View> : null}
    </>}
    ListEmptyComponent={loading ? null : error ? null : <AdminEmpty message="No pending Trails in this page." />}
    ListFooterComponent={loading ? <AdminLoading /> : next ? <AdminButton label="Load more Trails" disabled={saving} onPress={() => { void load(next); }} /> : null}
    renderItem={({ item }) => <View style={a.card}>
      <Text style={a.cardTitle}>{item.title}</Text>
      {item.description ? <Text style={a.meta}>{item.description}</Text> : null}
      <Text style={a.meta}>{item.destination ?? 'No destination'} · {new Date(item.createdAt).toLocaleDateString()}</Text>
      <Text style={a.meta}>Status: {item.lifecycle}</Text>
      <View style={a.row}>
        <AdminButton label={`Approve ${item.title}`} disabled={saving} onPress={() => select(item, 'approve')} tone="primary" />
        <AdminButton label={`Reject ${item.title}`} disabled={saving} onPress={() => select(item, 'reject')} tone="danger" />
      </View>
    </View>} />;
}
