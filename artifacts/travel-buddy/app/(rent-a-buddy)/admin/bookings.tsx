/**
 * Rent a Buddy — Admin Bookings Dashboard
 *
 * Paginated list of all bookings with status/city filters.
 * Tap opens a detail sheet with full booking context.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Modal,
  StyleSheet, ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, DollarSign, AlertTriangle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { listAdminBookings, type AdminBooking } from '../../../src/services/rentABuddyAdmin';

const STATUS_FILTERS = ['all', 'pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'disputed'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

const STATUS_COLORS: Record<string, string> = {
  pending: '#F59E0B',
  confirmed: '#3B82F6',
  in_progress: '#8B5CF6',
  completed: '#10B981',
  cancelled: '#9CA3AF',
  disputed: '#EF4444',
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

function BookingRow({ item, onPress }: { item: AdminBooking; onPress: () => void }) {
  const statusColor = STATUS_COLORS[item.status] ?? color.mute;
  const hasCashIssue = item.cashBalanceUsd > 0 && (
    item.cashBalanceConfirmedByBuddy === false || item.cashBalanceConfirmedByTraveler === false
  );
  return (
    <Pressable style={({ pressed }) => [row.wrap, pressed && { opacity: 0.85 }, hasCashIssue && row.wrapWarning]} onPress={onPress}>
      <View style={row.top}>
        <Text style={row.id} numberOfLines={1}>{item.id.slice(0, 8)}…</Text>
        <View style={[row.badge, { backgroundColor: statusColor + '22', borderColor: statusColor }]}>
          <Text style={[row.badgeText, { color: statusColor }]}>{item.status.replace('_', ' ')}</Text>
        </View>
      </View>
      <Text style={row.city}>{item.city} · {item.category}</Text>
      <Text style={row.date}>{fmtDate(item.bookingDate)}</Text>
      <View style={row.bottom}>
        <Text style={row.amount}>${item.totalUsd.toFixed(2)}</Text>
        {item.paymentMode && <Text style={row.mode}>{item.paymentMode}</Text>}
        {hasCashIssue && (
          <View style={row.warn}>
            <AlertTriangle size={12} color='#F59E0B' />
            <Text style={row.warnText}>Cash unconfirmed</Text>
          </View>
        )}
        {item.safetyStatus && item.safetyStatus !== 'normal' && (
          <View style={[row.warn, { backgroundColor: '#EF444420' }]}>
            <AlertTriangle size={12} color='#EF4444' />
            <Text style={[row.warnText, { color: '#EF4444' }]}>{item.safetyStatus}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function AdminBookingsScreen() {
  const insets = useSafeAreaInsets();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [items, setItems] = useState<AdminBooking[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AdminBooking | null>(null);

  const load = useCallback(async (p = 1, append = false) => {
    try {
      const data = await listAdminBookings({
        status: statusFilter === 'all' ? undefined : statusFilter,
        page: p,
      });
      setItems(prev => append ? [...prev, ...data.bookings] : data.bookings);
      setTotal(data.total);
      setPage(p);
    } catch { /* ignore */ }
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

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && { opacity: 0.6 }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.stamp}>ADMIN</Text>
          <Text style={styles.title}>All Bookings</Text>
        </View>
        <Text style={styles.count}>{total}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsInner}>
        {STATUS_FILTERS.map((f) => (
          <Pressable key={f} style={[styles.tab, statusFilter === f && styles.tabActive]} onPress={() => setStatusFilter(f)}>
            <Text style={[styles.tabText, statusFilter === f && styles.tabTextActive]}>{f.replace('_', ' ')}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => <BookingRow item={item} onPress={() => setSelected(item)} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
          onEndReached={() => { if (items.length < total) load(page + 1, true); }}
          onEndReachedThreshold={0.3}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No bookings found.</Text>}
        />
      )}

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={modal.overlay}>
          <View style={[modal.sheet, { maxHeight: '85%' }]}>
            {selected && (
              <>
                <Text style={modal.title}>Booking Detail</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={detail.label}>BOOKING ID</Text>
                  <Text style={detail.value}>{selected.id}</Text>
                  <Text style={detail.label}>STATUS</Text>
                  <Text style={[detail.value, { color: STATUS_COLORS[selected.status] ?? color.ink }]}>
                    {selected.status.replace('_', ' ')}
                  </Text>
                  <Text style={detail.label}>CITY · CATEGORY</Text>
                  <Text style={detail.value}>{selected.city} · {selected.category}</Text>
                  <Text style={detail.label}>DATE</Text>
                  <Text style={detail.value}>{fmtDate(selected.bookingDate)}</Text>
                  <Text style={detail.label}>TOTAL</Text>
                  <Text style={detail.value}>${selected.totalUsd.toFixed(2)} · {selected.paymentMode ?? 'unknown'}</Text>
                  {selected.cashBalanceUsd > 0 && (<>
                    <Text style={detail.label}>CASH BALANCE</Text>
                    <Text style={detail.value}>${selected.cashBalanceUsd.toFixed(2)} · Buddy: {selected.cashBalanceConfirmedByBuddy == null ? 'pending' : selected.cashBalanceConfirmedByBuddy ? 'confirmed' : 'disputed'} · Traveler: {selected.cashBalanceConfirmedByTraveler == null ? 'pending' : selected.cashBalanceConfirmedByTraveler ? 'confirmed' : 'disputed'}</Text>
                  </>)}
                  <Text style={detail.label}>BUDDY ID</Text>
                  <Text style={detail.value}>{selected.buddyId}</Text>
                  <Text style={detail.label}>TRAVELER ID</Text>
                  <Text style={detail.value}>{selected.travelerId}</Text>
                  {selected.safetyStatus && (<>
                    <Text style={detail.label}>SAFETY STATUS</Text>
                    <Text style={[detail.value, { color: '#EF4444' }]}>{selected.safetyStatus}</Text>
                  </>)}
                  <Text style={detail.label}>CREATED</Text>
                  <Text style={detail.value}>{new Date(selected.createdAt).toLocaleString()}</Text>
                </ScrollView>
                <Pressable style={modal.closeBtn} onPress={() => setSelected(null)}>
                  <Text style={modal.closeBtnText}>Close</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderColor: color.haze },
  stamp: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2 },
  title: { ...t.heading, color: color.ink },
  count: { ...t.stamp, color: color.mute },
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
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 5 },
  wrapWarning: { borderColor: '#F59E0B' },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  id: { ...t.stamp, color: color.mute, flex: 1, fontFamily: 'Courier' },
  badge: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  city: { ...t.bodyStrong, color: color.ink },
  date: { ...t.small, color: color.mute },
  bottom: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 2 },
  amount: { ...t.stamp, color: color.ink, fontFamily: 'Courier' },
  mode: { ...t.small, color: color.mute },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#F59E0B20', borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2 },
  warnText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: '#F59E0B' },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.xl, gap: space.md },
  title: { ...t.heading, color: color.ink },
  closeBtn: { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', marginTop: space.md },
  closeBtnText: { ...t.bodyStrong, color: color.mute },
});

const detail = StyleSheet.create({
  label: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.faint, letterSpacing: 1.5, marginTop: space.md },
  value: { ...t.body, color: color.ink },
});
