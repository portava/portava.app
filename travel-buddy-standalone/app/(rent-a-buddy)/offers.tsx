import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  RefreshControl, Alert, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Check, X, Clock, DollarSign, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../src/components/primitives';
import {
  getRequestOffers, acceptOffer, declineOffer,
  isBookingUnavailable, bookingErrorCopy,
  type BuddyOffer, getRequest, type BuddyRequest,
} from '../../src/services/rentABuddy';

function OfferCard({ offer, onAccept, onDecline, accepting }: {
  offer: BuddyOffer;
  onAccept: () => void;
  onDecline: () => void;
  accepting: boolean;
}) {
  const isActive = offer.status === 'pending';
  const isExpired = offer.expiresAt ? new Date(offer.expiresAt) < new Date() : false;

  const statusColors: Record<string, string> = {
    pending: color.warn,
    accepted: color.success,
    declined: color.signal,
    expired: color.mute,
    withdrawn: color.mute,
  };

  return (
    <View style={[card.wrap, !isActive && card.inactive]}>
      <View style={card.header}>
        <View style={card.buddyInfo}>
          <Text style={card.buddyName}>{offer.buddy?.displayName ?? 'Buddy'}</Text>
          {offer.buddy?.verified && (
            <View style={card.verifiedBadge}>
              <Text style={card.verifiedText}>Verified</Text>
            </View>
          )}
          {offer.buddy?.averageRating != null && (
            <Text style={card.rating}>⭐ {offer.buddy.averageRating.toFixed(1)}</Text>
          )}
        </View>
        <Text style={[card.status, { color: statusColors[offer.status] ?? color.mute }]}>
          {offer.status.toUpperCase()}
        </Text>
      </View>

      <View style={card.priceRow}>
        <DollarSign size={16} color={color.deep} />
        <Text style={card.price}>${offer.proposedPriceUsd.toFixed(2)}</Text>
        <Text style={card.priceSub}>
          {offer.depositAmountUsd > 0
            ? ` · $${offer.depositAmountUsd.toFixed(2)} deposit`
            : ' · Full in-app'}
          {offer.cashBalanceUsd > 0 ? ` + $${offer.cashBalanceUsd.toFixed(2)} cash` : ''}
        </Text>
      </View>

      {offer.meetupLocation ? (
        <View style={card.locationRow}>
          <MapPin size={14} color={color.mute} />
          <Text style={card.locationText}>{offer.meetupLocation}</Text>
        </View>
      ) : null}

      {offer.message ? <Text style={card.message}>"{offer.message}"</Text> : null}

      {offer.includedServices.length > 0 && (
        <Text style={card.services}>Includes: {offer.includedServices.join(', ')}</Text>
      )}

      {offer.expiresAt && isActive && !isExpired ? (
        <View style={card.expiryRow}>
          <Clock size={12} color={color.warn} />
          <Text style={card.expiryText}>Expires {new Date(offer.expiresAt).toLocaleString()}</Text>
        </View>
      ) : null}

      {isActive && !isExpired ? (
        <View style={card.actions}>
          <Pressable style={[card.btn, card.declineBtn]} onPress={onDecline} disabled={accepting}>
            <X size={16} color={color.signal} />
            <Text style={[card.btnLabel, { color: color.signal }]}>Decline</Text>
          </Pressable>
          <Pressable style={[card.btn, card.acceptBtn]} onPress={onAccept} disabled={accepting}>
            {accepting
              ? <ActivityIndicator size="small" color="#fff" />
              : (
                <>
                  <Check size={16} color="#fff" />
                  <Text style={[card.btnLabel, { color: '#fff' }]}>Accept</Text>
                </>
              )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default function Offers() {
  const insets = useSafeAreaInsets();
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();
  const [request, setRequest] = useState<BuddyRequest | null>(null);
  const [offers, setOffers] = useState<BuddyOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!requestId) { setError('No request ID'); setLoading(false); return; }
    if (!silent) setLoading(true);
    setError(null);

    const [reqRes, offersRes] = await Promise.all([
      getRequest(requestId),
      getRequestOffers(requestId),
    ]);

    if (!silent) setLoading(false);
    setRefreshing(false);

    if (!reqRes.ok) { setError(reqRes.error); return; }
    if (!offersRes.ok) { setError(offersRes.error); return; }

    setRequest(reqRes.data.request);
    setOffers(offersRes.data.offers);
  }, [requestId]);

  useEffect(() => { load(); }, [load]);

  const handleAccept = useCallback(async (offer: BuddyOffer) => {
    Alert.alert(
      'Accept Offer',
      `Accept offer from ${offer.buddy?.displayName ?? 'this Buddy'} for $${offer.proposedPriceUsd.toFixed(2)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept',
          onPress: async () => {
            setAcceptingId(offer.id);
            const res = await acceptOffer(offer.id);
            setAcceptingId(null);
            if (!res.ok) {
              // Accepting an offer creates a booking, so it passes the same
              // server-side KYC gate as checkout and can answer 503
              // verification_unavailable. An Alert is fine here — unlike
              // checkout there is no long form behind it — but the copy must
              // never be the raw code.
              Alert.alert(
                isBookingUnavailable(res.error) ? 'Not available yet' : 'Error',
                bookingErrorCopy(res.error),
              );
              return;
            }
            Alert.alert('Booking Created!', 'Your booking is confirmed.', [
              { text: 'OK', onPress: () => router.back() },
            ]);
          },
        },
      ]
    );
  }, []);

  const handleDecline = useCallback(async (offer: BuddyOffer) => {
    const res = await declineOffer(offer.id);
    // Declining is not KYC-gated, but a raw code must not reach a user here
    // either.
    if (!res.ok) { Alert.alert('Error', bookingErrorCopy(res.error)); return; }
    load(true);
  }, [load]);

  if (loading) return <TravelLoadingState label="Loading offers…" />;
  if (error) return <TravelErrorState title="Failed to load offers" sub={error} onRetry={() => load()} />;

  const pendingCount = offers.filter((o) => o.status === 'pending').length;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Buddy Offers</Text>
          {request && (
            <Text style={s.sub}>{request.city} · {request.category} · {request.durationMinutes / 60}h</Text>
          )}
        </View>
        {pendingCount > 0 && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{pendingCount} pending</Text>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + space.xxxl }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
      >
        {offers.length === 0 ? (
          <TravelEmptyState
            title="No offers yet"
            sub="Eligible Buddies will see your request and can send you offers soon."
          />
        ) : null}
        {offers.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            onAccept={() => handleAccept(offer)}
            onDecline={() => handleDecline(offer)}
            accepting={acceptingId === offer.id}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink },
  sub: { ...t.small, color: color.mute },
  badge: { backgroundColor: color.warn, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { ...t.small, color: '#fff', fontWeight: '700' },
  content: { padding: space.lg, gap: space.md },
});

const card = StyleSheet.create({
  wrap: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.haze, padding: space.lg, marginBottom: space.md },
  inactive: { opacity: 0.6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  buddyInfo: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  buddyName: { ...t.body, color: color.ink, fontWeight: '700' },
  verifiedBadge: { backgroundColor: `${color.deep}15`, borderRadius: 20, paddingHorizontal: 6, paddingVertical: 2 },
  verifiedText: { ...t.small, color: color.deep, fontWeight: '600' },
  rating: { ...t.small, color: color.mute },
  status: { ...t.small, fontWeight: '700' },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.sm },
  price: { ...t.bodyStrong, color: color.ink },
  priceSub: { ...t.small, color: color.mute },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  locationText: { ...t.small, color: color.mute },
  message: { ...t.body, color: color.mute, fontStyle: 'italic', marginBottom: space.sm },
  services: { ...t.small, color: color.mute, marginBottom: space.sm },
  expiryRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.md },
  expiryText: { ...t.small, color: color.warn },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1.5 },
  declineBtn: { borderColor: `${color.signal}40`, backgroundColor: `${color.signal}08` },
  acceptBtn: { borderColor: color.deep, backgroundColor: color.deep },
  btnLabel: { ...t.body, fontWeight: '700' },
});
