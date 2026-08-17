/**
 * Rent a Buddy — Admin Safety Flags Queue
 *
 * List of open policy violation flags.
 * Actions: Confirm (escalates restriction) or Dismiss.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Modal, TextInput,
  StyleSheet, ActivityIndicator, Alert, RefreshControl, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRentABuddyFlag } from '../../../src/hooks/useRentABuddyFlag';
import {
  listAdminFlags, confirmFlag, dismissFlag, escalateFlag,
  type AdminPolicyFlag,
} from '../../../src/services/rentABuddyAdmin';

const STATUS_FILTERS = ['open', 'resolved', 'dismissed'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#7C3AED',
  high: '#EF4444',
  medium: '#F59E0B',
  low: '#6B7280',
};

function FlagRow({
  item,
  onConfirm,
  onDismiss,
  onEscalate,
  onView,
}: {
  item: AdminPolicyFlag;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  onEscalate: (id: string) => void;
  onView: (item: AdminPolicyFlag) => void;
}) {
  const sevColor = SEVERITY_COLORS[item.severity] ?? color.mute;
  return (
    <View style={row.wrap}>
      <View style={row.top}>
        <View style={[row.sevBadge, { backgroundColor: sevColor + '22', borderColor: sevColor }]}>
          <Text style={[row.sevText, { color: sevColor }]}>{item.severity.toUpperCase()}</Text>
        </View>
        <Text style={row.category}>{item.category.replace(/_/g, ' ')}</Text>
        <Text style={row.date}>{new Date(item.createdAt).toLocaleDateString()}</Text>
      </View>
      {item.matchedTextExcerpt && (
        <Text style={row.excerpt} numberOfLines={2}>"{item.matchedTextExcerpt}"</Text>
      )}
      <Text style={row.meta}>Source: {item.sourceType}</Text>
      {item.bookingId && <Text style={row.meta}>Booking: {item.bookingId.slice(0, 8)}…</Text>}
      {item.flaggedUserId && <Text style={row.meta}>Flagged user: {item.flaggedUserId.slice(0, 12)}…</Text>}

      {item.status === 'open' && (
        <View style={row.actions}>
          <Pressable style={[row.btn, { backgroundColor: '#EF444420' }]} onPress={() => onConfirm(item.id)}>
            <ShieldAlert size={14} color='#EF4444' />
            <Text style={[row.btnText, { color: '#EF4444' }]}>Confirm</Text>
          </Pressable>
          <Pressable style={[row.btn, { backgroundColor: '#10B98120' }]} onPress={() => onDismiss(item.id)}>
            <ShieldCheck size={14} color='#10B981' />
            <Text style={[row.btnText, { color: '#10B981' }]}>Dismiss</Text>
          </Pressable>
          <Pressable style={[row.btn, { backgroundColor: '#7C3AED20' }]} onPress={() => onEscalate(item.id)}>
            <ShieldOff size={14} color='#7C3AED' />
            <Text style={[row.btnText, { color: '#7C3AED' }]}>Escalate</Text>
          </Pressable>
          <Pressable style={[row.btn, { backgroundColor: color.haze }]} onPress={() => onView(item)}>
            <Text style={[row.btnText, { color: color.mute }]}>Detail</Text>
          </Pressable>
        </View>
      )}
      {item.status !== 'open' && (
        <View style={row.resolved}>
          <ShieldOff size={12} color={color.faint} />
          <Text style={row.resolvedText}>{item.status}</Text>
        </View>
      )}
    </View>
  );
}

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

export default function AdminFlagsScreen() {
  useRequireAdmin();
  const insets = useSafeAreaInsets();
  const { enabled: featureEnabled, loading: flagLoading } = useRentABuddyFlag();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [items, setItems] = useState<AdminPolicyFlag[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AdminPolicyFlag | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ id: string; type: 'confirm' | 'dismiss' | 'escalate' } | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (p = 1, append = false) => {
    try {
      const data = await listAdminFlags(statusFilter, p);
      setItems(prev => append ? [...prev, ...data.flags] : data.flags);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      if (e?.message === 'forbidden') setForbidden(true);
    }
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    load(1).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(1);
    setRefreshing(false);
  }, [load]);

  function initAction(id: string, type: 'confirm' | 'dismiss' | 'escalate') {
    setNotes('');
    setActionTarget({ id, type });
  }

  async function executeAction() {
    if (!actionTarget) return;
    setSaving(true);
    const res = actionTarget.type === 'confirm'
      ? await confirmFlag(actionTarget.id, notes || undefined)
      : actionTarget.type === 'escalate'
        ? await escalateFlag(actionTarget.id, notes || undefined)
        : await dismissFlag(actionTarget.id, notes || undefined);
    setSaving(false);
    if (!res.ok) {
      Alert.alert('Error', bookingErrorCopy(res.error, 'Failed'));
      return;
    }
    setActionTarget(null);
    load(1);
  }

  if (!flagLoading && (forbidden || !featureEnabled)) {
    const msg = forbidden
      ? 'Admin access required.\nYour account does not have admin privileges.'
      : 'Rent a Buddy is not enabled in this environment.';
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text style={{ fontFamily: 'Courier', fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>{msg}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && { opacity: 0.6 }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.stamp}>ADMIN · SAFETY</Text>
          <Text style={styles.title}>Policy Flags</Text>
        </View>
        <Text style={styles.count}>{total}</Text>
      </View>

      <View style={styles.tabRow}>
        {STATUS_FILTERS.map((f) => (
          <Pressable key={f} style={[styles.tab, statusFilter === f && styles.tabActive]} onPress={() => setStatusFilter(f)}>
            <Text style={[styles.tabText, statusFilter === f && styles.tabTextActive]}>{f}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => (
            <FlagRow item={item}
              onConfirm={(id) => initAction(id, 'confirm')}
              onDismiss={(id) => initAction(id, 'dismiss')}
              onEscalate={(id) => initAction(id, 'escalate')}
              onView={setSelected}
            />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
          onEndReached={() => { if (items.length < total) load(page + 1, true); }}
          onEndReachedThreshold={0.3}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No {statusFilter} flags.</Text>}
        />
      )}

      {/* Action confirmation modal */}
      <Modal visible={!!actionTarget} transparent animationType="fade" onRequestClose={() => setActionTarget(null)}>
        <View style={modal.overlay}>
          <View style={modal.sheet}>
            <Text style={modal.title}>
              {actionTarget?.type === 'confirm'
                ? 'Confirm Flag (applies restriction)'
                : actionTarget?.type === 'escalate'
                  ? 'Escalate to Support'
                  : 'Dismiss Flag'}
            </Text>
            {actionTarget?.type === 'confirm' && (
              <Text style={modal.warning}>
                Confirming a flag will apply a Trust Score penalty to the flagged user. Critical severity also sets a risk hold.
              </Text>
            )}
            {actionTarget?.type === 'escalate' && (
              <Text style={modal.warning}>
                Escalating forwards this flag to the support team for human review. Add context notes below.
              </Text>
            )}
            <TextInput
              style={modal.input}
              placeholder="Admin notes (optional)"
              placeholderTextColor={color.faint}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
            />
            <View style={modal.actions}>
              <Pressable style={[modal.btn, modal.cancel]} onPress={() => setActionTarget(null)}>
                <Text style={modal.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[modal.btn, actionTarget?.type === 'confirm' ? modal.danger : modal.confirm]}
                onPress={executeAction}
                disabled={saving}
              >
                {saving
                  ? <ActivityIndicator color={color.onInk} size="small" />
                  : <Text style={modal.confirmText}>
                      {actionTarget?.type === 'confirm' ? 'Confirm Flag' : actionTarget?.type === 'escalate' ? 'Escalate' : 'Dismiss'}
                    </Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Detail modal */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={modal.overlay}>
          <View style={[modal.sheet, { maxHeight: '80%' }]}>
            <Text style={modal.title}>Flag Detail</Text>
            {selected && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={detail.label}>FLAG ID</Text>
                <Text style={detail.value}>{selected.id}</Text>
                <Text style={detail.label}>SEVERITY</Text>
                <Text style={[detail.value, { color: SEVERITY_COLORS[selected.severity] }]}>{selected.severity.toUpperCase()}</Text>
                <Text style={detail.label}>CATEGORY</Text>
                <Text style={detail.value}>{selected.category.replace(/_/g, ' ')}</Text>
                <Text style={detail.label}>SOURCE TYPE</Text>
                <Text style={detail.value}>{selected.sourceType}</Text>
                {selected.bookingId && (<>
                  <Text style={detail.label}>BOOKING ID</Text>
                  <Text style={detail.value}>{selected.bookingId}</Text>
                </>)}
                {selected.flaggedUserId && (<>
                  <Text style={detail.label}>FLAGGED USER</Text>
                  <Text style={detail.value}>{selected.flaggedUserId}</Text>
                </>)}
                {selected.reporterUserId && (<>
                  <Text style={detail.label}>REPORTER</Text>
                  <Text style={detail.value}>{selected.reporterUserId}</Text>
                </>)}
                {selected.matchedTextExcerpt && (<>
                  <Text style={detail.label}>MATCHED EXCERPT</Text>
                  <Text style={detail.value}>"{selected.matchedTextExcerpt}"</Text>
                </>)}
                <Text style={detail.label}>STATUS</Text>
                <Text style={detail.value}>{selected.status}</Text>
                {selected.adminNotes && (<>
                  <Text style={detail.label}>ADMIN NOTES</Text>
                  <Text style={detail.value}>{selected.adminNotes}</Text>
                </>)}
                <Text style={detail.label}>CREATED</Text>
                <Text style={detail.value}>{new Date(selected.createdAt).toLocaleString()}</Text>
                {selected.bookingId && (
                  <Pressable style={detail.threadLink}
                    onPress={() => {
                      setSelected(null);
                      router.push({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: selected.bookingId } });
                    }}>
                    <Text style={detail.threadLinkText}>View Booking & Chat Context →</Text>
                  </Pressable>
                )}
              </ScrollView>
            )}
            <Pressable style={modal.closeBtn} onPress={() => setSelected(null)}>
              <Text style={modal.closeBtnText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderColor: color.haze },
  stamp: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.signal, letterSpacing: 2 },
  title: { ...t.heading, color: color.ink },
  count: { ...t.stamp, color: color.mute },
  tabRow: { flexDirection: 'row', paddingHorizontal: space.lg, gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderColor: color.haze },
  tab: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  tabActive: { backgroundColor: color.ink, borderColor: color.ink },
  tabText: { ...t.small, fontWeight: '700', color: color.mute },
  tabTextActive: { color: color.onInk },
  list: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { ...t.body, color: color.mute, textAlign: 'center', paddingVertical: space.xxl },
});

const row = StyleSheet.create({
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 6 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sevBadge: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  sevText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  category: { ...t.small, fontWeight: '700', color: color.ink, flex: 1 },
  date: { ...t.small, color: color.faint },
  excerpt: { ...t.small, color: color.mute, fontStyle: 'italic', backgroundColor: color.haze, padding: 6, borderRadius: 6 },
  meta: { ...t.small, color: color.mute },
  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: 4 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.sm },
  btnText: { ...t.small, fontWeight: '700' },
  resolved: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  resolvedText: { ...t.small, color: color.faint },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'flex-end', padding: space.lg },
  sheet: { width: '100%', backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.xl, gap: space.md },
  title: { ...t.heading, color: color.ink },
  warning: { ...t.small, color: '#EF4444', backgroundColor: '#EF444410', padding: space.sm, borderRadius: radius.sm },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.md, ...t.body, color: color.ink, minHeight: 72 },
  actions: { flexDirection: 'row', gap: space.md },
  btn: { flex: 1, padding: space.md, borderRadius: radius.md, alignItems: 'center' },
  cancel: { backgroundColor: color.haze },
  confirm: { backgroundColor: color.ink },
  danger: { backgroundColor: '#EF4444' },
  cancelText: { ...t.bodyStrong, color: color.mute },
  confirmText: { ...t.bodyStrong, color: color.onInk },
  closeBtn: { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', marginTop: space.md },
  closeBtnText: { ...t.bodyStrong, color: color.mute },
});

const detail = StyleSheet.create({
  label: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.faint, letterSpacing: 1.5, marginTop: space.md },
  value: { ...t.body, color: color.ink },
  threadLink: { marginTop: space.lg, padding: space.md, borderRadius: radius.sm, backgroundColor: color.haze, alignItems: 'center' },
  threadLinkText: { ...t.bodyStrong, color: color.ink },
});
