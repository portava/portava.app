import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Check, X, Package } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../../src/components/primitives';
import { supabase } from '../../../src/lib/supabase';

const apiBase = () => (process.env.EXPO_PUBLIC_API_BASE_URL ?? '');

async function adminFetch(path: string, opts: RequestInit = {}) {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const res = await fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers as Record<string, string> ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  return body;
}

interface PendingPackage {
  id: string;
  title: string;
  category: string;
  city: string;
  priceUsd: number;
  maxGroup: number;
  durationH: number;
  adminReviewStatus: string;
  createdAt: string;
  buddyId: string;
}

async function loadPendingPackages(): Promise<PendingPackage[]> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const res = await fetch(`${apiBase()}/api/rent-a-buddy/admin/marketplace/analytics`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error('Failed to load');
  return [];
}

async function directFetch<T>(path: string): Promise<T> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

async function fetchPendingPackagesDirect(): Promise<PendingPackage[]> {
  const { data, error } = await supabase
    .from('rent_buddy_packages')
    .select('id, title, category, city, price_usd, max_group, duration_h, admin_review_status, created_at, buddy_id')
    .eq('admin_review_status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map((p: any) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    city: p.city,
    priceUsd: Number(p.price_usd),
    maxGroup: p.max_group,
    durationH: Number(p.duration_h),
    adminReviewStatus: p.admin_review_status,
    createdAt: p.created_at,
    buddyId: p.buddy_id,
  }));
}

function PackageItem({ pkg, onApprove, onDisable, actioning }: {
  pkg: PendingPackage;
  onApprove: () => void;
  onDisable: () => void;
  actioning: boolean;
}) {
  const needsNightlife = pkg.category === 'nightlife';
  const isGroup = pkg.maxGroup > 4;

  return (
    <View style={[item.wrap, shadow.card]}>
      <View style={item.header}>
        <Package size={16} color={color.deep} />
        <Text style={item.title} numberOfLines={1}>{pkg.title}</Text>
        <Text style={item.status}>{pkg.adminReviewStatus}</Text>
      </View>

      <View style={item.meta}>
        <Text style={item.metaText}>{pkg.category} · {pkg.city}</Text>
        <Text style={item.metaText}>${pkg.priceUsd} · {pkg.durationH}h · Group {pkg.maxGroup}</Text>
      </View>

      {(needsNightlife || isGroup) && (
        <View style={item.flagRow}>
          {needsNightlife && <View style={item.flag}><Text style={item.flagText}>🌃 Nightlife</Text></View>}
          {isGroup && <View style={item.flag}><Text style={item.flagText}>👥 Large group</Text></View>}
        </View>
      )}

      <Text style={item.date}>Submitted {new Date(pkg.createdAt).toLocaleDateString()}</Text>

      <View style={item.actions}>
        <Pressable style={[item.btn, item.disableBtn]} onPress={onDisable} disabled={actioning}>
          <X size={16} color={color.signal} />
          <Text style={[item.btnLabel, { color: color.signal }]}>Disable</Text>
        </Pressable>
        <Pressable style={[item.btn, item.approveBtn]} onPress={onApprove} disabled={actioning}>
          <Check size={16} color="#fff" />
          <Text style={[item.btnLabel, { color: '#fff' }]}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

export default function PackageQueue() {
  useRequireAdmin();
  const insets = useSafeAreaInsets();
  const [packages, setPackages] = useState<PendingPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const pkgs = await fetchPendingPackagesDirect();
      setPackages(pkgs);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load');
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = useCallback(async (pkg: PendingPackage) => {
    setActioningId(pkg.id);
    try {
      await adminFetch(`/api/rent-a-buddy/admin/packages/${pkg.id}/approve`, { method: 'POST' });
      setPackages((prev) => prev.filter((p) => p.id !== pkg.id));
    } catch (err: any) {
      Alert.alert('Error', bookingErrorCopy(err?.message));
    } finally {
      setActioningId(null);
    }
  }, []);

  const disable = useCallback(async (pkg: PendingPackage) => {
    Alert.alert('Disable Package', `Disable "${pkg.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disable', style: 'destructive',
        onPress: async () => {
          setActioningId(pkg.id);
          try {
            await adminFetch(`/api/rent-a-buddy/admin/packages/${pkg.id}/disable`, { method: 'POST' });
            setPackages((prev) => prev.filter((p) => p.id !== pkg.id));
          } catch (err: any) {
            Alert.alert('Error', bookingErrorCopy(err?.message));
          } finally {
            setActioningId(null);
          }
        },
      },
    ]);
  }, []);

  if (loading) return <TravelLoadingState label="Loading package queue…" />;
  if (error) return <TravelErrorState title="Failed to load" sub={error} onRetry={() => load()} />;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View>
          <Text style={s.title}>Package Review Queue</Text>
          <Text style={s.sub}>{packages.length} pending</Text>
        </View>
      </View>

      <FlatList
        data={packages}
        keyExtractor={(p) => p.id}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + space.xxxl }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
        renderItem={({ item }) => (
          <PackageItem
            pkg={item}
            onApprove={() => approve(item)}
            onDisable={() => disable(item)}
            actioning={actioningId === item.id}
          />
        )}
        ListEmptyComponent={
          <TravelEmptyState title="Queue is empty" sub="All packages have been reviewed." />
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink },
  sub: { ...t.small, color: color.mute },
  list: { padding: space.lg, gap: space.md },
});

const item = StyleSheet.create({
  wrap: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  title: { ...t.body, color: color.ink, fontWeight: '700', flex: 1 },
  status: { ...t.small, color: color.warn, fontWeight: '700', backgroundColor: `${color.warn}15`, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  meta: { gap: space.xs, marginBottom: space.sm },
  metaText: { ...t.small, color: color.mute },
  flagRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  flag: { backgroundColor: `${color.deep}12`, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  flagText: { ...t.small, color: color.deep },
  date: { ...t.small, color: color.mute, marginBottom: space.md },
  actions: { flexDirection: 'row', gap: space.md },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1.5 },
  disableBtn: { borderColor: `${color.signal}40`, backgroundColor: `${color.signal}08` },
  approveBtn: { borderColor: color.deep, backgroundColor: color.deep },
  btnLabel: { ...t.body, fontWeight: '700' },
});
