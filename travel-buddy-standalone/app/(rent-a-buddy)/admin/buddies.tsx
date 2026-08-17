/**
 * Rent a Buddy — Admin Buddy Profiles List
 *
 * Searchable, filterable list of all Buddy profiles.
 * Tap opens a detail sheet with full profile info and actions.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, Modal, TextInput,
  StyleSheet, ActivityIndicator, Alert, RefreshControl, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Search, Shield, ShieldOff, Star } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRentABuddyFlag } from '../../../src/hooks/useRentABuddyFlag';
import { listAdminBuddies, setBuddyLevel, updateBuddyCategories, type AdminBuddy } from '../../../src/services/rentABuddyAdmin';
import { supabase } from '../../../src/lib/supabase';

const STATUS_FILTERS = ['all', 'active', 'paused', 'suspended'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

const STATUS_COLORS: Record<string, string> = {
  active: '#10B981',
  paused: '#F59E0B',
  suspended: '#EF4444',
  rejected: '#9CA3AF',
};

const ADMIN_STATUS_COLORS: Record<string, string> = {
  active: '#10B981',
  limited: '#F59E0B',
  disabled: '#EF4444',
};

async function freshToken(): Promise<string | null> {
  try {
    const { data: r } = await supabase.auth.refreshSession();
    const s = r?.session ?? (await supabase.auth.getSession()).data.session;
    return s?.access_token ?? null;
  } catch { return null; }
}

async function buddyAction(buddyId: string, action: 'suspend' | 'reactivate' | 'feature' | 'unfeature'): Promise<{ ok: boolean; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  try {
    const res = await fetch(`${base}/api/rent-a-buddy/admin/buddies/${buddyId}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

function BuddyRow({ item, onPress }: { item: AdminBuddy; onPress: () => void }) {
  const statusColor = STATUS_COLORS[item.status] ?? color.mute;
  const adminColor = ADMIN_STATUS_COLORS[item.adminStatus] ?? color.mute;
  return (
    <Pressable style={({ pressed }) => [row.wrap, pressed && { opacity: 0.85 }]} onPress={onPress}>
      <View style={row.top}>
        <Text style={row.name} numberOfLines={1}>{item.displayName ?? '(no name)'}</Text>
        <View style={[row.badge, { backgroundColor: statusColor + '22', borderColor: statusColor }]}>
          <Text style={[row.badgeText, { color: statusColor }]}>{item.status}</Text>
        </View>
      </View>
      <Text style={row.city}>{item.city}{item.country ? `, ${item.country}` : ''}</Text>
      <Text style={row.cats} numberOfLines={1}>{item.categories.join(', ') || '—'}</Text>
      <View style={row.stats}>
        <View style={[row.statBadge, { backgroundColor: adminColor + '20', borderColor: adminColor }]}>
          <Text style={[row.statText, { color: adminColor }]}>Admin: {item.adminStatus}</Text>
        </View>
        {item.averageRating != null && (
          <View style={row.statBadge}>
            <Star size={10} color={color.warn} fill={color.warn} />
            <Text style={row.statText}>{item.averageRating.toFixed(1)}</Text>
          </View>
        )}
        <Text style={row.statText}>{item.completedBookings} bookings</Text>
        {item.riskHold && (
          <View style={[row.statBadge, { backgroundColor: '#EF444430', borderColor: '#EF4444' }]}>
            <Text style={[row.statText, { color: '#EF4444' }]}>RISK HOLD</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

function FeatureDisabled() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{ fontFamily: 'Courier', fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
        Rent a Buddy is not enabled in this environment.
      </Text>
    </View>
  );
}

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

export default function AdminBuddiesScreen() {
  useRequireAdmin();
  const insets = useSafeAreaInsets();
  const { enabled: featureEnabled, loading: flagLoading } = useRentABuddyFlag();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'standard' | 'pro' | 'elite'>('all');
  const [items, setItems] = useState<AdminBuddy[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AdminBuddy | null>(null);
  const [acting, setActing] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async (p = 1, append = false) => {
    try {
      const data = await listAdminBuddies({
        city: search.trim() || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        category: categoryFilter.trim() || undefined,
        level: levelFilter === 'all' ? undefined : levelFilter,
        page: p,
      });
      setItems(prev => append ? [...prev, ...data.buddies] : data.buddies);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      if (e?.message === 'forbidden') setForbidden(true);
    }
  }, [search, statusFilter, categoryFilter, levelFilter]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => load(1).finally(() => setLoading(false)), 300);
    return () => clearTimeout(t);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(1);
    setRefreshing(false);
  }, [load]);

  async function handleAction(action: 'suspend' | 'reactivate' | 'feature' | 'unfeature') {
    if (!selected) return;
    setActing(true);
    const res = await buddyAction(selected.id, action);
    setActing(false);
    if (!res.ok) {
      Alert.alert('Error', bookingErrorCopy(res.error, 'Failed'));
      return;
    }
    setSelected(null);
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
          <Text style={styles.stamp}>ADMIN</Text>
          <Text style={styles.title}>Buddy Profiles</Text>
        </View>
        <Text style={styles.count}>{total}</Text>
      </View>

      <View style={styles.searchWrap}>
        <Search size={16} color={color.faint} />
        <TextInput
          style={styles.searchInput}
          placeholder="Filter by city…"
          placeholderTextColor={color.faint}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
      </View>
      <View style={[styles.searchWrap, { borderTopWidth: 0 }]}>
        <TextInput
          style={styles.searchInput}
          placeholder="Filter by category…"
          placeholderTextColor={color.faint}
          value={categoryFilter}
          onChangeText={setCategoryFilter}
          returnKeyType="search"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsInner}>
        {(['all', 'standard', 'pro', 'elite'] as const).map(lvl => (
          <Pressable key={`lvl-${lvl}`} style={[styles.tab, levelFilter === lvl && styles.tabActive]} onPress={() => setLevelFilter(lvl)}>
            <Text style={[styles.tabText, levelFilter === lvl && styles.tabTextActive]}>{lvl === 'all' ? 'Any Level' : lvl}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsInner}>
        {STATUS_FILTERS.map((f) => (
          <Pressable key={f} style={[styles.tab, statusFilter === f && styles.tabActive]} onPress={() => setStatusFilter(f)}>
            <Text style={[styles.tabText, statusFilter === f && styles.tabTextActive]}>{f}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => <BuddyRow item={item} onPress={() => setSelected(item)} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
          onEndReached={() => { if (items.length < total) load(page + 1, true); }}
          onEndReachedThreshold={0.3}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No Buddy profiles found.</Text>}
        />
      )}

      {/* Detail modal */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={modal.overlay}>
          <View style={[modal.sheet, { maxHeight: '85%' }]}>
            {selected && (
              <>
                <Text style={modal.title}>{selected.displayName ?? '(no name)'}</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={detail.label}>BUDDY ID</Text>
                  <Text style={detail.value}>{selected.id}</Text>
                  <Text style={detail.label}>USER ID</Text>
                  <Text style={detail.value}>{selected.userId}</Text>
                  <Text style={detail.label}>LOCATION</Text>
                  <Text style={detail.value}>{selected.city}{selected.country ? `, ${selected.country}` : ''}</Text>
                  <Text style={detail.label}>CATEGORIES</Text>
                  <Text style={detail.value}>{selected.categories.join(', ') || '—'}</Text>
                  <Text style={detail.label}>STATUS</Text>
                  <Text style={detail.value}>{selected.status} · Admin: {selected.adminStatus}</Text>
                  <Text style={detail.label}>RATING</Text>
                  <Text style={detail.value}>{selected.averageRating != null ? `${selected.averageRating.toFixed(1)} (${selected.reviewCount} reviews)` : 'No reviews yet'}</Text>
                  <Text style={detail.label}>BOOKINGS</Text>
                  <Text style={detail.value}>{selected.completedBookings} completed</Text>
                  <Text style={detail.label}>RISK HOLD</Text>
                  <Text style={detail.value}>{selected.riskHold ? 'YES' : 'No'}</Text>
                  <Text style={detail.label}>LEVEL</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: space.sm }}>
                    {(['standard', 'pro', 'elite'] as const).map(lvl => {
                      const active = (selected.buddyLevel ?? 'standard').toLowerCase() === lvl;
                      return (
                        <Pressable key={lvl} disabled={acting}
                          style={[detail.btn, active && { backgroundColor: '#3B82F620', borderColor: '#3B82F6' }]}
                          onPress={async () => {
                            setActing(true);
                            await setBuddyLevel(selected.id, lvl);
                            setActing(false);
                            setSelected({ ...selected, buddyLevel: lvl });
                          }}>
                          <Text style={[detail.btnText, active && { color: '#3B82F6' }]}>{lvl}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text style={detail.label}>CATEGORIES (toggle to disable)</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space.sm }}>
                    {selected.categories.map(cat => (
                      <Pressable key={cat} disabled={acting}
                        style={[detail.btn, { backgroundColor: '#10B98120' }]}
                        onPress={async () => {
                          setActing(true);
                          const next = selected.categories.filter(c => c !== cat);
                          await updateBuddyCategories(selected.id, next);
                          setActing(false);
                          setSelected({ ...selected, categories: next });
                        }}>
                        <Text style={[detail.btnText, { color: '#10B981' }]}>{cat} ✕</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={detail.label}>FEATURED</Text>
                  <Text style={detail.value}>{selected.featured ? '⭐ Yes' : 'No'}</Text>
                  <Text style={detail.label}>JOINED</Text>
                  <Text style={detail.value}>{new Date(selected.createdAt).toLocaleDateString()}</Text>

                  <Pressable style={detail.profileLink}
                    onPress={() => {
                      // /profile/[handle] resolves by @handle, not user id — a raw
                      // UUID 404s. The buddy's public listing page takes the buddy id.
                      const buddyId = selected.id;
                      setSelected(null);
                      router.push(`/(rent-a-buddy)/buddy/${buddyId}` as any);
                    }}>
                    <Text style={detail.profileLinkText}>View Buddy Listing →</Text>
                  </Pressable>

                  <View style={detail.actions}>
                    <Pressable style={[detail.btn, { backgroundColor: '#F59E0B20' }]}
                      onPress={() => handleAction('suspend')} disabled={acting}>
                      <ShieldOff size={14} color='#F59E0B' />
                      <Text style={[detail.btnText, { color: '#F59E0B' }]}>Suspend</Text>
                    </Pressable>
                    <Pressable style={[detail.btn, { backgroundColor: '#10B98120' }]}
                      onPress={() => handleAction('reactivate')} disabled={acting}>
                      <Shield size={14} color='#10B981' />
                      <Text style={[detail.btnText, { color: '#10B981' }]}>Reactivate</Text>
                    </Pressable>
                    <Pressable style={[detail.btn, { backgroundColor: '#F59E0B20' }]}
                      onPress={() => handleAction('feature')} disabled={acting}>
                      <Star size={14} color='#F59E0B' />
                      <Text style={[detail.btnText, { color: '#F59E0B' }]}>Feature</Text>
                    </Pressable>
                    <Pressable style={[detail.btn, { backgroundColor: color.haze }]}
                      onPress={() => handleAction('unfeature')} disabled={acting}>
                      <Star size={14} color={color.mute} />
                      <Text style={[detail.btnText, { color: color.mute }]}>Unfeature</Text>
                    </Pressable>
                  </View>
                </ScrollView>
                <Pressable style={[modal.closeBtn]} onPress={() => setSelected(null)}>
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
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginVertical: space.sm, backgroundColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8 },
  searchInput: { flex: 1, ...t.body, color: color.ink },
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
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { ...t.bodyStrong, color: color.ink, flex: 1 },
  badge: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  city: { ...t.small, color: color.mute },
  cats: { ...t.small, color: color.deep },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  statBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, paddingHorizontal: 6, paddingVertical: 2 },
  statText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.3 },
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
  profileLink: { marginTop: space.lg, padding: space.md, borderRadius: radius.sm, backgroundColor: color.haze, alignItems: 'center' },
  profileLinkText: { ...t.bodyStrong, color: color.ink },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.xl, flexWrap: 'wrap' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md },
  btnText: { ...t.small, fontWeight: '700' },
});
