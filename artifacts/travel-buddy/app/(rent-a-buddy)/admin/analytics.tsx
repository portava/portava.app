/**
 * Rent a Buddy — Admin Analytics Dashboard
 *
 * Stat cards + city/category breakdowns. All monetary figures
 * are labelled as estimates. Date range selector: 7d / 30d / 90d.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../../src/theme/tokens';
import { fetchAdminAnalytics, type AdminAnalytics } from '../../../src/services/rentABuddyAdmin';

const DATE_RANGES = [7, 30, 90] as const;
type DateRange = typeof DATE_RANGES[number];

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <View style={[card.wrap, accent && { borderTopWidth: 3, borderTopColor: accent }]}>
      <Text style={card.label}>{label}</Text>
      <Text style={[card.value, accent ? { color: accent } : {}]}>{value}</Text>
      {sub ? <Text style={card.sub}>{sub}</Text> : null}
    </View>
  );
}

function BarRow({ label, count, max }: { label: string; count: number; max: number }) {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 4;
  return (
    <View style={bar.wrap}>
      <Text style={bar.label} numberOfLines={1}>{label}</Text>
      <View style={bar.track}>
        <View style={[bar.fill, { width: `${pct}%` }]} />
      </View>
      <Text style={bar.count}>{count}</Text>
    </View>
  );
}

export default function AdminAnalyticsScreen() {
  const insets = useSafeAreaInsets();
  const [days, setDays] = useState<DateRange>(30);
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchAdminAnalytics(days);
      setData(result);
    } catch { /* ignore */ }
  }, [days]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const maxCityCount = data?.bookingsByCity.reduce((m, r) => Math.max(m, r.count), 0) ?? 1;
  const maxCatCount = data?.bookingsByCategory.reduce((m, r) => Math.max(m, r.count), 0) ?? 1;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && { opacity: 0.6 }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.stamp}>ADMIN · ANALYTICS</Text>
          <Text style={styles.title}>Marketplace Stats</Text>
        </View>
        {!loading && (
          <Pressable onPress={onRefresh} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <RefreshCw size={18} color={color.mute} />
          </Pressable>
        )}
      </View>

      <View style={styles.rangeRow}>
        {DATE_RANGES.map((d) => (
          <Pressable key={d} style={[styles.rangeBtn, days === d && styles.rangeBtnActive]} onPress={() => setDays(d)}>
            <Text style={[styles.rangeText, days === d && styles.rangeTextActive]}>{d}d</Text>
          </Pressable>
        ))}
        <Text style={styles.estBadge}>Estimated figures</Text>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : !data ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Analytics unavailable.</Text>
          <Text style={styles.emptySub}>The analytics endpoint may need real data to populate.</Text>
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.section}>Overview</Text>
          <View style={styles.grid}>
            <StatCard label="Total Bookings" value={String(data.totalBookings)} />
            <StatCard label="Est. Revenue" value={`$${data.totalRevenue.toLocaleString()}`} sub="estimate only" accent={color.deep} />
            <StatCard label="Active Buddies" value={String(data.activeBuddies)} />
            <StatCard label="Pending Applications" value={String(data.pendingApplications)} accent={color.warn} />
            <StatCard label="Open Safety Flags" value={String(data.openFlags)} accent={color.signal} />
          </View>

          {data.bookingsByStatus.length > 0 && (<>
            <Text style={styles.section}>Bookings by Status</Text>
            <View style={styles.card}>
              {data.bookingsByStatus.map((r) => (
                <BarRow key={r.status} label={r.status.replace('_', ' ')} count={r.count} max={data.totalBookings || 1} />
              ))}
            </View>
          </>)}

          {data.bookingsByCity.length > 0 && (<>
            <Text style={styles.section}>Top Cities</Text>
            <View style={styles.card}>
              {data.bookingsByCity.slice(0, 10).map((r) => (
                <BarRow key={r.city} label={r.city} count={r.count} max={maxCityCount} />
              ))}
            </View>
          </>)}

          {data.bookingsByCategory.length > 0 && (<>
            <Text style={styles.section}>Top Categories</Text>
            <View style={styles.card}>
              {data.bookingsByCategory.slice(0, 10).map((r) => (
                <BarRow key={r.category} label={r.category} count={r.count} max={maxCatCount} />
              ))}
            </View>
          </>)}

          <View style={styles.disclaimer}>
            <Text style={styles.disclaimerText}>
              Revenue figures are estimates based on booking totals and may not reflect actual settled payments or fees.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderColor: color.haze },
  stamp: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2 },
  title: { ...t.heading, color: color.ink },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderColor: color.haze },
  rangeBtn: { paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  rangeBtnActive: { backgroundColor: color.ink, borderColor: color.ink },
  rangeText: { ...t.small, fontWeight: '700', color: color.mute },
  rangeTextActive: { color: color.onInk },
  estBadge: { marginLeft: 'auto', fontFamily: 'Courier', fontSize: 9, color: color.warn, fontWeight: '700', letterSpacing: 0.5 },
  scroll: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  section: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: color.mute, letterSpacing: 1.5, marginTop: space.md, marginBottom: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, ...shadow.card },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  empty: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
  disclaimer: { backgroundColor: color.haze, borderRadius: radius.sm, padding: space.md, marginTop: space.md },
  disclaimerText: { ...t.small, color: color.mute, textAlign: 'center' },
});

const card = StyleSheet.create({
  wrap: {
    flex: 1, minWidth: '45%', backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 2, ...shadow.card,
  },
  label: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: color.faint, letterSpacing: 1.5 },
  value: { ...t.title, color: color.ink, fontSize: 22 },
  sub: { ...t.small, color: color.faint },
});

const bar = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  label: { ...t.small, color: color.ink, width: 100 },
  track: { flex: 1, height: 8, backgroundColor: color.haze, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.deep, borderRadius: 4 },
  count: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: color.mute, width: 36, textAlign: 'right' },
});
