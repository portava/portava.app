import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, Pressable, Alert,
  TextInput, Modal, RefreshControl, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Star, X, Check, Edit2, AlertCircle } from 'lucide-react-native';
import {
  TravelButton, TravelCard, TravelLoadingState,
  TravelErrorState, TravelEmptyState,
} from '../../../src/components/primitives';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyBooking } from '../../../src/services/rentABuddy';

const DECLINE_REASONS = [
  'Unavailable on this date',
  'Category not a match',
  'Location too far',
  'Group size too large',
  'Not enough notice',
  'Other',
];

// ── Decline sheet ─────────────────────────────────────────────────────────────

function DeclineSheet({
  visible, onClose, onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [custom, setCustom] = useState('');
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[modal.wrap, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={modal.header}>
          <Text style={modal.title}>Decline booking</Text>
          <Pressable onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={modal.sub}>Help us improve by sharing why you're declining.</Text>
          {DECLINE_REASONS.map((r) => (
            <Pressable
              key={r}
              style={modal.option}
              onPress={() => setReason(r)}
            >
              <View style={[modal.radio, reason === r && modal.radioOn]}>
                {reason === r && <View style={modal.radioDot} />}
              </View>
              <Text style={[modal.optionText, reason === r && modal.optionActive]}>{r}</Text>
            </Pressable>
          ))}
          {reason === 'Other' && (
            <TextInput
              style={modal.input}
              value={custom}
              onChangeText={setCustom}
              placeholder="Tell us more (optional)…"
              placeholderTextColor={color.haze}
              multiline
            />
          )}
          <TravelButton
            label={reason ? 'Decline request' : 'Select a reason'}
            variant={reason ? 'secondary' : 'ghost'}
            full
            onPress={() => {
              if (!reason) return;
              onConfirm(reason === 'Other' ? (custom || reason) : reason);
            }}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Suggest changes sheet ─────────────────────────────────────────────────────

function SuggestSheet({
  booking,
  onClose,
  onConfirm,
}: {
  booking: BuddyBooking;
  onClose: () => void;
  onConfirm: (payload: {
    proposedDate?: string;
    proposedTime?: string;
    proposedDurationH?: number;
    proposedLocation?: string;
    message?: string;
  }) => void;
}) {
  const [date, setDate] = useState(booking.bookingDate.slice(0, 10));
  const [time, setTime] = useState(booking.startTime ?? '');
  const [duration, setDuration] = useState(String(booking.durationH));
  const [location, setLocation] = useState(booking.city);
  const [message, setMessage] = useState('');
  const insets = useSafeAreaInsets();

  function canSend() {
    return date.trim().length > 0;
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[modal.wrap, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={modal.header}>
          <Text style={modal.title}>Suggest changes</Text>
          <Pressable onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Text style={modal.sub}>Propose alternative details. The traveller can accept or decline your suggestion.</Text>

          <Text style={modal.fieldLabel}>Proposed date</Text>
          <TextInput
            style={[modal.input, { marginBottom: space.lg }]}
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={color.haze}
          />

          <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
            <View style={{ flex: 1 }}>
              <Text style={modal.fieldLabel}>Start time</Text>
              <TextInput
                style={modal.input}
                value={time}
                onChangeText={setTime}
                placeholder="e.g. 14:00"
                placeholderTextColor={color.haze}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={modal.fieldLabel}>Duration (hours)</Text>
              <TextInput
                style={modal.input}
                value={duration}
                onChangeText={setDuration}
                placeholder="e.g. 3"
                placeholderTextColor={color.haze}
                keyboardType="numeric"
              />
            </View>
          </View>

          <Text style={modal.fieldLabel}>Meetup location</Text>
          <TextInput
            style={[modal.input, { marginBottom: space.lg }]}
            value={location}
            onChangeText={setLocation}
            placeholder="City or specific spot"
            placeholderTextColor={color.haze}
          />

          <Text style={modal.fieldLabel}>Message to traveller</Text>
          <TextInput
            style={[modal.input, modal.multiline, { marginBottom: space.lg }]}
            value={message}
            onChangeText={setMessage}
            placeholder="Explain the suggested change…"
            placeholderTextColor={color.haze}
            multiline
          />

          <TravelButton
            label={canSend() ? 'Send suggestion' : 'Enter a date to continue'}
            variant={canSend() ? 'primary' : 'ghost'}
            full
            onPress={() => {
              if (!canSend()) return;
              onConfirm({
                proposedDate: date,
                proposedTime: time || undefined,
                proposedDurationH: parseFloat(duration) || undefined,
                proposedLocation: location || undefined,
                message: message || undefined,
              });
            }}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Request card ──────────────────────────────────────────────────────────────

function RequestCard({
  booking,
  onAccept,
  onDecline,
  onSuggest,
}: {
  booking: BuddyBooking;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onSuggest: (booking: BuddyBooking) => void;
}) {
  const dateStr = new Date(booking.bookingDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });

  const isCashPayment = false;
  const cashBalanceDue = 0;

  return (
    <TravelCard style={{ padding: space.lg }}>
      {/* Traveller row */}
      <View style={rc.topRow}>
        <View style={rc.avatar}>
          <Text style={rc.avatarText}>{booking.travelerId.slice(0, 2).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={rc.travelerName}>Traveller</Text>
          <View style={rc.trustRow}>
            <Star size={12} color={color.warn} fill={color.warn} />
            <Text style={rc.trustScore}>Trust Score visible after approval</Text>
          </View>
        </View>
        <View style={[rc.pill, { backgroundColor: '#EEF6FF' }]}>
          <Text style={[rc.pillText, { color: color.deep }]}>{booking.category.toUpperCase()}</Text>
        </View>
      </View>

      {/* Details grid */}
      <View style={rc.details}>
        {[
          { label: 'Date', value: dateStr },
          { label: 'Duration', value: `${booking.durationH}h` },
          { label: 'Group size', value: `${booking.groupSize} ${booking.groupSize === 1 ? 'person' : 'people'}` },
          { label: 'Location', value: booking.city },
          ...(booking.startTime ? [{ label: 'Start time', value: booking.startTime }] : []),
        ].map(({ label, value }) => (
          <View key={label} style={rc.detailRow}>
            <Text style={rc.detailLabel}>{label}</Text>
            <Text style={rc.detailValue}>{value}</Text>
          </View>
        ))}
      </View>

      {/* Cash balance callout */}
      {cashBalanceDue > 0 && (
        <View style={rc.cashBanner}>
          <AlertCircle size={14} color={color.warn} />
          <Text style={rc.cashText}>
            Cash balance due: ${cashBalanceDue.toFixed(2)} — collect in person
          </Text>
        </View>
      )}

      {/* Safety preferences summary */}
      <View style={rc.safetyRow}>
        <AlertCircle size={12} color={color.deep} />
        <Text style={rc.safetyText}>Non-dating policy applies · Traveller has read safety guidelines</Text>
      </View>

      {/* Earnings estimate */}
      <View style={rc.totalRow}>
        <Text style={rc.totalLabel}>You earn (estimated)</Text>
        <Text style={rc.totalValue}>${(booking.totalUsd * 0.9).toFixed(2)}</Text>
      </View>

      {/* Traveller notes */}
      {booking.notes ? (
        <View style={rc.notesWrap}>
          <Text style={rc.notesLabel}>TRAVELLER NOTES</Text>
          <Text style={rc.notesBody}>{booking.notes}</Text>
        </View>
      ) : null}

      {/* Actions */}
      <View style={rc.actions}>
        <TravelButton
          label="Decline"
          variant="secondary"
          onPress={() => onDecline(booking.id)}
          full
        />
        <TravelButton
          label="Suggest changes"
          variant="ghost"
          onPress={() => onSuggest(booking)}
          full
          icon={<Edit2 size={13} color={color.ink} />}
        />
        <TravelButton
          label="Accept"
          variant="primary"
          onPress={() => onAccept(booking.id)}
          full
          icon={<Check size={14} color={color.onInk} />}
        />
      </View>
    </TravelCard>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function BuddyRequests() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<BuddyBooking[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [declineId, setDeclineId] = useState<string | null>(null);
  const [suggestBooking, setSuggestBooking] = useState<BuddyBooking | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await rentABuddy.getDashboardRequests();
    if (!silent) setLoading(false);
    if (res.ok) {
      setRequests(res.data.requests.filter((r) => r.status === 'pending'));
    } else {
      setError(res.error);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const handleAccept = useCallback(async (id: string) => {
    setActing(id);
    const res = await rentABuddy.acceptBooking(id);
    setActing(null);
    if (!res.ok) {
      Alert.alert('Error', res.error ?? 'Could not accept booking.');
      return;
    }
    setRequests((prev) => prev.filter((r) => r.id !== id));
    Alert.alert('Booking accepted!', 'The traveller has been notified. Check upcoming bookings in your dashboard.');
  }, []);

  const handleDecline = useCallback(async (reason: string) => {
    if (!declineId) return;
    const id = declineId;
    setDeclineId(null);
    setActing(id);
    const res = await rentABuddy.declineBooking(id);
    setActing(null);
    if (!res.ok) {
      Alert.alert('Error', res.error ?? 'Could not decline booking.');
      return;
    }
    setRequests((prev) => prev.filter((r) => r.id !== id));
  }, [declineId]);

  const handleSuggest = useCallback(async (payload: {
    proposedDate?: string;
    proposedTime?: string;
    proposedDurationH?: number;
    proposedLocation?: string;
    message?: string;
  }) => {
    if (!suggestBooking) return;
    const id = suggestBooking.id;
    setSuggestBooking(null);
    setActing(id);
    const res = await rentABuddy.suggestChanges(id, payload);
    setActing(null);
    if (!res.ok) {
      Alert.alert('Error', res.error ?? 'Could not send suggestion.');
      return;
    }
    setRequests((prev) => prev.filter((r) => r.id !== id));
    Alert.alert('Suggestion sent', 'The traveller has been notified of your proposed changes.');
  }, [suggestBooking]);

  return (
    <View style={s.wrap}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Booking Requests</Text>
        {requests.length > 0 && (
          <View style={s.countBadge}>
            <Text style={s.countText}>{requests.length}</Text>
          </View>
        )}
      </View>

      {loading ? (
        <TravelLoadingState label="Loading requests…" />
      ) : error ? (
        <TravelErrorState title="Couldn't load requests" sub={error} onRetry={() => load()} />
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <RequestCard
              booking={item}
              onAccept={(id) => acting !== id && handleAccept(id)}
              onDecline={(id) => setDeclineId(id)}
              onSuggest={(bk) => setSuggestBooking(bk)}
            />
          )}
          contentContainerStyle={{
            padding: space.lg,
            paddingBottom: insets.bottom + 48,
            gap: space.md,
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />
          }
          ListEmptyComponent={
            <TravelEmptyState
              title="No pending requests"
              sub="New booking requests from travellers will appear here."
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      <DeclineSheet
        visible={declineId != null}
        onClose={() => setDeclineId(null)}
        onConfirm={handleDecline}
      />
      {suggestBooking && (
        <SuggestSheet
          booking={suggestBooking}
          onClose={() => setSuggestBooking(null)}
          onConfirm={handleSuggest}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper },
  header: {
    backgroundColor: color.ink, flexDirection: 'row',
    alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },
  headerTitle: { ...t.heading, color: color.onInk, flex: 1 },
  countBadge: {
    minWidth: 26, height: 26, borderRadius: 13,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  countText: { fontFamily: 'Courier', fontSize: 12, fontWeight: '700', color: color.onInk },
});

const rc = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { ...t.bodyStrong, color: color.mute },
  travelerName: { ...t.bodyStrong, color: color.ink },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  trustScore: { ...t.small, color: color.mute },
  pill: { paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.pill },
  pillText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  details: { gap: 6, marginBottom: space.md },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between' },
  detailLabel: { ...t.small, color: color.mute },
  detailValue: { ...t.small, fontWeight: '600', color: color.ink },
  cashBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#FFF8ED', borderRadius: radius.sm,
    padding: space.md, marginBottom: space.sm,
    borderWidth: 1, borderColor: '#F5D090',
  },
  cashText: { ...t.small, color: color.warn, fontWeight: '600', flex: 1 },
  safetyRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    marginBottom: space.md,
  },
  safetyText: { ...t.small, color: color.deep, flex: 1 },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.haze, marginBottom: space.md,
  },
  totalLabel: { ...t.bodyStrong, color: color.mute },
  totalValue: { ...t.heading, color: color.success },
  notesWrap: { backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, marginBottom: space.md },
  notesLabel: { fontFamily: 'Courier', fontSize: 9, color: color.haze, letterSpacing: 1, marginBottom: 4 },
  notesBody: { ...t.small, color: color.ink, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: space.xs, marginTop: space.xs, flexWrap: 'wrap' },
});

const modal = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper, padding: space.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.xs },
  title: { ...t.heading, color: color.ink },
  sub: { ...t.body, color: color.mute, marginBottom: space.lg, lineHeight: 22 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  optionText: { ...t.body, color: color.ink },
  optionActive: { color: color.signal, fontWeight: '600' },
  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1.5,
    borderColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: color.signal },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.signal },
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  multiline: { height: 80, textAlignVertical: 'top' },
  fieldLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13, marginBottom: space.xs },
});
