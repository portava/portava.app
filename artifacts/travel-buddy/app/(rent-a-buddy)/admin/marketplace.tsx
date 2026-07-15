import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, BarChart2, AlertTriangle, Map, DollarSign, Users } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState } from '../../../src/components/primitives';
import { supabase } from '../../../src/lib/supabase';

const apiBase = () => (process.env.EXPO_PUBLIC_API_BASE_URL ?? '');

async function fetchAnalytics() {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch(`${apiBase()}/api/rent-a-buddy/admin/marketplace/analytics`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error((b as any)?.error ?? `HTTP ${res.status}`); }
  return res.json();
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string | number; sub?: string }) {
  return (
    <View style={sc.wrap}>
      <View style={sc.icon}>{icon}</View>
      <Text style={sc.val}>{value}</Text>
      <Text style={sc.lbl}>{label}</Text>
      {sub ? <Text style={sc.sub}>{sub}</Text> : null}
    </View>
  );
}

function CityRow({ city, stats }: { city: string; stats: { bookings: number; revenue: number } }) {
  return (
    <View style={cr.wrap}>
      <View style={cr.left}>
        <Map size={14} color={color.deep} />
        <Text style={cr.city}>{city}</Text>
      </View>
      <View style={cr.right}>
        <Text style={cr.bookings}>{stats.bookings} bkgs</Text>
        <Text style={cr.revenue}>${stats.revenue.toFixed(0)}</Text>
      </View>
    </View>
  );
}

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';

export default function AdminMarketplace() {
  useRequireAdmin();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const result = await fetchAnalytics();
      setData(result);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load analytics');
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <TravelLoadingState label="Loading analytics…" />;
  if (error) return <TravelErrorState title="Failed to load" sub={error} onRetry={() => load()} />;

  const byCitySorted = data?.bookings?.byCity
    ? Object.entries(data.bookings.byCity as Record<string, any>).sort((a, b) => b[1].bookings - a[1].bookings)
    : [];

  const byCatSorted = data?.bookings?.byCategory
    ? Object.entries(data.bookings.byCategory as Record<string, any>).sort((a, b) => b[1].count - a[1].count)
    : [];

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Marketplace Analytics</Text>
      </View>

      <ScrollView
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + space.xxxl }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
      >
        <Text style={s.period}>Last 30 days</Text>

        <View style={s.statsGrid}>
          <StatCard icon={<BarChart2 size={20} color={color.deep} />} label="Total Bookings" value={data?.bookings?.total ?? 0} />
          <StatCard icon={<DollarSign size={20} color={color.success} />} label="Revenue" value={`$${(data?.revenue?.total ?? 0).toFixed(0)}`} />
          <StatCard icon={<Users size={20} color={color.warn} />} label="Conversion" value={`${data?.conversion?.conversionRate ?? 0}%`} sub={`${data?.conversion?.searches ?? 0} searches`} />
          <StatCard icon={<AlertTriangle size={20} color={color.signal} />} label="Open Flags" value={data?.policyFlags?.open ?? 0} sub={`${data?.policyFlags?.critical ?? 0} critical`} />
        </View>

        <View style={s.revenueRow}>
          <View style={s.revCell}>
            <Text style={s.revLbl}>Deposit collected</Text>
            <Text style={s.revVal}>${(data?.revenue?.deposit ?? 0).toFixed(2)}</Text>
          </View>
          <View style={s.revCell}>
            <Text style={s.revLbl}>Cash balance</Text>
            <Text style={s.revVal}>${(data?.revenue?.cashBalance ?? 0).toFixed(2)}</Text>
          </View>
        </View>

        {data?.bookings?.byStatus ? (
          <View style={s.statusRow}>
            {Object.entries(data.bookings.byStatus as Record<string, number>).map(([status, count]) => (
              <View key={status} style={s.statusChip}>
                <Text style={s.statusCount}>{count as number}</Text>
                <Text style={s.statusLabel}>{status}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {byCitySorted.length > 0 ? <Text style={s.sectionTitle}>By City</Text> : null}
        {byCitySorted.map(([city, stats]) => (
          <CityRow key={city} city={city} stats={stats as any} />
        ))}

        {byCatSorted.length > 0 ? <Text style={s.sectionTitle}>By Category</Text> : null}
        {byCatSorted.map(([cat, stats]) => (
          <View key={cat} style={cr.wrap}>
            <Text style={cr.city}>{cat}</Text>
            <Text style={cr.revenue}>{(stats as any).count} · ${((stats as any).revenue ?? 0).toFixed(0)}</Text>
          </View>
        ))}

        <Text style={s.sectionTitle}>Quick Actions</Text>
        <View style={s.actions}>
          <Pressable style={s.actionBtn} onPress={() => router.push('/(rent-a-buddy)/admin/package-queue' as any)}>
            <Text style={s.actionLabel}>Package Review Queue</Text>
          </Pressable>
          <Pressable style={s.actionBtn} onPress={() => router.push('/(rent-a-buddy)/admin/fee-rules' as any)}>
            <Text style={s.actionLabel}>Edit Fee Rules</Text>
          </Pressable>
          <Pressable style={[s.actionBtn, { borderColor: color.signal }]} onPress={() => router.push('/(rent-a-buddy)/admin/flags' as any)}>
            <Text style={[s.actionLabel, { color: color.signal }]}>
              Policy Flags ({data?.policyFlags?.open ?? 0} open)
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink },
  content: { padding: space.lg, gap: space.lg },
  period: { ...t.small, color: color.mute },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  revenueRow: { flexDirection: 'row', gap: space.md },
  revCell: { flex: 1, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md },
  revLbl: { ...t.small, color: color.mute },
  revVal: { ...t.bodyStrong, color: color.ink },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  statusChip: { backgroundColor: color.haze, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center' },
  statusCount: { ...t.small, color: color.ink, fontWeight: '700' },
  statusLabel: { ...t.small, color: color.mute },
  sectionTitle: { ...t.small, color: color.mute, fontWeight: '700', marginTop: space.sm },
  actions: { gap: space.md },
  actionBtn: { padding: space.lg, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center' },
  actionLabel: { ...t.body, color: color.deep, fontWeight: '700' },
});

const sc = StyleSheet.create({
  wrap: { flex: 1, minWidth: '42%' as any, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', gap: space.xs },
  icon: { marginBottom: space.xs },
  val: { ...t.heading, color: color.ink },
  lbl: { ...t.small, color: color.mute, textAlign: 'center' },
  sub: { ...t.small, color: color.mute },
});

const cr = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  left: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  city: { ...t.body, color: color.ink, fontWeight: '600' },
  right: { flexDirection: 'row', gap: space.md },
  bookings: { ...t.small, color: color.mute },
  revenue: { ...t.small, color: color.success, fontWeight: '700' },
});
