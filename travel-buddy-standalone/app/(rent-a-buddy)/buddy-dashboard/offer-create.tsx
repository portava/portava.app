import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import { ArrowLeft, Send, DollarSign } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelChip, TravelLoadingState } from '../../../src/components/primitives';
import {
  submitOffer, getRequest, getPricingSuggestion,
  getMyBuddyProfile, type BuddyRequest, type PricingSuggestion, bookingErrorCopy
} from '../../../src/services/rentABuddy';

const EXPIRY_OPTIONS = [
  { label: '6 hours', value: 6 },
  { label: '12 hours', value: 12 },
  { label: '24 hours', value: 24 },
];

const PAYMENT_MODES = [
  { label: 'Full in-app', value: 'full_in_app' },
  { label: 'Deposit + cash', value: 'deposit_plus_cash' },
];

export default function OfferCreate() {
  const insets = useSafeAreaInsets();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const [request, setRequest] = useState<BuddyRequest | null>(null);
  const [priceSuggestion, setPriceSuggestion] = useState<PricingSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [proposedPriceUsd, setProposedPriceUsd] = useState('');
  const [depositAmountUsd, setDepositAmountUsd] = useState('');
  const [meetupLocation, setMeetupLocation] = useState('');
  const [message, setMessage] = useState('');
  const [includedServices, setIncludedServices] = useState('');
  const [paymentMode, setPaymentMode] = useState<'full_in_app' | 'deposit_plus_cash'>('full_in_app');
  const [expiresInHours, setExpiresInHours] = useState(12);
  const submitLockRef = useRef(false);

  useEffect(() => {
    async function init() {
      if (!requestId) { setLoading(false); return; }
      const [reqRes, profileRes] = await Promise.all([
        getRequest(requestId),
        getMyBuddyProfile(),
      ]);
      setLoading(false);
      if (!reqRes.ok) return;
      const req = reqRes.data.request;
      setRequest(req);

      const buddyLevel = profileRes.ok ? (profileRes.data.profile?.buddyLevel ?? 'new') : 'new';
      const suggRes = await getPricingSuggestion({
        city: req.city,
        category: req.category,
        durationMinutes: req.durationMinutes,
        buddyLevel,
        groupSize: req.groupSize,
      });
      if (suggRes.ok) setPriceSuggestion(suggRes.data);
    }
    init();
  }, [requestId]);

  const submit = useCallback(async () => {
    if (submitLockRef.current) return;
    if (!requestId || !proposedPriceUsd) {
      Alert.alert('Missing info', 'Please enter a proposed price.');
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const result = await submitOffer(requestId, {
        proposedPriceUsd: Number(proposedPriceUsd),
        depositAmountUsd: paymentMode === 'deposit_plus_cash' ? Number(depositAmountUsd) || 0 : undefined,
        cashBalanceDue: paymentMode === 'deposit_plus_cash'
          ? Math.max(0, Number(proposedPriceUsd) - Number(depositAmountUsd || 0))
          : 0,
        meetupLocation: meetupLocation.trim() || undefined,
        message: message.trim() || undefined,
        includedServices: includedServices.trim() ? includedServices.split(',').map((sv) => sv.trim()) : [],
        paymentMode,
        expiresInHours,
      });
      if (!result.ok) { Alert.alert('Error', bookingErrorCopy(result.error)); return; }
      Alert.alert('Offer Sent!', 'The traveler will be notified of your offer.', [
        { text: 'Back to Inbox', onPress: () => router.back() },
      ]);
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }, [requestId, proposedPriceUsd, depositAmountUsd, meetupLocation, message, includedServices, paymentMode, expiresInHours]);

  if (loading) return <TravelLoadingState label="Loading request…" />;

  const cashDue = paymentMode === 'deposit_plus_cash'
    ? Math.max(0, Number(proposedPriceUsd || 0) - Number(depositAmountUsd || 0))
    : 0;

  return (
    <KeyboardSafeScrollView style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Create Offer</Text>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {request ? (
          <View style={s.requestSummary}>
            <Text style={s.requestTitle}>{request.city} · {request.category} · {request.durationMinutes / 60}h</Text>
            {request.notes ? <Text style={s.requestNote}>"{request.notes}"</Text> : null}
          </View>
        ) : null}

        {priceSuggestion ? (
          <View style={s.suggestionBanner}>
            <DollarSign size={14} color={color.deep} />
            <Text style={s.suggestionText}>{priceSuggestion.label}</Text>
          </View>
        ) : null}

        <Text style={s.label}>Your price (total) *</Text>
        <View style={s.inputRow}>
          <Text style={s.currencySign}>$</Text>
          <TextInput
            style={[s.input, s.inputFlex]}
            placeholder="e.g. 80"
            placeholderTextColor={color.mute}
            keyboardType="decimal-pad"
            value={proposedPriceUsd}
            onChangeText={setProposedPriceUsd}
          />
        </View>

        <Text style={s.label}>Payment mode</Text>
        <View style={s.chips}>
          {PAYMENT_MODES.map((pm) => (
            <TravelChip
              key={pm.value}
              label={pm.label}
              active={paymentMode === pm.value}
              onPress={() => setPaymentMode(pm.value as 'full_in_app' | 'deposit_plus_cash')}
            />
          ))}
        </View>

        {paymentMode === 'deposit_plus_cash' ? (
          <>
            <Text style={s.label}>Deposit amount</Text>
            <View style={s.inputRow}>
              <Text style={s.currencySign}>$</Text>
              <TextInput
                style={[s.input, s.inputFlex]}
                placeholder="e.g. 20"
                placeholderTextColor={color.mute}
                keyboardType="decimal-pad"
                value={depositAmountUsd}
                onChangeText={setDepositAmountUsd}
              />
            </View>
            {cashDue > 0 ? (
              <Text style={s.calcNote}>Cash balance due at meetup: ${cashDue.toFixed(2)}</Text>
            ) : null}
          </>
        ) : null}

        <Text style={s.label}>Meetup location</Text>
        <TextInput
          style={s.input}
          placeholder="Suggest a public meeting point…"
          placeholderTextColor={color.mute}
          value={meetupLocation}
          onChangeText={setMeetupLocation}
        />

        <Text style={s.label}>Message to traveler</Text>
        <TextInput
          style={[s.input, s.textarea]}
          placeholder="Introduce yourself, describe your plan…"
          placeholderTextColor={color.mute}
          value={message}
          onChangeText={setMessage}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        <Text style={s.label}>Included services (comma-separated)</Text>
        <TextInput
          style={s.input}
          placeholder="e.g. City tour, translation, dinner recs"
          placeholderTextColor={color.mute}
          value={includedServices}
          onChangeText={setIncludedServices}
        />

        <Text style={s.label}>Offer expires in</Text>
        <View style={s.chips}>
          {EXPIRY_OPTIONS.map((opt) => (
            <TravelChip
              key={opt.value}
              label={opt.label}
              active={expiresInHours === opt.value}
              onPress={() => setExpiresInHours(opt.value)}
            />
          ))}
        </View>

        <Pressable
          style={[s.submitBtn, (submitting || !proposedPriceUsd) && s.submitBtnDisabled]}
          onPress={submit}
          disabled={submitting || !proposedPriceUsd}
        >
          <Send size={16} color="#fff" />
          <Text style={s.submitBtnLabel}>{submitting ? 'Sending…' : 'Send Offer'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardSafeScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink },
  body: { flex: 1 },
  content: { padding: space.lg, paddingBottom: 60 },
  requestSummary: { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, marginBottom: space.lg },
  requestTitle: { ...t.body, color: color.ink, fontWeight: '600' },
  requestNote: { ...t.small, color: color.mute, fontStyle: 'italic', marginTop: space.xs },
  suggestionBanner: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: `${color.deep}10`, borderRadius: radius.sm, padding: space.md, marginBottom: space.lg },
  suggestionText: { ...t.small, color: color.deep },
  label: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.sm, marginTop: space.lg },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: color.haze, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  currencySign: { ...t.body, color: color.mute, paddingHorizontal: space.md },
  input: { ...t.body, color: color.ink, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze },
  inputFlex: { flex: 1, borderWidth: 0, borderRadius: 0 },
  textarea: { minHeight: 70 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  calcNote: { ...t.small, color: color.mute, marginTop: space.sm },
  submitBtn: { marginTop: space.xl, backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnLabel: { ...t.body, color: '#fff', fontWeight: '700' },
});
