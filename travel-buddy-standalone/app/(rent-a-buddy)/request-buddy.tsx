/**
 * request-buddy.tsx — dual-mode screen.
 *
 * Mode A (per-buddy booking request): opened with `buddyId` param from a
 * buddy detail screen. Shows package picker, date/time pickers, duration,
 * group size, city/meeting area, notes, price preview, and a first-booking-only
 * safety tutorial modal. Submits via createBooking() → navigates to booking/[id].
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
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import type { Place } from '../../src/lib/location/placeTypes';
import {
  ArrowLeft, Send, Users, Clock, Shield, AlertTriangle,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { TravelChip } from '../../src/components/primitives';
import { DatePickerField } from '../../src/components/DatePickerField';
import { DatePickerField as NativeTimePicker } from '../../src/components/DateTimePickerField';
import {
  createRequest, createBooking, getBuddyPackages, getBuddyProfile,
  type BuddyCategory, type MarketplacePackage, type BuddyProfile,
} from '../../src/services/rentABuddy';

// ── AsyncStorage helper (lazy-require so module load never crashes) ─────────

type StorageStub = { setItem(k: string, v: string): Promise<void>; getItem(k: string): Promise<string | null> };
const getStorage = (): StorageStub | null => {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
};
const TUTORIAL_KEY = 'rab_safety_tutorial_shown';

async function hasSeenTutorial(): Promise<boolean> {
  const s = getStorage();
  if (!s) return false;
  const v = await s.getItem(TUTORIAL_KEY);
  return v === 'true';
}

async function markTutorialSeen(): Promise<void> {
  const s = getStorage();
  if (!s) return;
  await s.setItem(TUTORIAL_KEY, 'true');
}

// ── Safety tutorial modal (first booking only) ────────────────────────────

function SafetyModal({ visible, onAcknowledge }: { visible: boolean; onAcknowledge: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={sm.overlay}>
        <View style={sm.sheet}>
          <View style={sm.iconRow}>
            <Shield size={28} color={color.success} />
          </View>
          <Text style={sm.title}>Before you book</Text>
          <Text style={sm.sub}>Please review these important safety guidelines.</Text>

          <View style={sm.rule}>
            <AlertTriangle size={14} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={sm.ruleTitle}>Not a dating service</Text>
              <Text style={sm.ruleSub}>Rent a Buddy is a social travel companion service. Romantic or sexual expectations are strictly prohibited.</Text>
            </View>
          </View>

          <View style={sm.rule}>
            <AlertTriangle size={14} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={sm.ruleTitle}>Never pay off-app</Text>
              <Text style={sm.ruleSub}>Only pay via Travel Buddy. Cash should only cover the pre-agreed balance at session end — never upfront.</Text>
            </View>
          </View>

          <View style={sm.rule}>
            <Shield size={14} color={color.success} />
            <View style={{ flex: 1 }}>
              <Text style={sm.ruleTitle}>Safe Return is always on</Text>
              <Text style={sm.ruleSub}>Your session has built-in check-ins. Share your location with your Trusted Circle and use the SOS button if needed.</Text>
            </View>
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
const DURATIONS = [
  { label: '1h', value: 60 }, { label: '2h', value: 120 }, { label: '3h', value: 180 },
  { label: 'Half day', value: 240 }, { label: 'Full day', value: 480 },
];
const BUDGET_OPTS = [
  { label: 'Under $20/hr', min: 0,   max: 20   },
  { label: '$20–$40/hr',  min: 20,  max: 40   },
  { label: '$40–$70/hr',  min: 40,  max: 70   },
  { label: 'Open budget', min: null, max: null  },
];
const POLICY_TEXT = "Requests must be for legitimate travel services only. Escort, adult, romantic, or illegal service requests are not permitted and result in a permanent ban.";

function OpenRequestForm() {
  const insets = useSafeAreaInsets();
  const [city, setCity]                       = useState('');
  const [cityCoords, setCityCoords]           = useState<{ lat: number; lng: number } | null>(null);
  const [cityPickerOpen, setCityPickerOpen]   = useState(false);
  const [category, setCategory]               = useState('city');
  const [durationMinutes, setDurationMinutes] = useState(120);
  const [budgetIdx, setBudgetIdx]             = useState(1);
  const [language, setLanguage]               = useState('');
  const [groupSize, setGroupSize]             = useState(1);
  const [notes, setNotes]                     = useState('');
  const [publicOnly, setPublicOnly]           = useState(false);
  const [loading, setLoading]                 = useState(false);

  const budget = BUDGET_OPTS[budgetIdx];

  const submit = useCallback(async () => {
    if (!city.trim()) { Alert.alert('Missing city', 'Please enter the city for your request.'); return; }
    setLoading(true);
    const basePayload = {
      city: city.trim(),
      category, durationMinutes, groupSize,
      budgetMinUsd: budget.min ?? undefined,
      budgetMaxUsd: budget.max ?? undefined,
      languageNeeded: language.trim() || undefined,
      safetyPrefs: { publicOnly },
      notes: notes.trim() || undefined,
    };
    const result = await createRequest(
      cityCoords != null && cityCoords.lat != null && cityCoords.lng != null
        ? { ...basePayload, lat: cityCoords.lat, lng: cityCoords.lng }
        : basePayload,
    );
    setLoading(false);
    if (!result.ok) { Alert.alert('Error', result.error); return; }
    Alert.alert(
      'Request Posted!',
      'Eligible Buddies in your city will see your request and can send you offers.',
      [{ text: 'View Offers', onPress: () => router.replace({ pathname: '/(rent-a-buddy)/offers' as any, params: { requestId: result.data.request.id } }) }]
    );
  }, [city, cityCoords, category, durationMinutes, groupSize, budget, language, publicOnly, notes]);

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
        <Pressable onPress={() => setCityPickerOpen(true)}>
          <Text style={[s.input, !city && { color: color.mute }]} numberOfLines={1}>
            {city || 'e.g. Tokyo, Barcelona…'}
          </Text>
        </Pressable>
        <GlobalPlacePicker
          visible={cityPickerOpen}
          onClose={() => setCityPickerOpen(false)}
          onSelect={(place: Place) => {
            setCity(place.city ?? place.name);
            setCityCoords(place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null);
          }}
          mode="city"
          title="Which city?"
          usedFor="buddy_request"
        />

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
              <Text style={[s.numLabel, groupSize === n && s.numLabelSel]}>{n < 6 ? String(n) : '6+'}</Text>
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

  const [buddy, setBuddy]                   = useState<BuddyProfile | null>(null);
  const [packages, setPackages]             = useState<MarketplacePackage[]>([]);
  const [pkgIdx, setPkgIdx]                 = useState<number | null>(null);
  const [bookingDate, setBookingDate]       = useState('');
  const [startTime, setStartTime]           = useState<Date | null>(null);
  const [groupSize, setGroupSize]           = useState(1);
  const [city, setCity]                     = useState('');
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [notes, setNotes]                   = useState('');
  const [loading, setLoading]               = useState(false);
  const [initLoading, setInitLoading]       = useState(true);
  const [safetyVisible, setSafetyVisible]   = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([getBuddyProfile(buddyId), getBuddyPackages(buddyId)]).then(([bRes, pRes]) => {
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

  const selectedPkg = pkgIdx != null ? (packages[pkgIdx] ?? null) : null;

  const validate = (): string | null => {
    if (!bookingDate) return 'Please select a booking date.';
    if (!city.trim()) return 'Please enter a meeting city or area.';
    return null;
  };

  const doSubmit = useCallback(async () => {
    setLoading(true);
    const timeStr = startTime
      ? startTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : undefined;
    const res = await createBooking({
      buddyId,
      packageId: selectedPkg?.id,
      bookingDate,
      startTime: timeStr,
      durationH: selectedPkg?.durationH ?? 2,
      groupSize,
      city: city.trim(),
      category: (selectedPkg?.category as BuddyCategory | undefined) ?? 'city',
      notes: notes.trim() || undefined,
      acceptSafety: true,
    });
    setLoading(false);
    if (!res.ok) { Alert.alert('Error', res.error); return; }
    const bookingId = res.data.booking?.id;
    if (bookingId) {
      router.replace({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: bookingId } });
    } else {
      router.back();
    }
  }, [buddyId, selectedPkg, bookingDate, startTime, groupSize, city, notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPressSubmit = async () => {
    const err = validate();
    if (err) { Alert.alert('Missing info', err); return; }
    const seen = await hasSeenTutorial();
    if (seen) {
      doSubmit();
    } else {
      setSafetyVisible(true);
    }
  };

  const handleSafetyAck = async () => {
    await markTutorialSeen();
    setSafetyVisible(false);
    doSubmit();
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
      <SafetyModal visible={safetyVisible} onAcknowledge={handleSafetyAck} />

      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Request Booking</Text>
          {buddy && <Text style={s.subtitle}>{buddy.displayName ?? 'Buddy'} · {buddy.city}</Text>}
        </View>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.notice}>{POLICY_TEXT}</Text>

        {/* Service / package picker */}
        {packages.length > 0 && (
          <>
            <Text style={s.label}>Select a service *</Text>
            {packages.map((pkg, i) => (
              <Pressable key={pkg.id} style={[s.pkgCard, pkgIdx === i && s.pkgCardSel]} onPress={() => setPkgIdx(i)}>
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

        {/* Date */}
        <Text style={s.label}>Booking date *</Text>
        <DatePickerField value={bookingDate} onChange={setBookingDate} placeholder="Select date" />

        {/* Time */}
        <Text style={s.label}>Start time (optional)</Text>
        <NativeTimePicker
          value={startTime}
          onChange={setStartTime}
          onClear={() => setStartTime(null)}
          placeholder="Pick a start time"
          mode="time"
        />

        {/* Group size */}
        <Text style={s.label}>Group size</Text>
        <View style={s.row}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Pressable key={n} style={[s.numBtn, groupSize === n && s.numBtnSel]} onPress={() => setGroupSize(n)}>
              <Text style={[s.numLabel, groupSize === n && s.numLabelSel]}>{n < 6 ? String(n) : '6+'}</Text>
            </Pressable>
          ))}
        </View>

        {/* City / meeting area */}
        <Text style={s.label}>Meeting city / area *</Text>
        <Pressable onPress={() => setCityPickerOpen(true)}>
          <Text style={[s.input, !city && { color: color.mute }]} numberOfLines={1}>
            {city || 'e.g. Cebu City, BGC, Old Town…'}
          </Text>
        </Pressable>
        <GlobalPlacePicker
          visible={cityPickerOpen}
          onClose={() => setCityPickerOpen(false)}
          onSelect={(place: Place) => setCity(place.city && place.type !== 'city' ? `${place.name}, ${place.city}` : (place.city ?? place.name))}
          title="Meeting city or area"
          placeholder="City, neighborhood or landmark…"
          usedFor="buddy_meeting_area"
        />


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
            <Text style={s.priceSub}>Cash balance settled directly with your Buddy at session end.</Text>
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

// ── Entry point ───────────────────────────────────────────────────────────

export default function RequestBuddy() {
  const { buddyId } = useLocalSearchParams<{ buddyId?: string }>();
  if (buddyId) return <BookingRequestForm buddyId={buddyId} />;
  return <OpenRequestForm />;
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:              { flex: 1, backgroundColor: color.paper },
  header:            { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:           { padding: space.xs },
  title:             { ...t.heading, color: color.ink },
  subtitle:          { ...t.small, color: color.mute },
  body:              { flex: 1 },
  content:           { padding: space.lg, paddingBottom: 60 },
  notice:            { ...t.small, color: color.mute, backgroundColor: color.haze, padding: space.md, borderRadius: radius.sm, marginBottom: space.lg, lineHeight: 18 },
  label:             { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.sm, marginTop: space.lg },
  input:             { ...t.body, color: color.ink, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze, marginBottom: space.sm },
  textarea:          { minHeight: 72 },
  chips:             { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row:               { flexDirection: 'row', gap: space.sm },
  numBtn:            { width: 44, height: 44, borderRadius: radius.sm, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  numBtnSel:         { borderColor: color.deep, backgroundColor: `${color.deep}12` },
  numLabel:          { ...t.body, color: color.ink },
  numLabelSel:       { color: color.deep, fontWeight: '700' },
  toggleRow:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.lg, padding: space.lg, backgroundColor: color.haze, borderRadius: radius.md },
  toggleLabel:       { ...t.body, color: color.ink, fontWeight: '600' },
  toggleSub:         { ...t.small, color: color.mute },
  submitBtn:         { marginTop: space.xl, backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnLabel:    { ...t.body, color: '#fff', fontWeight: '700' },
  pkgCard:           { borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze, padding: space.md, marginBottom: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.md },
  pkgCardSel:        { borderColor: color.deep, backgroundColor: `${color.deep}08` },
  pkgTitle:          { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  pkgDesc:           { ...t.small, color: color.mute, lineHeight: 16 },
  pkgMeta:           { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.xs },
  pkgMetaText:       { ...t.small, color: color.mute },
  pkgPrice:          { ...t.bodyStrong, color: color.signal, fontSize: 16 },
  priceBox:          { backgroundColor: `${color.success}12`, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: `${color.success}30`, marginTop: space.lg },
  priceLabel:        { ...t.small, color: color.mute, marginBottom: 2 },
  priceVal:          { ...t.heading, color: color.ink, marginBottom: 4 },
  priceSub:          { ...t.small, color: color.mute, lineHeight: 16, marginTop: 2 },
});

const sm = StyleSheet.create({
  overlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: space.xl },
  sheet:     { backgroundColor: color.paper, borderRadius: radius.lg, padding: space.xl, width: '100%', maxWidth: 380 },
  iconRow:   { alignItems: 'center', marginBottom: space.md },
  title:     { ...t.heading, color: color.ink, marginBottom: space.xs, textAlign: 'center' },
  sub:       { ...t.small, color: color.mute, marginBottom: space.lg, textAlign: 'center' },
  rule:      { flexDirection: 'row', gap: space.md, marginBottom: space.md, alignItems: 'flex-start' },
  ruleTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  ruleSub:   { ...t.small, color: color.mute, lineHeight: 16 },
  btn:       { backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.lg },
  btnText:   { ...t.body, color: '#fff', fontWeight: '700' },
});
