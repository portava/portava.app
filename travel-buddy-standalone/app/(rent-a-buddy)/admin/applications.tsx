/**
 * Rent a Buddy — Admin Applications Queue
 *
 * Tabbed list: Pending / Under Review / Approved / Rejected.
 * Each row: applicant user ID, city, categories, submission date, action buttons.
 * Approve/Reject/Under Review calls the PATCH /admin/applications/:id endpoint.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Modal, TextInput,
  StyleSheet, ActivityIndicator, Alert, RefreshControl, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Check, X, Clock, Eye } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRentABuddyFlag } from '../../../src/hooks/useRentABuddyFlag';
import {
  listAdminApplications, reviewApplication, limitApplication, suspendApplication,
  type AdminApplication,
} from '../../../src/services/rentABuddyAdmin';

type Tab = 'pending' | 'under_review' | 'approved' | 'rejected';

const TABS: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'under_review', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const STATUS_COLORS: Record<string, string> = {
  pending: '#F59E0B',
  under_review: '#3B82F6',
  approved: '#10B981',
  rejected: '#EF4444',
};

function formatAvailability(blocks: Array<Record<string, unknown>> | null | undefined): string {
  if (!blocks || blocks.length === 0) return '—';
  return blocks
    .map((b) => {
      const day = typeof b.day === 'string' ? b.day.charAt(0).toUpperCase() + b.day.slice(1) : null;
      const from = typeof b.from === 'string' ? b.from : null;
      const to = typeof b.to === 'string' ? b.to : null;
      if (day && from && to) return `${day} ${from}–${to}`;
      if (day) return day;
      return null;
    })
    .filter(Boolean)
    .join('\n') || '—';
}

function ApplicationRow({
  item,
  onAction,
  onView,
}: {
  item: AdminApplication;
  onAction: (id: string, action: 'approved' | 'rejected' | 'under_review') => void;
  onView: (item: AdminApplication) => void;
}) {
  const statusColor = STATUS_COLORS[item.status] ?? color.mute;
  return (
    <View style={row.wrap}>
      <View style={row.top}>
        <View style={[row.badge, { backgroundColor: statusColor + '22', borderColor: statusColor }]}>
          <Text style={[row.badgeText, { color: statusColor }]}>{item.status.replace('_', ' ')}</Text>
        </View>
        <Text style={row.date}>{new Date(item.createdAt).toLocaleDateString()}</Text>
      </View>
      <Text style={row.city}>{item.city}{item.country ? `, ${item.country}` : ''}</Text>
      <Text style={row.userId} numberOfLines={1}>ID: {item.userId}</Text>
      {item.categories.length > 0 && (
        <Text style={row.cats} numberOfLines={1}>{item.categories.join(', ')}</Text>
      )}
      <View style={row.actions}>
        <Pressable style={[row.btn, { backgroundColor: '#10B98120' }]}
          onPress={() => onAction(item.id, 'approved')}>
          <Check size={14} color='#10B981' />
          <Text style={[row.btnText, { color: '#10B981' }]}>Approve</Text>
        </Pressable>
        <Pressable style={[row.btn, { backgroundColor: '#F59E0B20' }]}
          onPress={() => onAction(item.id, 'under_review')}>
          <Clock size={14} color='#F59E0B' />
          <Text style={[row.btnText, { color: '#F59E0B' }]}>Review</Text>
        </Pressable>
        <Pressable style={[row.btn, { backgroundColor: '#EF444420' }]}
          onPress={() => onAction(item.id, 'rejected')}>
          <X size={14} color='#EF4444' />
          <Text style={[row.btnText, { color: '#EF4444' }]}>Reject</Text>
        </Pressable>
        <Pressable style={[row.btn, { backgroundColor: color.haze }]}
          onPress={() => onView(item)}>
          <Eye size={14} color={color.mute} />
        </Pressable>
      </View>
    </View>
  );
}

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

export default function AdminApplicationsScreen() {
  useRequireAdmin();
  // ── ALL hooks before any conditional return ─────────────────────────────────
  const insets = useSafeAreaInsets();
  const { enabled: featureEnabled, loading: flagLoading } = useRentABuddyFlag();
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<AdminApplication[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AdminApplication | null>(null);
  const [notes, setNotes] = useState('');
  const [actionTarget, setActionTarget] = useState<{ id: string; action: 'approved' | 'rejected' | 'under_review' } | null>(null);
  const [approvedCategories, setApprovedCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [limiting, setLimiting] = useState(false);

  const load = useCallback(async (p = 1, append = false) => {
    try {
      const data = await listAdminApplications(tab, p);
      setItems(prev => append ? [...prev, ...data.applications] : data.applications);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      if (e?.message === 'forbidden') setForbidden(true);
    }
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    load(1).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(1);
    setRefreshing(false);
  }, [load]);

  // ── Conditional return AFTER all hooks ─────────────────────────────────────
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

  function initiateAction(id: string, action: 'approved' | 'rejected' | 'under_review') {
    setNotes('');
    setApprovedCategories(selected?.categories ?? []);
    setActionTarget({ id, action });
  }

  async function confirmAction() {
    if (!actionTarget) return;
    setSaving(true);
    const cats = actionTarget.action === 'approved' ? approvedCategories : undefined;
    const res = await reviewApplication(actionTarget.id, actionTarget.action, notes || undefined, cats);
    setSaving(false);
    if (!res.ok) {
      Alert.alert('Error', bookingErrorCopy(res.error, 'Failed to update'));
      return;
    }
    setActionTarget(null);
    load(1);
  }

  async function handleLimit(id: string) {
    Alert.alert('Limit Buddy', 'Restrict this buddy\'s booking capacity?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Limit', style: 'destructive', onPress: async () => {
          setLimiting(true);
          await limitApplication(id);
          setLimiting(false);
          setSelected(null);
          load(1);
        },
      },
    ]);
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && { opacity: 0.6 }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View>
          <Text style={styles.stamp}>ADMIN</Text>
          <Text style={styles.title}>Applications Queue</Text>
        </View>
        <Text style={styles.count}>{total}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsInner}>
        {TABS.map((tb) => (
          <Pressable key={tb.key} style={[styles.tab, tab === tb.key && styles.tabActive]}
            onPress={() => setTab(tb.key)}>
            <Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>{tb.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => (
            <ApplicationRow item={item}
              onAction={initiateAction}
              onView={setSelected}
            />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
          onEndReached={() => { if (items.length < total) load(page + 1, true); }}
          onEndReachedThreshold={0.3}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No {tab.replace('_', ' ')} applications.</Text>}
        />
      )}

      {/* Action confirmation modal */}
      <Modal visible={!!actionTarget} transparent animationType="fade" onRequestClose={() => setActionTarget(null)}>
        <View style={modal.overlay}>
          <View style={modal.sheet}>
            <Text style={modal.title}>
              {actionTarget?.action === 'approved' ? 'Approve' : actionTarget?.action === 'rejected' ? 'Reject' : 'Mark Under Review'} Application
            </Text>

            {actionTarget?.action === 'approved' && (selected?.categories?.length ?? 0) > 0 && (
              <>
                <Text style={[modal.label, { marginBottom: 4 }]}>Approved categories (tap to toggle):</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space.sm }}>
                  {selected?.categories.map(cat => {
                    const on = approvedCategories.includes(cat);
                    return (
                      <Pressable key={cat}
                        style={[modal.catChip, on && modal.catChipOn]}
                        onPress={() => setApprovedCategories(prev =>
                          on ? prev.filter(c => c !== cat) : [...prev, cat]
                        )}>
                        <Text style={[modal.catChipText, on && modal.catChipTextOn]}>{cat}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            <TextInput
              style={modal.input}
              placeholder="Review notes (optional)"
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
              <Pressable style={[modal.btn, modal.confirm]} onPress={confirmAction} disabled={saving}>
                {saving ? <ActivityIndicator color={color.onInk} size="small" /> : <Text style={modal.confirmText}>Confirm</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Detail modal */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={modal.overlay}>
          <View style={[modal.sheet, { maxHeight: '80%' }]}>
            <Text style={modal.title}>Application Detail</Text>
            {selected && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={detail.label}>USER ID</Text>
                <Text style={detail.value}>{selected.userId}</Text>
                <Text style={detail.label}>CITY</Text>
                <Text style={detail.value}>{selected.city}{selected.country ? `, ${selected.country}` : ''}</Text>
                <Text style={detail.label}>CATEGORIES</Text>
                <Text style={detail.value}>{selected.categories.join(', ') || '—'}</Text>
                <Text style={detail.label}>LANGUAGES</Text>
                <Text style={detail.value}>{selected.languages.join(', ') || '—'}</Text>
                <Text style={detail.label}>MOTIVATION</Text>
                <Text style={detail.value}>{selected.motivation || '—'}</Text>
                <Text style={detail.label}>DISPLAY NAME</Text>
                <Text style={detail.value}>{selected.displayName || '—'}</Text>
                <Text style={detail.label}>BIO</Text>
                <Text style={detail.value}>{selected.bio || '—'}</Text>
                <Text style={detail.label}>HOURLY RATE</Text>
                <Text style={detail.value}>{selected.hourlyRateUsd != null ? `${selected.hourlyRateUsd}/hr` : '—'}</Text>
                <Text style={detail.label}>AVAILABILITY</Text>
                <Text style={detail.value}>{formatAvailability(selected.availability)}</Text>
                <Text style={detail.label}>MEETUP ZONES</Text>
                <Text style={detail.value}>{(selected.zones ?? []).join(', ') || '—'}</Text>
                <Text style={detail.label}>POLICY ACCEPTED</Text>
                <Text style={[detail.value, { color: selected.policyAccepted ? '#10B981' : '#EF4444' }]}>
                  {selected.policyAccepted ? '✓ Yes' : '✗ No'}
                </Text>
                <Text style={detail.label}>PHOTO VERIFIED</Text>
                <Text style={[detail.value, { color: (selected as any).photoVerified ? '#10B981' : color.mute }]}>
                  {(selected as any).photoVerified ? '✓ Verified' : 'Not submitted'}
                </Text>
                <Text style={detail.label}>STATUS</Text>
                <Text style={detail.value}>{selected.status}</Text>
                {selected.reviewNotes && (<>
                  <Text style={detail.label}>REVIEW NOTES</Text>
                  <Text style={detail.value}>{selected.reviewNotes}</Text>
                </>)}
                <Text style={detail.label}>SUBMITTED</Text>
                <Text style={detail.value}>{new Date(selected.createdAt).toLocaleString()}</Text>
                <View style={detail.actions}>
                  <Pressable style={[detail.btn, { backgroundColor: '#F59E0B20' }]}
                    onPress={() => handleLimit(selected.id)} disabled={limiting}>
                    <Text style={[detail.btnText, { color: '#F59E0B' }]}>Limit</Text>
                  </Pressable>
                  <Pressable style={[detail.btn, { backgroundColor: '#EF444420' }]}
                    onPress={async () => {
                      await suspendApplication(selected.id);
                      setSelected(null);
                      load(1);
                    }} disabled={limiting || saving}>
                    <X size={14} color='#EF4444' />
                    <Text style={[detail.btnText, { color: '#EF4444' }]}>Suspend</Text>
                  </Pressable>
                  <Pressable style={[detail.btn, { backgroundColor: '#10B98120' }]}
                    onPress={() => initiateAction(selected.id, 'approved')} disabled={saving}>
                    <Check size={14} color='#10B981' />
                    <Text style={[detail.btnText, { color: '#10B981' }]}>Approve</Text>
                  </Pressable>
                  <Pressable style={[detail.btn, { backgroundColor: '#EF444420' }]}
                    onPress={() => initiateAction(selected.id, 'rejected')} disabled={saving}>
                    <X size={14} color='#EF4444' />
                    <Text style={[detail.btnText, { color: '#EF4444' }]}>Reject</Text>
                  </Pressable>
                </View>
              </ScrollView>
            )}
            <Pressable style={[modal.btn, modal.cancel, { marginTop: space.lg }]} onPress={() => setSelected(null)}>
              <Text style={modal.cancelText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderColor: color.haze,
  },
  stamp: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2 },
  title: { ...t.heading, color: color.ink },
  count: { ...t.stamp, color: color.mute, marginLeft: 'auto' },
  tabs: { borderBottomWidth: 1, borderColor: color.haze },
  tabsInner: { paddingHorizontal: space.lg, gap: space.sm, paddingVertical: space.sm },
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
  badge: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  date: { ...t.small, color: color.faint, marginLeft: 'auto' },
  city: { ...t.bodyStrong, color: color.ink },
  userId: { ...t.small, color: color.mute },
  cats: { ...t.small, color: color.deep },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: 4, flexWrap: 'wrap' },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.sm },
  btnText: { ...t.small, fontWeight: '700' },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'flex-end', padding: space.lg },
  sheet: { width: '100%', backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.xl, gap: space.md },
  title: { ...t.heading, color: color.ink },
  label: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5 },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.md, ...t.body, color: color.ink, minHeight: 72 },
  actions: { flexDirection: 'row', gap: space.md },
  btn: { flex: 1, padding: space.md, borderRadius: radius.md, alignItems: 'center' },
  cancel: { backgroundColor: color.haze },
  confirm: { backgroundColor: color.ink },
  cancelText: { ...t.bodyStrong, color: color.mute },
  confirmText: { ...t.bodyStrong, color: color.onInk },
  catChip: {
    paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.sm,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.haze,
  },
  catChipOn: { borderColor: '#10B981', backgroundColor: '#10B98120' },
  catChipText: { ...t.small, color: color.mute },
  catChipTextOn: { color: '#10B981', fontWeight: '700' },
});

const detail = StyleSheet.create({
  label: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5, marginTop: space.md },
  value: { ...t.body, color: color.ink },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg, flexWrap: 'wrap' },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.sm },
  btnText: { ...t.small, fontWeight: '700' },
});
