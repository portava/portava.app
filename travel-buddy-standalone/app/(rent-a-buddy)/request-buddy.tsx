/**
 * request-buddy.tsx — dual-mode screen.
 *
 * Mode A (per-buddy booking request): opened with `buddyId` param from a
 * buddy detail screen. Shows service picker, date/time, duration, group size,
 * city/meeting area, notes, and safety acknowledgement. Submits via
 * createBooking() → navigates to booking/[id].
 *
 * Mode B (open marketplace request): opened without `buddyId`. Lets the
 * traveller post an open request that any eligible buddy can respond to.
 * Submits via createRequest() → navigates to the offers screen.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, Switch, Modal,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Send, Calendar, Users, Clock } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../src/theme/tokens';
import { TravelChip } from '../../src/components/primitives';
import { DatePickerField } from '../../src/components/DatePickerField';
import {
  createRequest, createBooking, getBuddyPackages, getBuddyProfile,
  type BuddyCategory, type MarketplacePackage, type BuddyProfile,
} from '../../src/services/rentABuddy';

// ── Safety tutorial modal (first-booking only) ─────────────────────────────

function SafetyModal({ visible, onAcknowledge }: { visible: boolean; onAcknowledge: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={sm.overlay}>
        <View style={sm.sheet}>
          <Text style={sm.title}>Before you book</Text>
          <View style={sm.item}>
            <Text style={sm.bullet}>🚫</Text>
            <Text style={sm.body}>Buddies provide legitimate travel services only. Romantic, adult, or escort requests are not allowed and will result in a permanent ban.</Text>
          </View>
          <View style={sm.item}>
            <Text style={sm.bullet}>💳</Text>
            <Text style={sm.body}>Never pay outside the Travel Buddy app. Off-app payments are not covered by our safety guarantee.</Text>
          </View>
          <View style={sm.item}>
            <Text style={sm.bullet}>🛡️</Text>
            <Text style={sm.body}>Enable Safe Return in your active session so we can check you made it home safely.</Text>
          </View>
          <Pressable style={sm.btn} onPress={onAcknowledge}>
            <Text style={sm.btnText}>I understand — continue</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ── Open-request form (Mode B) ─────────────────────────────────────────────

const OPEN_CATEGORIES = ['city', 'nightlife', 'language', 'arrival', 'content', 'shopping', 'food', 'adventure', 'other'];
const DURATIONS = [{ label: '1h', value: 60 }, { label: '2h', value: 120 }, { label: '3h', value: 180 }, { label: 'Half day', value: 240 }, { label: 'Full day', value: 480 }];
const BUDGET_OPTS = [{ label: 'Under $20/hr', min: 0, max: 20 }, { label: '$20–$40/hr', min: 20, max: 40 }, { label: '$40–$70/hr', min: 40, max: 70 }, { label: 'Open budget', min: null, max: null }];
const POLICY_TEXT = "Requests must be for legitimate travel services only. Escort, adult, romantic, or illegal service requests are not permitted.";

function OpenRequestForm() {
  const insets = useSafeAreaInsets();
  const [city, setCity]                   = useState('');
  const [category, setCategory]           = useState('city');
  const [durationMinutes, setDurationMinutes] = useState(120);
  const [budgetIdx, setBudgetIdx]         = useState(1);
  const [language, setLanguage]           = useState('');
  const [groupSize, setGroupSize]         = useState(1);
  const [notes, setNotes]                 = useState('');
  const [publicOnly, setPublicOnly]       = useState(false);
  const [loading, setLoading]             = useState(false);

  const budget = BUDGET_OPTS[budgetIdx];

  const submit = useCallback(async () => {
    if (!city.trim()) { Alert.alert('Missing city', 'Please enter the city for your request.'); return; }
    setLoading(true);
    const result = await createRequest({
      city: city.trim(), category, durationMinutes, groupSize,
      budgetMinUsd: budget.min ?? undefined,
      budgetMaxUsd: budget.max ?? undefined,
      languageNeeded: language.trim() || undefined,
      safetyPrefs: { publicOnly },
      notes: notes.trim() || undefined,
    });
    setLoading(false);
    if (!result.ok) { Alert.alert('Error', result.error); return; }
    Alert.alert(
      'Request Posted!',
      'Eligible Buddies in your city will see your request and can send you offers.',
      [{ text: 'View Offers', onPress: () => router.replace({ pathname: '/(rent-a-buddy)/offers', params: { requestId: result.data.request.id } } as any) }]
    );
  }, [city, category, durationMinutes, groupSize, budget, language, publicOnly, notes]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Request a Buddy</Text>
      </View>
      <ScrollView style={s.body} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.notice}>{POLICY_TEXT}</Text>

        <Text style={s.label}>City *</Text>
        <TextInput style={s.input} placeholder="e.g. Tokyo, Barcelona…" placeholderTextColor={color.mute} value={city} onChangeText={setCity} />

        <Text style={s.label}>Category *</Text>
        <View style={s.chips}>
          {OPEN_CATEGORIES.map((cat) => (
            <TravelChip key={cat} label={cat.charAt(0).toUpperCase() + cat.slice(1)} active={category === cat} onPress={() => setCategory(cat)} />
          ))}
        </View>

        <Text style={s.label}>Duration</Text>
        <View style={s.chips}>
          {DURATIONS.map((d) => (
            <TravelChip key={d.value} label={d.label} active={durationMinutes === d.value} onPress={() => setDurationMinutes(d.value)} />
          ))}
        </View>

        <Text style={s.label}>Budget</Text>
        <View style={s.chips}>
          {BUDGET_OPTS.map((b, i) => (
            <TravelChip key={i} label={b.label} active={budgetIdx === i} onPress={() => setBudgetIdx(i)} />
          ))}
        </View>

        <Text style={s.label}>Group size</Text>
        <View style={s.row}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Pressable key={n} style={[s.numBtn, groupSize === n && s.numBtnSel]} onPress={() => setGroupSize(n)}>
              <Text style={[s.numLabel, groupSize === n && s.numLabelSel]}>{n < 6 ? n : '6+'}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={s.label}>Language needed (optional)</Text>
        <TextInput style={s.input} placeholder="e.g. English, Spanish…" placeholderTextColor={color.mute} value={language} onChangeText={setLanguage} />

        <Text style={s.label}>Additional notes</Text>
        <TextInput style={[s.input, s.textarea]} placeholder="Describe what you're looking for…" placeholderTextColor={color.mute} value={notes} onChangeText={setNotes} multiline numberOfLines={4} textAlignVertical="top" />

        <View style={s.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>Public meetup only</Text>
            <Text style={s.toggleSub}>Require all Buddies to meet in public places</Text>
          </View>
          <Switch value={publicOnly} onValueChange={setPublicOnly} trackColor={{ false: color.haze, true: color.deep }} />
        </View>

        <Pressable style={[s.submitBtn, (loading || !city.trim()) && s.submitBtnDisabled]} onPress={submit} disabled={loading || !city.trim()}>
          <Send size={16} color="#fff" />
          <Text style={s.submitBtnLabel}>{loading ? 'Posting…' : 'Post Request'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// ── Per-buddy booking request form (Mode A) ────────────────────────────────

function BookingRequestForm({ buddyId }: { buddyId: string }) {
  const insets = useSafeAreaInsets();

  const [buddy, setBuddy]             = useState<BuddyProfile | null>(null);
  const [packages, setPackages]       = useState<MarketplacePackage[]>([]);
  const [pkgIdx, setPkgIdx]           = useState<number | null>(null);
  const [bookingDate, setBookingDate] = useState('');
  const [groupSize, setGroupSize]     = useState(1);
  const [city, setCity]               = useState('');
  const [notes, setNotes]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [safetyVisible, setSafetyVisible] = useState(false);
  const [initLoading, setInitLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([
      getBuddyProfile(buddyId),
      getBuddyPackages(buddyId),
    ]).then(([bRes, pRes]) => {
      if (!alive) return;
      if (bRes.ok && bRes.data.buddy) {
        setBuddy(bRes.data.buddy);
        setCity(bRes.data.buddy.city ?? '');
      }
      if (pRes.ok) {
        const active = pRes.data.packages.filter(p => p.isActive);
        setPackages(active);
        if (active.length > 0) setPkgIdx(0);
      }
      setInitLoading(false);
    }).catch(() => setInitLoading(false));
    return () => { alive = false; };
  }, [buddyId]);

  const selectedPkg = pkgIdx != null ? packages[pkgIdx] ?? null : null;

  const validate = (): string | null => {
    if (!bookingDate) return 'Please select a booking date.';
    if (!city.trim()) return 'Please enter a meeting city or area.';
    return null;
  };

  const submit = useCallback(async (acceptSafety: boolean) => {
    const err = validate();
    if (err) { Alert.alert('Missing info', err); return; }
    setLoading(true);
    const res = await createBooking({
      buddyId,
      packageId: selectedPkg?.id,
      bookingDate,
      durationH: selectedPkg?.durationH ?? 2,
      groupSize,
      city: city.trim(),
      category: (selectedPkg?.category as BuddyCategory | undefined) ?? 'city',
      notes: notes.trim() || undefined,
      acceptSafety,
    });
    setLoading(false);
    if (!res.ok) { Alert.alert('Error', res.error); return; }
    const bookingId = res.data.booking?.id;
    if (bookingId) {
      router.replace({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: bookingId } });
    } else {
      router.back();
    }
  }, [buddyId, selectedPkg, bookingDate, groupSize, city, notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPressSubmit = () => {
    const err = validate();
    if (err) { Alert.alert('Missing info', err); return; }
    setSafetyVisible(true);
  };

  if (initLoading) {
    return (
      <View style={[s.root, { paddingTop: insets.top, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ ...t.body, color: color.mute }}>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <SafetyModal
        visible={safetyVisible}
        onAcknowledge={() => { setSafetyVisible(false); submit(true); }}
      />

      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Request Booking</Text>
          {buddy && (
            <Text style={s.subtitle}>{buddy.displayName ?? 'Buddy'} · {buddy.city}</Text>
          )}
        </View>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.notice}>{POLICY_TEXT}</Text>

        {/* Service / package picker */}
        {packages.length > 0 && (
          <>
            <Text style={s.label}>Select a service *</Text>
            {packages.map((pkg, i) => (
              <Pressable
                key={pkg.id}
                style={[s.pkgCard, pkgIdx === i && s.pkgCardSel]}
                onPress={() => setPkgIdx(i)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.pkgTitle}>{pkg.title}</Text>
                  {pkg.description && <Text style={s.pkgDesc} numberOfLines={2}>{pkg.description}</Text>}
                  <View style={s.pkgMeta}>
                    <Clock size={11} color={color.mute} />
                    <Text style={s.pkgMetaText}>{pkg.durationH}h</Text>
                    <Users size={11} color={color.mute} />
                    <Text style={s.pkgMetaText}>Up to {pkg.maxGroup}</Text>
                  </View>
                </View>
                <Text style={s.pkgPrice}>${pkg.priceUsd}</Text>
              </Pressable>
            ))}
          </>
        )}

        {/* Date picker */}
        <Text style={s.label}>Booking date *</Text>
        <DatePickerField
          value={bookingDate}
          onChange={setBookingDate}
          placeholder="Select date"
        />

        {/* Group size */}
        <Text style={s.label}>Group size</Text>
        <View style={s.row}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Pressable key={n} style={[s.numBtn, groupSize === n && s.numBtnSel]} onPress={() => setGroupSize(n)}>
              <Text style={[s.numLabel, groupSize === n && s.numLabelSel]}>{n < 6 ? n : '6+'}</Text>
            </Pressable>
          ))}
        </View>

        {/* City / meeting area */}
        <Text style={s.label}>Meeting city / area *</Text>
        <View style={s.inputRow}>
          <Calendar size={14} color={color.mute} />
          <TextInput
            style={[s.input, { flex: 1, marginBottom: 0 }]}
            placeholder="e.g. Cebu City, BGC, Old Town…"
            placeholderTextColor={color.mute}
            value={city}
            onChangeText={setCity}
          />
        </View>

        {/* Notes */}
        <Text style={s.label}>Additional notes</Text>
        <TextInput style={[s.input, s.textarea]} placeholder="Any specific requests or preferences…" placeholderTextColor={color.mute} value={notes} onChangeText={setNotes} multiline numberOfLines={3} textAlignVertical="top" />

        {/* Price preview */}
        {selectedPkg && (
          <View style={s.priceBox}>
            <Text style={s.priceLabel}>Estimated total</Text>
            <Text style={s.priceVal}>${selectedPkg.priceUsd} USD</Text>
            {selectedPkg.depositRequired && (
              <Text style={s.priceSub}>Deposit ({selectedPkg.depositPercent}%) collected at confirmation</Text>
            )}
            <Text style={s.priceSub}>Cash balance may apply — settle directly with your Buddy at the end of the session.</Text>
          </View>
        )}

        <Pressable
          style={[s.submitBtn, loading && s.submitBtnDisabled]}
          onPress={onPressSubmit}
          disabled={loading}
        >
          <Send size={16} color="#fff" />
          <Text style={s.submitBtnLabel}>{loading ? 'Sending…' : 'Send Request'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// ── Entry point — dispatch to correct mode ─────────────────────────────────

export default function RequestBuddy() {
  const { buddyId } = useLocalSearchParams<{ buddyId?: string }>();
  if (buddyId) return <BookingRequestForm buddyId={buddyId} />;
  return <OpenRequestForm />;
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:            { flex: 1, backgroundColor: color.paper },
  header:          { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:         { padding: space.xs },
  title:           { ...t.heading, color: color.ink },
  subtitle:        { ...t.small, color: color.mute },
  body:            { flex: 1 },
  content:         { padding: space.lg, paddingBottom: 60 },
  notice:          { ...t.small, color: color.mute, backgroundColor: color.haze, padding: space.md, borderRadius: radius.sm, marginBottom: space.lg, lineHeight: 18 },
  label:           { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.sm, marginTop: space.lg },
  input:           { ...t.body, color: color.ink, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze, marginBottom: space.sm },
  inputRow:        { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, borderWidth: 1, borderColor: color.haze, marginBottom: space.sm },
  textarea:        { minHeight: 72 },
  chips:           { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row:             { flexDirection: 'row', gap: space.sm },
  numBtn:          { width: 44, height: 44, borderRadius: radius.sm, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  numBtnSel:       { borderColor: color.deep, backgroundColor: `${color.deep}12` },
  numLabel:        { ...t.body, color: color.ink },
  numLabelSel:     { color: color.deep, fontWeight: '700' },
  toggleRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.lg, padding: space.lg, backgroundColor: color.haze, borderRadius: radius.md },
  toggleLabel:     { ...t.body, color: color.ink, fontWeight: '600' },
  toggleSub:       { ...t.small, color: color.mute },
  submitBtn:       { marginTop: space.xl, backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnLabel:  { ...t.body, color: '#fff', fontWeight: '700' },
  pkgCard:         { borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze, padding: space.md, marginBottom: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.md },
  pkgCardSel:      { borderColor: color.deep, backgroundColor: `${color.deep}08` },
  pkgTitle:        { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  pkgDesc:         { ...t.small, color: color.mute, lineHeight: 16 },
  pkgMeta:         { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.xs },
  pkgMetaText:     { ...t.small, color: color.mute },
  pkgPrice:        { ...t.bodyStrong, color: color.signal, fontSize: 16 },
  priceBox:        { backgroundColor: `${color.success}12`, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: `${color.success}30`, marginTop: space.lg },
  priceLabel:      { ...t.small, color: color.mute, marginBottom: 2 },
  priceVal:        { ...t.heading, color: color.ink, marginBottom: 4 },
  priceSub:        { ...t.small, color: color.mute, lineHeight: 16, marginTop: 2 },
});

const sm = StyleSheet.create({
  overlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: space.xl },
  sheet:    { backgroundColor: color.paper, borderRadius: radius.lg, padding: space.xl, width: '100%', maxWidth: 380 },
  title:    { ...t.heading, color: color.ink, marginBottom: space.lg },
  item:     { flexDirection: 'row', gap: space.md, marginBottom: space.md },
  bullet:   { fontSize: 18 },
  body:     { ...t.body, color: color.ink, flex: 1, lineHeight: 20 },
  btn:      { backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.lg },
  btnText:  { ...t.body, color: '#fff', fontWeight: '700' },
});
