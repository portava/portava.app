import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, RefreshControl, FlatList,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, TrendingUp, AlertCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../../src/components/primitives';
import {
  getEarningsSummary, getEarningsLedger,
  type EarningsSummary, type LedgerEntry,
} from '../../../src/services/rentABuddy';

function SummaryCard({ summary }: { summary: EarningsSummary }) {
  return (
    <View style={sum.wrap}>
      {summary.isEstimated ? (
        <View style={sum.notice}>
          <AlertCircle size={13} color={color.warn} />
          <Text style={sum.noticeText}>{summary.warning}</Text>
        </View>
      ) : null}
      <View style={sum.statsGrid}>
        <View style={sum.stat}>
          <Text style={sum.statVal}>${summary.estimatedBuddyEarningsUsd.toFixed(2)}</Text>
          <Text style={sum.statLbl}>Est. Earnings</Text>
        </View>
        <View style={sum.stat}>
          <Text style={sum.statVal}>${summary.estimatedPlatformFeeUsd.toFixed(2)}</Text>
          <Text style={sum.statLbl}>Platform Fee</Text>
        </View>
        <View style={sum.stat}>
          <Text style={sum.statVal}>{summary.completed.count}</Text>
          <Text style={sum.statLbl}>Completed</Text>
        </View>
        <View style={sum.stat}>
          <Text style={sum.statVal}>${summary.tips.total.toFixed(2)}</Text>
          <Text style={sum.statLbl}>Tips</Text>
        </View>
      </View>
      <View style={sum.row}>
        <View style={sum.col}>
          <Text style={sum.colLbl}>Deposit collected</Text>
          <Text style={sum.colVal}>${summary.completed.depositCollected.toFixed(2)}</Text>
        </View>
        <View style={sum.col}>
          <Text style={sum.colLbl}>Cash balance due</Text>
          <Text style={sum.colVal}>${summary.completed.cashBalanceDue.toFixed(2)}</Text>
        </View>
      </View>
      {summary.upcoming.bookingCount > 0 ? (
        <View style={sum.upcomingBanner}>
          <TrendingUp size={14} color={color.success} />
          <Text style={sum.upcomingText}>
            {summary.upcoming.bookingCount} upcoming booking{summary.upcoming.bookingCount !== 1 ? 's' : ''}
          </Text>
        </View>
      ) : null}
      {summary.averageRating != null ? (
        <View style={sum.ratingRow}>
          <Text style={sum.ratingText}>⭐ {summary.averageRating.toFixed(1)} avg rating · {summary.reviewCount} reviews</Text>
          {summary.trustLevel ? <Text style={sum.trustText}>Trust: {summary.trustLevel}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  return (
    <View style={row.wrap}>
      <View style={row.header}>
        <Text style={row.type}>{entry.pricingType ?? 'Booking'}</Text>
        <Text style={row.net}>+${entry.buddyNetEstimatedAmount.toFixed(2)}</Text>
      </View>
      <View style={row.details}>
        <Text style={row.detail}>
          Gross ${entry.totalBookingUsd.toFixed(2)} · Fee {entry.platformFeePercent ?? 22}% = ${entry.platformFeeAmount.toFixed(2)}
        </Text>
        {entry.tipUsd > 0 ? <Text style={row.detail}>Tip: +${entry.tipUsd.toFixed(2)}</Text> : null}
        {entry.depositAmount > 0 ? (
          <Text style={row.detail}>In-app ${entry.depositAmount.toFixed(2)} · Cash ${entry.cashBalanceDue.toFixed(2)}</Text>
        ) : null}
        {entry.isEstimated ? <Text style={row.estimated}>Estimated — not yet paid</Text> : null}
      </View>
      <Text style={row.date}>{new Date(entry.createdAt).toLocaleDateString()}</Text>
    </View>
  );
}

export default function EarningsLedger() {
  const insets = useSafeAreaInsets();
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 20;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoadingData(true);
    setError(null);
    const [sumRes, ledRes] = await Promise.all([
      getEarningsSummary(),
      getEarningsLedger(PAGE_SIZE, 0),
    ]);
    if (!silent) setLoadingData(false);
    setRefreshing(false);
    if (!sumRes.ok) { setError(sumRes.error); return; }
    if (!ledRes.ok) { setError(ledRes.error); return; }
    setSummary(sumRes.data);
    setLedger(ledRes.data.ledger);
    setTotal(ledRes.data.total);
    setOffset(PAGE_SIZE);
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || ledger.length >= total) return;
    setLoadingMore(true);
    const res = await getEarningsLedger(PAGE_SIZE, offset);
    setLoadingMore(false);
    if (!res.ok) return;
    setLedger((prev) => [...prev, ...res.data.ledger]);
    setOffset((o) => o + PAGE_SIZE);
  }, [loadingMore, ledger.length, total, offset]);

  useEffect(() => { load(); }, [load]);

  if (loadingData) return <TravelLoadingState label="Loading earnings…" />;
  if (error) return <TravelErrorState title="Failed to load earnings" sub={error} onRetry={() => load()} />;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Earnings</Text>
      </View>

      <FlatList
        data={ledger}
        keyExtractor={(e) => e.id ?? e.bookingId}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
        ListHeaderComponent={
          <>
            {summary ? <SummaryCard summary={summary} /> : null}
            <Text style={s.sectionTitle}>Transaction Ledger</Text>
          </>
        }
        ListEmptyComponent={
          <TravelEmptyState title="No transactions yet" sub="Completed bookings will appear here." />
        }
        renderItem={({ item }) => <LedgerRow entry={item} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink },
  sectionTitle: { ...t.small, color: color.mute, fontWeight: '700', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
});

const sum = StyleSheet.create({
  wrap: { margin: space.lg, backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, backgroundColor: `${color.warn}12`, borderRadius: radius.sm, padding: space.md },
  noticeText: { ...t.small, color: color.warn, flex: 1 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  stat: { flex: 1, minWidth: '40%' as any, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center' },
  statVal: { ...t.heading, color: color.ink },
  statLbl: { ...t.small, color: color.mute, marginTop: 2 },
  row: { flexDirection: 'row', gap: space.md },
  col: { flex: 1 },
  colLbl: { ...t.small, color: color.mute },
  colVal: { ...t.body, color: color.ink, fontWeight: '600' },
  upcomingBanner: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: `${color.success}12`, borderRadius: radius.sm, padding: space.md },
  upcomingText: { ...t.small, color: color.success, fontWeight: '600' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ratingText: { ...t.small, color: color.mute },
  trustText: { ...t.small, color: color.deep, fontWeight: '600' },
});

const row = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.xs },
  type: { ...t.body, color: color.ink, fontWeight: '600', textTransform: 'capitalize' },
  net: { ...t.body, color: color.success, fontWeight: '700' },
  details: { gap: 2 },
  detail: { ...t.small, color: color.mute },
  estimated: { ...t.small, color: color.warn, fontStyle: 'italic' },
  date: { ...t.small, color: color.mute, marginTop: space.xs },
});
