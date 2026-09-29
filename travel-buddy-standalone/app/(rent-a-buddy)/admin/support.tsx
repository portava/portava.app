/**
 * Rent a Buddy — Admin support reports (testing mode, lane tm-rab, PLAT-F56).
 *
 * Travellers and buddies file support reports on a booking
 * (POST …/support/report); the admin side (list + update status/notes) had
 * client functions and no screen. This is that queue: list by status, move a
 * report through open → in review → resolved / closed, and keep admin notes.
 *
 * A failed read is an error with retry, never an empty queue; an update the
 * server did not confirm is reported and the list is not changed locally.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, RefreshControl, Modal, TextInput, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import { getAdminSupportReports, updateSupportReport, type AdminSupportReport } from '../../../src/services/rentABuddyAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';
import { RabAdminScaffold, adminListState, adminCard as c } from '../../../src/components/rentabuddy/RabAdminScaffold';

/** The statuses PATCH /admin/support/reports/:id accepts (its VALID_STATUSES). */
const STATUSES = ['open', 'in_review', 'resolved', 'closed'] as const;
type SupportStatus = typeof STATUSES[number];
const LABEL: Record<SupportStatus, string> = { open: 'Open', in_review: 'In review', resolved: 'Resolved', closed: 'Closed' };
const TABS = STATUSES.map((k) => ({ key: k, label: LABEL[k] }));

function UpdateSheet({ report, onClose, onSave }: {
  report: AdminSupportReport | null;
  onClose: () => void;
  onSave: (status: SupportStatus, notes: string) => void;
}) {
  const [status, setStatus] = useState<SupportStatus>('in_review');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (report) {
      setStatus((STATUSES as readonly string[]).includes(report.status) ? report.status as SupportStatus : 'in_review');
      setNotes(report.admin_notes ?? '');
    }
  }, [report]);
  return (
    <Modal visible={report !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafeScrollView>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <Text style={m.title}>Update report</Text>
            <View style={c.actions}>
              {STATUSES.map((s) => (
                <Pressable key={s} style={[c.btn, status === s && c.btnPrimary]} onPress={() => setStatus(s)} testID={`support-status-${s}`}>
                  <Text style={status === s ? c.btnTextPrimary : c.btnText}>{LABEL[s]}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={m.input}
              value={notes}
              onChangeText={setNotes}
              placeholder="Admin notes (only admins see these)"
              placeholderTextColor={color.mute}
              multiline
              testID="support-notes"
            />
            <View style={c.actions}>
              <Pressable style={[c.btn, { flex: 1 }]} onPress={onClose}><Text style={c.btnText}>Cancel</Text></Pressable>
              <Pressable style={[c.btn, c.btnPrimary, { flex: 1 }]} onPress={() => onSave(status, notes)} testID="support-save">
                <Text style={c.btnTextPrimary}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

export default function AdminSupportReports() {
  useRequireAdmin();
  const [tab, setTab] = useState<SupportStatus>('open');
  const [rows, setRows] = useState<AdminSupportReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminSupportReport | null>(null);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await getAdminSupportReports(tab);
    if (!silent) setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setRows(res.data);
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (report: AdminSupportReport, status: SupportStatus, notes: string) => {
    if (lock.current) return;
    lock.current = true;
    setEditing(null);
    try {
      const r = await updateSupportReport(report.id, { status, adminNotes: notes });
      if (!r.ok) { Alert.alert("That didn't save", bookingErrorCopy(r.error, 'Please try again.')); return; }
      await load(true);
    } finally {
      lock.current = false;
    }
  }, [load]);

  const state = adminListState({
    loading, error, count: rows.length, onRetry: () => { void load(); },
    loadingLabel: 'Loading support reports…',
    emptyTitle: `No ${LABEL[tab].toLowerCase()} reports`,
    emptySub: 'Reports filed from a booking appear here.',
  });

  return (
    <RabAdminScaffold title="Support reports" tabs={TABS} activeTab={tab} onTab={(k) => setTab(k as SupportStatus)}>
      {state ?? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={c.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
          renderItem={({ item }) => (
            <View style={c.card} testID={`support-${item.id}`}>
              <View style={c.row}>
                <Text style={c.title}>{item.category.replace(/_/g, ' ')}</Text>
                <Text style={c.pill}>{LABEL[item.status as SupportStatus] ?? item.status}</Text>
              </View>
              {item.details ? <Text style={c.body}>{item.details}</Text> : <Text style={c.meta}>(No details given)</Text>}
              <Text style={c.meta}>Booking {item.booking_id.slice(0, 8)} · {new Date(item.created_at).toLocaleString()}</Text>
              {item.admin_notes ? <Text style={c.meta}>Admin notes: {item.admin_notes}</Text> : null}
              <View style={c.actions}>
                <Pressable style={[c.btn, c.btnPrimary]} onPress={() => setEditing(item)} testID={`support-update-${item.id}`}>
                  <Text style={c.btnTextPrimary}>Update status / notes</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}
      <UpdateSheet
        report={editing}
        onClose={() => setEditing(null)}
        onSave={(status, notes) => { if (editing) void save(editing, status, notes); }}
      />
    </RabAdminScaffold>
  );
}

const m = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paper, padding: space.lg, gap: space.md, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  title: { ...t.title, color: color.ink },
  input: { minHeight: 80, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, color: color.ink, textAlignVertical: 'top' },
});
