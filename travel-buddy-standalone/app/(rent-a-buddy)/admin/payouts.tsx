/**
 * Rent a Buddy — Admin payouts queue (payments PAY-T21).
 *
 * NO REAL MONEY MOVES HERE, and the screen says so before anything else. No
 * payment processor is connected: a payout row is a status record, "Release" is
 * a status change, and nothing is paid to anyone. The screen exists so a tester
 * can exercise the two admin transitions and see that each one is audited.
 *
 * What the server guarantees (routes/rentABuddySpec.ts →
 * rb_admin_payout_transition, migration 3824): the status change and its admin
 * audit row are written in ONE database transaction. If the audit row cannot be
 * written the status does not change and the call fails — so this screen never
 * shows a hold or a release that was not recorded.
 *
 * States, each its own: loading, admin only, a failed read (with retry — never
 * an empty queue), a true empty, and the list. A reason is required for both
 * transitions; the confirm button stays disabled until one is typed. A failed
 * transition is reported with the server's reason and the list is re-read, so
 * a payout another admin already moved shows its real state.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, RefreshControl, Modal, TextInput, ActivityIndicator, StyleSheet } from 'react-native';
import { Info, PauseCircle, PlayCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import {
  listAdminPayouts, holdPayout, releasePayout,
  type AdminPayout, type PayoutStateFilter,
} from '../../../src/services/rentABuddyAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';
import { RabAdminScaffold, adminListState, adminCard as c } from '../../../src/components/rentabuddy/RabAdminScaffold';

const TABS: ReadonlyArray<{ key: PayoutStateFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'released', label: 'Released' },
];

const REASON_MAX = 1000;

type Action = 'hold' | 'release';

/** The server's rule, mirrored only to decide which button to OFFER; the server decides. */
function offeredAction(status: string): Action | null {
  if (status === 'on_hold') return 'release';
  if (status === 'released') return null;
  return 'hold';
}

function money(v: AdminPayout['amount_usd']): string {
  const n = typeof v === 'number' ? v : Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? 'Amount not recorded' : `$${n.toFixed(2)}`;
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : '—';
}

function ReasonSheet({ target, onClose, onConfirm }: {
  target: { payout: AdminPayout; action: Action } | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (target) setReason(''); }, [target]);
  const trimmed = reason.trim();
  const valid = trimmed.length > 0 && trimmed.length <= REASON_MAX;
  const isHold = target?.action === 'hold';
  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafeScrollView>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <Text style={m.title}>{isHold ? 'Hold this payout?' : 'Release this payout?'}</Text>
            <Text style={m.sub}>
              {isHold
                ? 'The payout is marked on hold. No money moves.'
                : 'The payout is marked released. This is a status change only — no money is sent to anyone.'}
            </Text>
            <Text style={m.label}>Reason (required — kept in the admin log)</Text>
            <TextInput
              style={m.input}
              value={reason}
              onChangeText={setReason}
              placeholder={isHold ? 'Why is this payout being held?' : 'Why is this payout being released?'}
              placeholderTextColor={color.mute}
              multiline
              maxLength={REASON_MAX}
              testID="payout-reason-input"
            />
            <View style={c.actions}>
              <Pressable style={[c.btn, { flex: 1 }]} onPress={onClose} testID="payout-reason-cancel">
                <Text style={c.btnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[c.btn, c.btnPrimary, { flex: 1 }, !valid && { opacity: 0.4 }]}
                disabled={!valid}
                accessibilityState={{ disabled: !valid }}
                onPress={() => onConfirm(trimmed)}
                testID="payout-reason-confirm"
              >
                <Text style={c.btnTextPrimary}>{isHold ? 'Hold payout' : 'Release payout'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

export default function AdminPayouts() {
  useRequireAdmin();
  const [tab, setTab] = useState<PayoutStateFilter>('all');
  const [rows, setRows] = useState<AdminPayout[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [target, setTarget] = useState<{ payout: AdminPayout; action: Action } | null>(null);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await listAdminPayouts(tab);
    if (!silent) setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setRows(res.data.payouts);
    setTotal(res.data.total);
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  const confirm = useCallback(async (reason: string) => {
    const t0 = target;
    setTarget(null);
    if (!t0 || lock.current) return;
    lock.current = true;
    setActing(t0.payout.id);
    try {
      const r = t0.action === 'hold'
        ? await holdPayout(t0.payout.id, reason)
        : await releasePayout(t0.payout.id, reason);
      if (!r.ok) {
        Alert.alert(
          t0.action === 'hold' ? "The payout wasn't held" : "The payout wasn't released",
          bookingErrorCopy(r.error, 'Nothing was changed. Please try again.'),
        );
      } else {
        Alert.alert(
          t0.action === 'hold' ? 'Payout held' : 'Payout marked released',
          'The change and your reason are in the admin log. No money moved.',
        );
      }
      // Re-read either way: after a refusal the list shows the state the payout is really in.
      await load(true);
    } finally {
      lock.current = false;
      setActing(null);
    }
  }, [target, load]);

  const state = adminListState({
    loading, error, count: rows.length, onRetry: () => { void load(); },
    loadingLabel: 'Loading payouts…',
    emptyTitle: tab === 'all' ? 'No payouts yet' : 'No payouts in this state',
    emptySub: 'The app does not create payout records yet, so this queue stays empty until one is added for testing.',
  });

  return (
    <RabAdminScaffold
      title="Payouts"
      subtitle={!loading && !error ? `${total} ${tab === 'all' ? 'in total' : 'in this state'}` : undefined}
      tabs={TABS}
      activeTab={tab}
      onTab={(k) => setTab(k as PayoutStateFilter)}
    >
      <View style={s.notice} testID="payouts-no-money-notice">
        <Info size={14} color={color.deep} />
        <Text style={s.noticeText}>
          Test surface — no real money moves. No payment processor is connected: holding or releasing a payout changes its status and writes an entry in the admin log. Nothing is paid to anyone.
        </Text>
      </View>
      {state ?? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={c.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
          renderItem={({ item }) => {
            const action = offeredAction(item.status);
            const busy = acting === item.id;
            return (
              <View style={[c.card, busy && { opacity: 0.6 }]} testID={`payout-${item.id}`}>
                <View style={c.row}>
                  <Text style={c.title}>{money(item.amount_usd)}</Text>
                  <Text style={c.pill} testID={`payout-${item.id}-status`}>{item.status.replace(/_/g, ' ').toUpperCase()}</Text>
                </View>
                <Text style={c.meta}>Payout {shortId(item.id)} · Booking {shortId(item.booking_id)} · Buddy {shortId(item.buddy_id)}</Text>
                <Text style={c.meta}>Created {when(item.created_at)}</Text>
                {item.held_at ? <Text style={c.meta}>Held {when(item.held_at)}{item.hold_reason ? ` — ${item.hold_reason}` : ''}</Text> : null}
                {item.released_at ? <Text style={c.meta}>Marked released {when(item.released_at)}{item.notes ? ` — ${item.notes}` : ''} (no money sent)</Text> : null}
                {action ? (
                  <View style={c.actions}>
                    <Pressable
                      style={[c.btn, action === 'release' ? c.btnPrimary : c.btnDanger]}
                      disabled={acting !== null}
                      testID={`payout-${action}-${item.id}`}
                      onPress={() => setTarget({ payout: item, action })}
                    >
                      {busy
                        ? <ActivityIndicator color={action === 'release' ? color.onInk : color.signal} />
                        : action === 'release' ? <PlayCircle size={15} color={color.onInk} /> : <PauseCircle size={15} color={color.signal} />}
                      <Text style={action === 'release' ? c.btnTextPrimary : c.btnTextDanger}>
                        {action === 'release' ? 'Release' : 'Hold'}
                      </Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={c.meta}>No further action: a released payout cannot be held or released again.</Text>
                )}
              </View>
            );
          }}
        />
      )}
      <ReasonSheet target={target} onClose={() => setTarget(null)} onConfirm={(reason) => { void confirm(reason); }} />
    </RabAdminScaffold>
  );
}

const s = StyleSheet.create({
  notice: { flexDirection: 'row', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  noticeText: { ...t.small, color: color.ink, flex: 1 },
});

const m = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paper, padding: space.lg, gap: space.md, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  title: { ...t.title, color: color.ink },
  sub: { ...t.small, color: color.mute },
  label: { ...t.small, color: color.ink, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, color: color.ink, minHeight: 80, textAlignVertical: 'top' },
});
