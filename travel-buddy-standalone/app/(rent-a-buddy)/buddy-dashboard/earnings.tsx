import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, RefreshControl, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, AlertCircle, DollarSign, Clock, TrendingUp, Flag } from 'lucide-react-native';
import {
  TravelCard, TravelSectionHeader, TravelLoadingState, TravelErrorState,
  TravelEmptyState,
} from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import { color, space, radius, type as t, shadow } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyEarnings, BuddyBooking } from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

function EarningBanner() {
  return (
    <View style={banner.wrap}>
      <AlertCircle size={16} color={color.warn} />
      <Text style={banner.text}>
        Payouts are not yet connected — all figures are estimates only.
        Cash balance is tracked but not processed.
      </Text>
    </View>
  );
}

function StatBlock({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <View style={stat.wrap}>
      <Text style={stat.label}>{label}</Text>
      <Text style={[stat.value, accent ? { color: accent } : undefined]}>{value}</Text>
      {sub ? <Text style={stat.sub}>{sub}</Text> : null}
    </View>
  );
}

function BookingRow({ booking }: { booking: BuddyBooking }) {
  const date = new Date(booking.bookingDate).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const statusColor: Record<string, string> = {
    completed: color.success,
    in_progress: color.deep,
    disputed: color.signal,
    cancelled: color.haze,
    pending: color.warn,
    confirmed: color.warn,
  };
  return (
    <View style={bk.row}>
      <View style={{ flex: 1 }}>
        <Text style={bk.date}>{date}</Text>
        <Text style={bk.meta}>{booking.category} · {booking.durationH}h · {booking.city}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={bk.amount}>${booking.totalUsd.toFixed(2)}</Text>
        <Text style={[bk.status, { color: statusColor[booking.status] ?? color.mute }]}>
          {booking.status.toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

const FILTER_OPTIONS = ['All time', 'This month', 'Last 3 months', 'This year'];

export default function BuddyEarnings() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [earnings, setEarnings] = useState<BuddyEarnings | null>(null);
  const [bookings, setBookings] = useState<BuddyBooking[]>([]);
  const [filter, setFilter] = useState('This month');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const [earningsRes, bookingsRes] = await Promise.all([
      rentABuddy.getDashboardEarnings(),
      rentABuddy.listMyBookings(),
    ]);
    if (!silent) setLoading(false);
    if (earningsRes.ok) setEarnings(earningsRes.data);
    else setError(earningsRes.error);
    if (bookingsRes.ok) setBookings(bookingsRes.data.bookings);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  if (loading) return <TravelLoadingState label="Loading earnings…" />;
  if (error) return <TravelErrorState title="Couldn't load earnings" sub={error} onRetry={() => load()} />;

  // Completed list honors the date-range filter chips (previously a no-op).
  const filterCutoff = (() => {
    const now = new Date();
    switch (filter) {
      case 'This month': return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      case 'Last 3 months': return new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime();
      case 'This year': return new Date(now.getFullYear(), 0, 1).getTime();
      default: return 0; // 'All time'
    }
  })();
  const completed = bookings.filter((b) => {
    if (b.status !== 'completed') return false;
    if (filterCutoff === 0) return true;
    const when = Date.parse(b.completedAt ?? b.bookingDate ?? b.updatedAt ?? '');
    return Number.isFinite(when) ? when >= filterCutoff : true;
  });
  const pending = bookings.filter((b) => b.status === 'scheduled' || b.status === 'in_progress');
  const disputed = bookings.filter((b) => b.status === 'disputed');

  const estimatedWeek = (earnings?.thisMonthUsd ?? 0) / 4;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: color.paper }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
    >
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Stamp label="ESTIMATED ONLY" tone="onInk" rotate={-1} style={{ marginBottom: 4 }} />
          <Text style={s.headerTitle}>Earnings</Text>
        </View>
      </View>

      {/* Payout warning banner */}
      <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
        <EarningBanner />
      </View>

      {/* Summary grid */}
      <View style={s.grid}>
        <StatBlock
          label="Est. this week"
          value={`$${estimatedWeek.toFixed(0)}`}
          sub="Estimate only"
          accent={color.success}
        />
        <StatBlock
          label="Est. this month"
          value={`$${(earnings?.thisMonthUsd ?? 0).toFixed(0)}`}
          sub="Estimate only"
          accent={color.success}
        />
        <StatBlock
          label="All-time est."
          value={`$${(earnings?.totalUsd ?? 0).toFixed(0)}`}
          sub="Estimate only"
        />
        <StatBlock
          label="Completed"
          value={String(earnings?.completedBookings ?? 0)}
          sub="bookings"
        />
      </View>

      {/* Pending earnings */}
      <TravelSectionHeader title="Pending clearance" kicker="AWAITING" />
      {pending.length === 0 ? (
        <TravelEmptyState title="No pending earnings" sub="Earnings from confirmed bookings appear here." />
      ) : (
        <View style={s.cardList}>
          {pending.map((b) => (
            <TravelCard key={b.id} style={{ padding: space.md }}>
              <BookingRow booking={b} />
            </TravelCard>
          ))}
        </View>
      )}

      {/* Cash balance */}
      <TravelSectionHeader title="Cash balance due" kicker="COLLECT IN PERSON" />
      <View style={{ paddingHorizontal: space.lg }}>
        <TravelCard style={{ padding: space.lg, borderLeftWidth: 4, borderLeftColor: color.warn }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
            <DollarSign size={18} color={color.warn} />
            <Text style={{ ...t.bodyStrong, color: color.warn }}>Cash-payment bookings</Text>
          </View>
          <Text style={{ ...t.small, color: color.mute, lineHeight: 17 }}>
            Some travellers pay in cash at the time of booking. These amounts are tracked here but are not processed through the app.
            Mark as collected in each booking's detail screen once received.
          </Text>
        </TravelCard>
      </View>

      {/* Completed bookings */}
      <TravelSectionHeader title="Completed bookings" kicker="HISTORY" />
      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ paddingHorizontal: space.lg, marginBottom: space.sm }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {FILTER_OPTIONS.map((f) => (
            <Pressable
              key={f}
              style={[chip.base, filter === f && chip.active]}
              onPress={() => setFilter(f)}
            >
              <Text style={[chip.text, filter === f && chip.textActive]}>{f}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {completed.length === 0 ? (
        <TravelEmptyState title="No completed bookings" sub="Your completed booking history will appear here." />
      ) : (
        <View style={s.cardList}>
          {completed.map((b) => (
            <TravelCard key={b.id} style={{ padding: space.md }}>
              <BookingRow booking={b} />
              <View style={bk.breakdown}>
                {[
                  { label: 'Gross', value: `$${b.totalUsd.toFixed(2)}` },
                  { label: 'Platform fee (est.)', value: `-$${(b.totalUsd * 0.1).toFixed(2)}` },
                  { label: 'You keep (est.)', value: `$${(b.totalUsd * 0.9).toFixed(2)}`, bold: true },
                ].map(({ label, value, bold }) => (
                  <View key={label} style={bk.breakRow}>
                    <Text style={[bk.breakLabel, bold && { fontWeight: '600' }]}>{label}</Text>
                    <Text style={[bk.breakVal, bold && { color: color.success, fontWeight: '700' }]}>{value}</Text>
                  </View>
                ))}
              </View>
            </TravelCard>
          ))}
        </View>
      )}

      {/* Disputed */}
      {disputed.length > 0 && (
        <>
          <TravelSectionHeader title="Disputed earnings" kicker="NEEDS ATTENTION" />
          <View style={s.cardList}>
            {disputed.map((b) => (
              <TravelCard key={b.id} style={{ padding: space.md }}>
                <BookingRow booking={b} />
                <Pressable
                  style={disp.btn}
                  onPress={() => {
                    // File a real report on the disputed booking — no fake tickets.
                    Alert.alert('Flag for review', 'Send this disputed booking to our team for review?', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Send',
                        onPress: async () => {
                          const res = await rentABuddy.reportBooking(b.id, { reason: 'Earnings dispute', details: 'Flagged from the earnings screen.' });
                          if (res.ok) Alert.alert('Sent for review', 'Our team will look at this booking and follow up.');
                          else Alert.alert('Could not send', bookingErrorCopy(res.error, 'Please try again.'));
                        },
                      },
                    ]);
                  }}
                >
                  <Flag size={13} color={color.signal} />
                  <Text style={disp.btnText}>Flag for review</Text>
                </Pressable>
              </TravelCard>
            ))}
          </View>
        </>
      )}

      {/* Monthly breakdown */}
      {earnings?.breakdown && earnings.breakdown.length > 0 && (
        <>
          <TravelSectionHeader title="Monthly breakdown" kicker="ESTIMATES" />
          <View style={s.cardList}>
            <TravelCard padded={false}>
              {earnings.breakdown.map((m, i) => (
                <View
                  key={m.month}
                  style={[month.row, i < earnings.breakdown.length - 1 && month.divider]}
                >
                  <Text style={month.label}>{m.month}</Text>
                  <Text style={month.bookings}>{m.bookingCount} booking{m.bookingCount !== 1 ? 's' : ''}</Text>
                  <Text style={month.amount}>${m.totalUsd.toFixed(0)}</Text>
                </View>
              ))}
            </TravelCard>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: color.ink, flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.xl,
  },
  headerTitle: { ...t.heading, color: color.onInk },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space.lg, marginTop: space.xl, gap: space.sm },
  cardList: { paddingHorizontal: space.lg, gap: space.sm, marginBottom: space.sm },
});

const stat = StyleSheet.create({
  wrap: {
    flex: 1, minWidth: '46%', backgroundColor: color.paperRaised,
    borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.haze, ...shadow.card,
    alignItems: 'flex-start',
  },
  label: { fontFamily: 'Courier', fontSize: 9, color: color.mute, letterSpacing: 1, marginBottom: 4 },
  value: { ...t.heading, color: color.ink, fontSize: 22 },
  sub: { ...t.small, color: color.haze, marginTop: 2 },
});

const banner = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    backgroundColor: '#FFF8ED', borderRadius: radius.md,
    padding: space.md, borderWidth: 1, borderColor: '#F5D090',
  },
  text: { ...t.small, color: color.warn, lineHeight: 18, flex: 1 },
});

const bk = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  date: { ...t.bodyStrong, color: color.ink },
  meta: { ...t.small, color: color.mute, marginTop: 2 },
  amount: { ...t.bodyStrong, color: color.ink },
  status: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginTop: 2 },
  breakdown: {
    marginTop: space.sm, paddingTop: space.sm,
    borderTopWidth: 1, borderTopColor: color.haze, gap: 4,
  },
  breakRow: { flexDirection: 'row', justifyContent: 'space-between' },
  breakLabel: { ...t.small, color: color.mute },
  breakVal: { ...t.small, color: color.ink },
});

const chip = StyleSheet.create({
  base: {
    paddingHorizontal: space.md, paddingVertical: space.xs,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  active: { backgroundColor: color.ink, borderColor: color.ink },
  text: { ...t.small, color: color.ink, fontWeight: '600' },
  textActive: { color: color.onInk },
});

const month = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  divider: { borderBottomWidth: 1, borderBottomColor: color.haze },
  label: { ...t.bodyStrong, color: color.ink, flex: 1 },
  bookings: { ...t.small, color: color.mute, marginRight: space.lg },
  amount: { ...t.bodyStrong, color: color.success },
});

const disp = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: space.md, paddingTop: space.sm,
    borderTopWidth: 1, borderTopColor: color.haze,
  },
  btnText: { ...t.small, color: color.signal, fontWeight: '700' },
});
