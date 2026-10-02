/**
 * Rent a Buddy — Admin risk review & buddy verification (testing mode,
 * lane tm-rab, PLAT-F56).
 *
 * The risk scan (POST /admin/run-risk-scan) moves buddies to watch / limited /
 * under_review, but the review list, the status override and the manual
 * verification override had client functions and no screen. This lists buddies
 * by risk status and lets an admin:
 *   • set the risk status with a note (`suspended` also switches the user's
 *     Rent-a-Buddy access off server-side, via rent_buddy_user_limits);
 *   • record a manual verification decision (ID / phone / age) — the
 *     sanctioned admin path the server documents; automated KYC stays unbuilt.
 *
 * A failed read is an error with retry, never "nobody to review"; a write the
 * server did not confirm is reported and nothing changes locally.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, RefreshControl, Modal, TextInput, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import {
  getAdminRiskReview, updateRiskStatus, updateUserVerification, type AdminRiskBuddy,
} from '../../../src/services/rentABuddyAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';
import { RabAdminScaffold, adminListState, adminCard as c } from '../../../src/components/rentabuddy/RabAdminScaffold';

const STATUSES = ['watch', 'limited', 'under_review', 'suspended', 'normal'] as const;
type RiskStatus = typeof STATUSES[number];
const LABEL: Record<RiskStatus, string> = {
  watch: 'Watch', limited: 'Limited', under_review: 'Under review', suspended: 'Suspended', normal: 'Normal',
};
const TABS = STATUSES.map((k) => ({ key: k, label: LABEL[k] }));

type Choice = 'keep' | 'yes' | 'no';
const CHOICES: ReadonlyArray<readonly [Choice, string]> = [['keep', 'No change'], ['yes', 'Verified'], ['no', 'Not verified']];

type Editing =
  | { kind: 'risk'; buddy: AdminRiskBuddy }
  | { kind: 'verify'; buddy: AdminRiskBuddy }
  | null;

function EditSheet({ editing, onClose, onRisk, onVerify }: {
  editing: Editing;
  onClose: () => void;
  onRisk: (status: RiskStatus, note: string) => void;
  onVerify: (fields: { idVerified?: boolean; phoneVerified?: boolean; ageVerified?: boolean; note: string }) => void;
}) {
  const [status, setStatus] = useState<RiskStatus>('watch');
  const [note, setNote] = useState('');
  // Each field is left alone unless the admin chooses: the risk list does not
  // carry the current verification columns, so defaulting to "not verified"
  // would silently REVOKE a verification by saving the sheet.
  const [idV, setIdV] = useState<Choice>('keep');
  const [phoneV, setPhoneV] = useState<Choice>('keep');
  const [ageV, setAgeV] = useState<Choice>('keep');
  useEffect(() => {
    if (!editing) return;
    setNote('');
    setStatus(editing.buddy.risk_review_status as RiskStatus);
    setIdV('keep'); setPhoneV('keep'); setAgeV('keep');
  }, [editing]);
  const changedVerification = idV !== 'keep' || phoneV !== 'keep' || ageV !== 'keep';
  const canSave = note.trim().length > 0 && (editing?.kind === 'risk' || changedVerification);
  // The Modal stays mounted and toggles `visible`: unmounting a visible Modal
  // can leave the native modal stuck on screen.
  return (
    <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={onClose}>
      {editing ? (
      <KeyboardSafeScrollView>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <Text style={m.title}>{editing.kind === 'risk' ? 'Set risk status' : 'Record verification'}</Text>
            <Text style={m.sub}>{editing.buddy.display_name ?? 'Buddy'} · {editing.buddy.city}</Text>
            {editing.kind === 'risk' ? (
              <>
                <View style={c.actions}>
                  {STATUSES.map((s) => (
                    <Pressable key={s} style={[c.btn, status === s && c.btnPrimary]} onPress={() => setStatus(s)} testID={`risk-status-${s}`}>
                      <Text style={status === s ? c.btnTextPrimary : c.btnText}>{LABEL[s]}</Text>
                    </Pressable>
                  ))}
                </View>
                {status === 'suspended' ? (
                  <Text style={m.warn}>Suspended also switches this user's Rent a Buddy access off (rent_buddy_user_limits.rent_buddy_disabled).</Text>
                ) : null}
              </>
            ) : (
              <>
                <Text style={m.sub}>Record only what you have checked yourself. This is the manual admin decision; it sets the buddy's verification status that search and the high-risk booking check read. Fields left on "No change" are not touched.</Text>
                {([
                  ['ID', idV, setIdV, 'verify-id'],
                  ['Phone', phoneV, setPhoneV, 'verify-phone'],
                  ['Age', ageV, setAgeV, 'verify-age'],
                ] as const).map(([label, value, set, id]) => (
                  <View key={id} style={m.switchRow}>
                    <Text style={m.switchLabel}>{label}</Text>
                    <View style={c.actions}>
                      {CHOICES.map(([k, l]) => (
                        <Pressable key={k} style={[c.btn, value === k && c.btnPrimary]} onPress={() => set(k)} testID={`${id}-${k}`}>
                          <Text style={value === k ? c.btnTextPrimary : c.btnText}>{l}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ))}
              </>
            )}
            <TextInput
              style={m.input}
              value={note}
              onChangeText={setNote}
              placeholder="Note for the admin log (required)"
              placeholderTextColor={color.mute}
              multiline
              testID="risk-note"
            />
            <View style={c.actions}>
              <Pressable style={[c.btn, { flex: 1 }]} onPress={onClose}><Text style={c.btnText}>Cancel</Text></Pressable>
              <Pressable
                style={[c.btn, c.btnPrimary, { flex: 1 }, !canSave && { opacity: 0.4 }]}
                disabled={!canSave}
                testID="risk-save"
                onPress={() => (editing.kind === 'risk'
                  ? onRisk(status, note.trim())
                  : onVerify({
                    ...(idV !== 'keep' ? { idVerified: idV === 'yes' } : {}),
                    ...(phoneV !== 'keep' ? { phoneVerified: phoneV === 'yes' } : {}),
                    ...(ageV !== 'keep' ? { ageVerified: ageV === 'yes' } : {}),
                    note: note.trim(),
                  }))}
              >
                <Text style={c.btnTextPrimary}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardSafeScrollView>
      ) : null}
    </Modal>
  );
}

export default function AdminRiskReview() {
  useRequireAdmin();
  const [tab, setTab] = useState<RiskStatus>('watch');
  const [rows, setRows] = useState<AdminRiskBuddy[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await getAdminRiskReview(tab);
    if (!silent) setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setRows(res.data);
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  const write = useCallback(async (call: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    if (lock.current) return;
    lock.current = true;
    setEditing(null);
    try {
      const r = await call();
      if (!r.ok) { Alert.alert("That didn't save", bookingErrorCopy(r.error, 'Please try again.')); return; }
      Alert.alert(done);
      await load(true);
    } finally {
      lock.current = false;
    }
  }, [load]);

  const state = adminListState({
    loading, error, count: rows.length, onRetry: () => { void load(); },
    loadingLabel: 'Loading risk review…',
    emptyTitle: `No buddies at "${LABEL[tab]}"`,
    emptySub: 'The risk scan and admin overrides move buddies between these lists.',
  });

  return (
    <RabAdminScaffold title="Risk review" tabs={TABS} activeTab={tab} onTab={(k) => setTab(k as RiskStatus)}>
      {state ?? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={c.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
          renderItem={({ item }) => (
            <View style={c.card} testID={`risk-${item.id}`}>
              <View style={c.row}>
                <Text style={c.title}>{item.display_name ?? 'Unnamed buddy'}</Text>
                <Text style={c.pill}>{LABEL[item.risk_review_status as RiskStatus] ?? item.risk_review_status}</Text>
              </View>
              <Text style={c.meta}>{item.city}</Text>
              {item.risk_review_note ? <Text style={c.body}>{item.risk_review_note}</Text> : null}
              <View style={c.actions}>
                <Pressable style={[c.btn, c.btnPrimary]} onPress={() => setEditing({ kind: 'risk', buddy: item })} testID={`risk-set-${item.id}`}>
                  <Text style={c.btnTextPrimary}>Set risk status</Text>
                </Pressable>
                <Pressable style={c.btn} onPress={() => setEditing({ kind: 'verify', buddy: item })} testID={`risk-verify-${item.id}`}>
                  <Text style={c.btnText}>Verification…</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}
      <EditSheet
        editing={editing}
        onClose={() => setEditing(null)}
        onRisk={(status, note) => {
          const b = editing?.buddy; if (!b) return;
          void write(() => updateRiskStatus(b.user_id, status, note), `Risk status set to ${LABEL[status]}.`);
        }}
        onVerify={(f) => {
          const b = editing?.buddy; if (!b) return;
          void write(() => updateUserVerification(b.user_id, f), 'Verification recorded.');
        }}
      />
    </RabAdminScaffold>
  );
}

const m = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paper, padding: space.lg, gap: space.md, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  title: { ...t.title, color: color.ink },
  sub: { ...t.small, color: color.mute },
  warn: { ...t.small, color: color.signal },
  switchRow: { gap: space.xs },
  switchLabel: { ...t.body, color: color.ink },
  input: { minHeight: 70, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, color: color.ink, textAlignVertical: 'top' },
});
