/**
 * Buddy — My offers (testing mode, lane tm-rab, WP-01 / PLAT-F50).
 *
 * A buddy could send offers on travellers' requests but never see them again
 * or take one back: getMyOffers and withdrawOffer had no caller. This lists the
 * buddy's own offers (GET /rent-a-buddy/me/offers, newest 50) and lets them
 * withdraw a PENDING one. The server withdraws compare-and-set on `pending`, so
 * an offer the traveller has already accepted (a booking exists) answers 409
 * and is not withdrawn; the screen says so and reloads.
 *
 * States: loading · error with retry · a gate refusal as its own state · a
 * true empty.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert, RefreshControl, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Undo2, ChevronRight } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../../src/components/primitives';
import { getMyOffers, withdrawOffer, bookingErrorCopy, type BuddyOffer } from '../../../src/services/rentABuddy';
import { describeGateRefusal, type GateRefusal } from '../../../src/services/rentABuddyGates';
import { RabGateRefusalState } from '../../../src/components/rentabuddy/RabGateRefusalState';

const OFFER_STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for the traveller',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
};

function when(iso: string | null): string {
  if (!iso) return 'Time to be agreed';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function MyOffers() {
  const insets = useSafeAreaInsets();
  const [offers, setOffers] = useState<BuddyOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<GateRefusal | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null); setGate(null);
    const res = await getMyOffers();
    if (!silent) setLoading(false);
    if (res.ok) { setOffers(res.data.offers ?? []); return; }
    const g = describeGateRefusal(res.error, res.gate);
    if (g) { setGate(g); return; }
    setError(bookingErrorCopy(res.error, "Couldn't load your offers."));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const doWithdraw = useCallback(async (offer: BuddyOffer) => {
    if (lock.current) return;
    lock.current = true;
    setActing(offer.id);
    try {
      const res = await withdrawOffer(offer.id);
      if (res.ok) {
        Alert.alert('Offer withdrawn', 'The traveller can no longer accept it.');
        await load(true);
        return;
      }
      const g = describeGateRefusal(res.error, res.gate);
      if (g) { setGate(g); return; }
      if (res.error === 'invalid_transition') {
        Alert.alert('Already answered', 'The traveller has already answered this offer, so it can no longer be withdrawn.');
        await load(true);
        return;
      }
      Alert.alert("Couldn't withdraw", bookingErrorCopy(res.error, 'Please try again.'));
    } finally {
      lock.current = false;
      setActing(null);
    }
  }, [load]);

  const header = (
    <View style={[s.header, { paddingTop: insets.top + space.md }]}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/buddy-dashboard' as any))} hitSlop={10}>
        <ArrowLeft size={20} color={color.onInk} />
      </Pressable>
      <Text style={s.headerTitle}>My offers</Text>
    </View>
  );

  let body: React.ReactNode;
  if (loading) body = <TravelLoadingState label="Loading your offers…" />;
  else if (gate) body = <RabGateRefusalState refusal={gate} onRetry={() => { void load(); }} testID="offers-gate" />;
  else if (error) body = <TravelErrorState title="Couldn't load your offers" sub={error} onRetry={() => { void load(); }} />;
  else {
    body = (
      <FlatList
        data={offers}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <TravelEmptyState
            title="No offers yet"
            sub="Offers you send on travellers' requests appear here."
            action="See open requests"
            onAction={() => router.push('/(rent-a-buddy)/buddy-dashboard/requests-inbox' as any)}
          />
        }
        renderItem={({ item }) => (
          <View style={s.card} testID={`offer-${item.id}`}>
            <View style={s.row}>
              <Text style={s.price}>${item.proposedPriceUsd.toFixed(2)}</Text>
              <Text style={[s.status, item.status === 'pending' && { color: color.warn }]}>
                {OFFER_STATUS_LABEL[item.status] ?? item.status}
              </Text>
            </View>
            <Text style={s.meta}>{when(item.proposedStart)}{item.meetupLocation ? ` · ${item.meetupLocation}` : ''}</Text>
            {item.message ? <Text style={s.message} numberOfLines={3}>{item.message}</Text> : null}
            <Text style={s.note}>No payment goes through the app — you and the traveller settle it directly.</Text>
            {item.status === 'pending' ? (
              <Pressable
                style={({ pressed }) => [s.withdraw, pressed && { opacity: layout.pressedOpacity }]}
                disabled={acting !== null}
                testID={`offer-withdraw-${item.id}`}
                onPress={() => Alert.alert('Withdraw this offer?', 'The traveller will no longer be able to accept it.', [
                  { text: 'Keep it', style: 'cancel' },
                  { text: 'Withdraw', style: 'destructive', onPress: () => { void doWithdraw(item); } },
                ])}
              >
                {acting === item.id ? <ActivityIndicator color={color.signal} /> : <Undo2 size={15} color={color.signal} />}
                <Text style={s.withdrawText}>Withdraw offer</Text>
              </Pressable>
            ) : null}
            {item.status === 'accepted' && item.acceptedBookingId ? (
              <Pressable
                style={s.row}
                onPress={() => router.push({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: item.acceptedBookingId } })}
              >
                <Text style={s.link}>Open the booking</Text>
                <ChevronRight size={14} color={color.signal} />
              </Pressable>
            ) : null}
          </View>
        )}
      />
    );
  }

  return (
    <View style={s.wrap}>
      {header}
      {body}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.md, backgroundColor: color.ink },
  headerTitle: { ...t.heading, color: color.onInk },
  card: { gap: space.xs, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  price: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  status: { ...t.small, color: color.mute, fontWeight: '700' },
  meta: { ...t.small, color: color.mute },
  message: { ...t.body, color: color.ink },
  note: { ...t.small, color: color.faint },
  withdraw: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, marginTop: space.xs, borderWidth: 1, borderColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm },
  withdrawText: { ...t.bodyStrong, color: color.signal },
  link: { ...t.small, color: color.signal, fontWeight: '700' },
});
