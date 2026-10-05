/**
 * Rent a Buddy — the buddy's earnings ledger (payments PAY-T12; requirement
 * rows PAY-009, PAY-010, PAY-055).
 *
 * Every figure on this screen is one the SERVER folded from the booking's
 * ledger entries. Nothing is added, multiplied or defaulted here: a number is
 * shown as it arrived, or the screen says it could not be loaded.
 *
 * What this screen used to say that was not true, and no longer says:
 *   - "Deposit collected $X". No deposit is taken in this release and no money
 *     is collected through the app; the figure was the sum of a booking term.
 *     The summary now shows what was actually COLLECTED IN THE APP, which is
 *     $0.00 until in-app payment exists, and says so.
 *   - "Fee 22%" on a row whose fee percentage was missing — an invented rate.
 *     A row with no recorded percentage now shows the fee amount alone.
 *
 * States: loading; a failed read (with retry — never zeros); the list; a
 * failed "load more" (its own footer with retry, where the list used to just
 * stop and look complete); and, per row, an estimate vs a reversed booking.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, RefreshControl, FlatList, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, TrendingUp, AlertCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../../src/components/primitives';
import {
  getEarningsSummary, getEarningsLedger,
  type EarningsSummary, type LedgerEntry, type CommissionSource,
} from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

/** Shown while a figure is an estimate and the server sent no sentence of its own. */
const NOT_COLLECTED_NOTICE =
  'All figures are estimates. Nothing has been collected through the app: in-app payment is not live, no deposit is taken, and payouts are not connected.';

const usd = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';

function commissionSourceCopy(source: CommissionSource | undefined): string {
  if (source === 'launch_control') return 'set for your market';
  if (source === 'fee_schedule') return 'from the fee schedule for your level';
  if (source === 'owner_default') return 'the standard rate';
  return '';
}

function SummaryCard({ summary }: { summary: EarningsSummary }) {
  const unledgered = summary.completed.unledgeredCount ?? 0;
  const sourceCopy = commissionSourceCopy(summary.platformFeeSource);
  return (
    <View style={sum.wrap}>
      {summary.isEstimated ? (
        <View style={sum.notice} testID="earnings-estimate-notice">
          <AlertCircle size={13} color={color.warn} />
          <Text style={sum.noticeText}>{summary.warning ?? NOT_COLLECTED_NOTICE}</Text>
        </View>
      ) : null}
      <View style={sum.statsGrid}>
        <View style={sum.stat}>
          <Text style={sum.statVal}>{usd(summary.estimatedBuddyEarningsUsd)}</Text>
          <Text style={sum.statLbl}>Est. Earnings</Text>
        </View>
        <View style={sum.stat}>
          <Text style={sum.statVal}>{usd(summary.estimatedPlatformFeeUsd)}</Text>
          <Text style={sum.statLbl}>Platform Fee</Text>
        </View>
        <View style={sum.stat}>
          <Text style={sum.statVal}>{summary.completed.count}</Text>
          <Text style={sum.statLbl}>Completed</Text>
        </View>
        <View style={sum.stat}>
          <Text style={sum.statVal}>{usd(summary.tips.total)}</Text>
          <Text style={sum.statLbl}>Tips</Text>
        </View>
      </View>
      <View style={sum.row}>
        {/*
          Was a "deposit collected" cell over the API's deprecated alias — a claim
          that the money had been taken, on the one screen where a buddy decides
          whether they have been paid. Nothing is charged (the API reports 0 under
          both names), so the cell shows what WAS collected, from the current field. No
          deposit is taken in this release, so no deposit term is shown here.
        */}
        <View style={sum.col}>
          <Text style={sum.colLbl}>Collected in app</Text>
          <Text style={sum.colVal} testID="earnings-collected-in-app">{usd(summary.completed.inAppAmountCollected)}</Text><Text style={sum.colNote}>In-app payment is not live and no deposit is taken.</Text>
        </View>
        <View style={sum.col}>
          <Text style={sum.colLbl}>Cash balance due</Text>
          <Text style={sum.colVal}>{usd(summary.completed.cashBalanceDue)}</Text>
          <Text style={sum.colNote}>Tracked, not charged by the app.</Text>
        </View>
      </View>
      {typeof summary.platformFeePercent === 'number' ? (
        <Text style={sum.rate} testID="earnings-commission-rate">
          Platform commission on your next booking: {summary.platformFeePercent}% of the service price
          {sourceCopy ? ` (${sourceCopy})` : ''}. Tips carry no commission.
        </Text>
      ) : null}
      {unledgered > 0 ? (
        <View style={sum.notice} testID="earnings-unledgered-notice">
          <AlertCircle size={13} color={color.warn} />
          <Text style={sum.noticeText}>
            {unledgered} completed booking{unledgered !== 1 ? 's are' : ' is'} not yet in your ledger and {unledgered !== 1 ? 'are' : 'is'} not included in the figures above.
          </Text>
        </View>
      ) : null}
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
  const reversed = entry.reversed === true;
  return (
    <View style={row.wrap} testID={`ledger-row-${entry.bookingId}`}>
      <View style={row.header}>
        <Text style={row.type}>{entry.pricingType ?? 'Booking'}</Text>
        <Text style={[row.net, reversed && row.netReversed]}>
          {reversed ? usd(entry.buddyNetEstimatedAmount) : `+${usd(entry.buddyNetEstimatedAmount)}`}
        </Text>
      </View>
      <View style={row.details}>
        {reversed ? (
          <Text style={row.reversed}>Reversed — this booking was cancelled, declined, expired or resolved against you in a dispute, so its service earnings are zero.</Text>
        ) : (
          <Text style={row.detail}>
            Gross {usd(entry.totalBookingUsd)} · Fee{entry.platformFeePercent != null ? ` ${entry.platformFeePercent}%` : ''} = {usd(entry.platformFeeAmount)}
          </Text>
        )}
        {entry.tipUsd > 0 ? <Text style={row.detail}>Tip: +{usd(entry.tipUsd)} (no commission)</Text> : null}
        {/* `depositAmount` (the ledger row's `deposit_amount`: scheduled, never taken) is not shown: no deposit
            is taken in this release. The collected figure is `inAppAmountCollected`, below, which is 0. */}
        {!reversed && entry.cashBalanceDue > 0 ? (
          <Text style={row.detail}>Cash balance due {usd(entry.cashBalanceDue)}</Text>
        ) : null}
        {!reversed ? (
          <Text style={row.detail}>Collected in app {usd(entry.inAppAmountCollected)}</Text>
        ) : null}
        {entry.isEstimated && !reversed ? <Text style={row.estimated}>Estimated — nothing collected or paid out yet</Text> : null}
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
  const [moreError, setMoreError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 20;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoadingData(true);
    setError(null);
    setMoreError(null);
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
    // A failed page is retried from its footer, not by scrolling: otherwise the
    // list re-requests the failing page on every scroll event.
    if (loadingMore || moreError || ledger.length >= total) return;
    setLoadingMore(true);
    const res = await getEarningsLedger(PAGE_SIZE, offset);
    setLoadingMore(false);
    if (!res.ok) { setMoreError(res.error); return; }
    setLedger((prev) => [...prev, ...res.data.ledger]);
    setOffset((o) => o + PAGE_SIZE);
  }, [loadingMore, moreError, ledger.length, total, offset]);

  const retryMore = useCallback(async () => {
    setMoreError(null);
    setLoadingMore(true);
    const res = await getEarningsLedger(PAGE_SIZE, offset);
    setLoadingMore(false);
    if (!res.ok) { setMoreError(res.error); return; }
    setLedger((prev) => [...prev, ...res.data.ledger]);
    setOffset((o) => o + PAGE_SIZE);
  }, [offset]);

  useEffect(() => { load(); }, [load]);

  if (loadingData) return <TravelLoadingState label="Loading earnings…" />;
  if (error) {
    return (
      <TravelErrorState
        title="Couldn't load earnings"
        sub={bookingErrorCopy(error, 'Your earnings could not be loaded — this is not a zero balance. Try again.')}
        onRetry={() => load()}
      />
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back">
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Earnings</Text>
      </View>

      <FlatList
        testID="earnings-ledger-list"
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
          <TravelEmptyState title="No transactions yet" sub="A booking appears here when it is made, as an estimate." />
        }
        ListFooterComponent={
          moreError ? (
            <View style={s.moreError} testID="ledger-more-error">
              <Text style={s.moreErrorText}>
                Couldn't load more — showing {ledger.length} of {total}. The list above is not complete.
              </Text>
              <Pressable style={s.moreRetry} onPress={() => { void retryMore(); }} testID="ledger-more-retry" accessibilityRole="button">
                <Text style={s.moreRetryText}>Try again</Text>
              </Pressable>
            </View>
          ) : loadingMore ? (
            <View style={s.moreLoading}><ActivityIndicator color={color.mute} /></View>
          ) : null
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
  moreError: { margin: space.lg, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, gap: space.sm },
  moreErrorText: { ...t.small, color: color.ink },
  moreRetry: { alignSelf: 'flex-start', paddingVertical: space.xs, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.ink },
  moreRetryText: { ...t.small, color: color.ink, fontWeight: '700' },
  moreLoading: { padding: space.lg, alignItems: 'center' },
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
  colNote: { ...t.small, color: color.mute, marginTop: 2 },
  rate: { ...t.small, color: color.ink },
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
  netReversed: { color: color.mute },
  details: { gap: 2 },
  detail: { ...t.small, color: color.mute },
  estimated: { ...t.small, color: color.warn, fontStyle: 'italic' },
  reversed: { ...t.small, color: color.mute, fontStyle: 'italic' },
  date: { ...t.small, color: color.mute, marginTop: space.xs },
});
