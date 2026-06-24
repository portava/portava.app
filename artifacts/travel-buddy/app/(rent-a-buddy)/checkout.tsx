import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, TextInput,
  Alert, Switch,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Shield, CheckCircle, Info, ChevronDown, ChevronUp,
  AlertTriangle, CreditCard, Lock, MapPin,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState } from '../../src/components/primitives';
import { Stamp } from '../../src/components/ui';
import {
  getBuddyProfile, createBooking,
  type BuddyProfile, type BuddyPackage, type BuddyCategory,
} from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const CATEGORIES: { key: BuddyCategory; label: string }[] = [
  { key: 'city', label: 'City Explorer' },
  { key: 'nightlife', label: 'Nightlife Guide' },
  { key: 'language', label: 'Language Bridge' },
  { key: 'shopping', label: 'Shopping Helper' },
  { key: 'arrival', label: 'Airport Arrival' },
  { key: 'content', label: 'Content Creator' },
  { key: 'adventure', label: 'Group Adventures' },
  { key: 'other', label: 'Custom' },
];

const PUBLIC_ZONES = [
  'Main train / central station entrance',
  'Hotel lobby (your accommodation)',
  'Tourist information centre',
  'Main square / city centre',
  'Airport arrivals hall',
  'Museum / gallery main entrance',
  'Public park main gate',
];

const SAFETY_PREFS = [
  { key: 'safeReturn', label: 'Safe Return check-in', sub: 'Get a check-in reminder at the end of your session' },
  { key: 'shareLocation', label: 'Share location with Trusted Circle', sub: 'Your circle sees your location during the meetup' },
  { key: 'publicOnly', label: 'Public zones only', sub: 'Restrict all meetup locations to public, open spaces' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={sec.wrap}>
      <Text style={sec.title}>{title}</Text>
      {children}
    </View>
  );
}

function PolicyAccordion() {
  const [open, setOpen] = useState(false);
  return (
    <Pressable style={pol.box} onPress={() => setOpen(o => !o)}>
      <View style={pol.row}>
        <Info size={14} color={color.deep} />
        <Text style={pol.title}>Cancellation policy</Text>
        {open ? <ChevronUp size={14} color={color.mute} /> : <ChevronDown size={14} color={color.mute} />}
      </View>
      {open && (
        <Text style={pol.body}>
          Cancel up to 24 hours before your booking start time for a full deposit refund. Cancellations within 24 hours forfeit the deposit. Buddy no-shows are fully refunded.
        </Text>
      )}
    </Pressable>
  );
}

export default function RentABuddyCheckout() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ buddyId?: string; packageId?: string }>();
  const buddyId = params.buddyId ?? '';

  const [buddy, setBuddy] = useState<BuddyProfile | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<BuddyPackage | null>(null);
  const [packages, setPackages] = useState<BuddyPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [category, setCategory] = useState<BuddyCategory>('city');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(2);
  const [groupSize, setGroupSize] = useState(1);
  const [zoneIndex, setZoneIndex] = useState<number | null>(null);
  const [customZone, setCustomZone] = useState('');
  const [notes, setNotes] = useState('');
  const [fullPayment, setFullPayment] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [safetyPrefs, setSafetyPrefs] = useState<Record<string, boolean>>({
    safeReturn: true, shareLocation: false, publicOnly: true,
  });

  const location = zoneIndex != null ? PUBLIC_ZONES[zoneIndex] : customZone;

  const load = useCallback(async () => {
    if (!buddyId) return;
    setLoading(true);
    const res = await getBuddyProfile(buddyId);
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setBuddy(res.data.buddy);
    setPackages(res.data.packages);
    if (params.packageId) {
      const pkg = res.data.packages.find(p => p.id === params.packageId);
      if (pkg) { setSelectedPackage(pkg); setDuration(pkg.durationH); setCategory(pkg.category as BuddyCategory); }
    }
  }, [buddyId, params.packageId]);

  useEffect(() => { load(); }, [load]);

  const hourlyRate = buddy?.hourlyRateUsd ?? 0;
  const baseRate = selectedPackage ? selectedPackage.priceUsd : hourlyRate * duration;
  const serviceFee = Math.round(baseRate * 0.12);
  const deposit = Math.round(baseRate * 0.30);
  const cashBalance = fullPayment ? 0 : baseRate - deposit;
  const totalDueNow = fullPayment ? baseRate + serviceFee : deposit + serviceFee;

  const handleBook = async () => {
    if (!buddy || !policyAccepted) return;
    if (!date.trim()) { Alert.alert('Missing date', 'Please enter a booking date.'); return; }
    if (!location.trim()) { Alert.alert('Missing location', 'Please enter a meetup location.'); return; }

    setSubmitting(true);
    const res = await createBooking({
      buddyId: buddy.id,
      packageId: selectedPackage?.id,
      bookingDate: date,
      startTime: time || undefined,
      durationH: duration,
      groupSize,
      city: buddy.city,
      category,
      notes: notes || undefined,
    });
    setSubmitting(false);

    if (!res.ok) { Alert.alert('Booking failed', res.error); return; }
    const bookingId = res.data.booking?.id;
    if (bookingId) {
      router.replace({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: bookingId } });
    }
  };

  if (loading) return <TravelLoadingState label="Loading…" />;
  if (error || !buddy) return <TravelErrorState title="Couldn't load" sub={error ?? undefined} onRetry={load} />;

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Book a Buddy</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Buddy summary */}
        <View style={styles.buddyRow}>
          <View style={styles.buddyAvatar}>
            <Text style={styles.buddyInitial}>{buddy.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.buddyName}>{buddy.displayName ?? 'Local Buddy'}</Text>
            <Text style={styles.buddyCity}>{buddy.city}{buddy.country ? `, ${buddy.country}` : ''}</Text>
          </View>
          {buddy.verified && (
            <View style={styles.verifiedPill}>
              <CheckCircle size={12} color={color.success} />
              <Text style={styles.verifiedText}>Verified</Text>
            </View>
          )}
        </View>

        {/* Package selector */}
        {packages.length > 0 && (
          <Section title="Package">
            <View style={styles.pkgList}>
              <Pressable
                style={[styles.pkgOption, !selectedPackage && styles.pkgOptionActive]}
                onPress={() => { setSelectedPackage(null); }}
              >
                <Text style={[styles.pkgOptionText, !selectedPackage && styles.pkgOptionTextActive]}>Hourly rate (${hourlyRate}/hr)</Text>
              </Pressable>
              {packages.map(pkg => (
                <Pressable
                  key={pkg.id}
                  style={[styles.pkgOption, selectedPackage?.id === pkg.id && styles.pkgOptionActive]}
                  onPress={() => { setSelectedPackage(pkg); setDuration(pkg.durationH); setCategory(pkg.category as BuddyCategory); }}
                >
                  <Text style={[styles.pkgOptionText, selectedPackage?.id === pkg.id && styles.pkgOptionTextActive]}>
                    {pkg.title} · ${pkg.priceUsd} · {pkg.durationH}h
                  </Text>
                </Pressable>
              ))}
            </View>
          </Section>
        )}

        {/* Category */}
        {!selectedPackage && (
          <Section title="Type of experience">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: space.xs }}>
              {CATEGORIES.map(c => (
                <Pressable
                  key={c.key}
                  style={[styles.catChip, category === c.key && styles.catChipActive]}
                  onPress={() => setCategory(c.key)}
                >
                  <Text style={[styles.catChipText, category === c.key && styles.catChipTextActive]}>{c.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Section>
        )}

        {/* Date & Time */}
        <Section title="Date & time">
          <View style={styles.row}>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.inputLabel}>Date</Text>
              <TextInput
                style={styles.input}
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={color.faint}
              />
            </View>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.inputLabel}>Start time (optional)</Text>
              <TextInput
                style={styles.input}
                value={time}
                onChangeText={setTime}
                placeholder="HH:MM"
                placeholderTextColor={color.faint}
              />
            </View>
          </View>
        </Section>

        {/* Duration */}
        {!selectedPackage && (
          <Section title="Duration">
            <View style={styles.stepper}>
              <Pressable
                style={styles.stepBtn}
                onPress={() => setDuration(d => Math.max(1, d - 1))}
              >
                <Text style={styles.stepBtnText}>−</Text>
              </Pressable>
              <Text style={styles.stepValue}>{duration} hour{duration !== 1 ? 's' : ''}</Text>
              <Pressable
                style={styles.stepBtn}
                onPress={() => setDuration(d => Math.min(12, d + 1))}
              >
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
          </Section>
        )}

        {/* Group size */}
        <Section title="Group size">
          <View style={styles.stepper}>
            <Pressable style={styles.stepBtn} onPress={() => setGroupSize(g => Math.max(1, g - 1))}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{groupSize} person{groupSize !== 1 ? 's' : ''}</Text>
            <Pressable style={styles.stepBtn} onPress={() => setGroupSize(g => Math.min(20, g + 1))}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </Section>

        {/* Meetup location */}
        <Section title="Meetup location">
          <View style={styles.locationNotice}>
            <Shield size={13} color={color.success} />
            <Text style={styles.locationNoticeText}>All initial meetups must be in public, accessible locations.</Text>
          </View>
          <Text style={[styles.inputLabel, { marginTop: space.sm }]}>Suggested public zones</Text>
          {PUBLIC_ZONES.map((zone, i) => (
            <Pressable
              key={zone}
              style={[styles.zoneOption, zoneIndex === i && styles.zoneOptionActive]}
              onPress={() => { setZoneIndex(i); setCustomZone(''); }}
            >
              <MapPin size={12} color={zoneIndex === i ? color.signal : color.mute} />
              <Text style={[styles.zoneOptionText, zoneIndex === i && styles.zoneOptionTextActive]}>{zone}</Text>
              {zoneIndex === i && <CheckCircle size={14} color={color.signal} />}
            </Pressable>
          ))}
          <Text style={[styles.inputLabel, { marginTop: space.md }]}>Or describe a specific spot</Text>
          <TextInput
            style={styles.input}
            value={customZone}
            onChangeText={v => { setCustomZone(v); setZoneIndex(null); }}
            placeholder="e.g. Louvre main entrance, near the pyramid"
            placeholderTextColor={color.faint}
          />
        </Section>

        {/* Safety preferences */}
        <Section title="Safety preferences">
          {SAFETY_PREFS.map(pref => (
            <Pressable
              key={pref.key}
              style={styles.safePrefRow}
              onPress={() => setSafetyPrefs(p => ({ ...p, [pref.key]: !p[pref.key] }))}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.safePrefLabel}>{pref.label}</Text>
                <Text style={styles.safePrefSub}>{pref.sub}</Text>
              </View>
              <View style={[styles.safeToggle, safetyPrefs[pref.key] && styles.safeToggleOn]}>
                <Text style={[styles.safeToggleText, safetyPrefs[pref.key] && styles.safeToggleTextOn]}>
                  {safetyPrefs[pref.key] ? 'ON' : 'OFF'}
                </Text>
              </View>
            </Pressable>
          ))}
        </Section>

        {/* Notes */}
        <Section title="Notes (optional)">
          <TextInput
            style={[styles.input, styles.notesInput]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Tell your Buddy what you're hoping to experience…"
            placeholderTextColor={color.faint}
            multiline
            numberOfLines={3}
          />
        </Section>

        {/* Price breakdown */}
        <Section title="Price breakdown">
          <View style={styles.priceTable}>
            <View style={styles.priceRow}>
              <Text style={styles.priceKey}>
                {selectedPackage ? `${selectedPackage.title}` : `${duration}h × $${hourlyRate}/hr`}
              </Text>
              <Text style={styles.priceVal}>${baseRate}</Text>
            </View>
            <View style={styles.priceRow}>
              <Text style={styles.priceKey}>App service fee</Text>
              <Text style={styles.priceVal}>${serviceFee}</Text>
            </View>
            <View style={styles.priceDivider} />
            <View style={styles.priceRow}>
              <Text style={styles.priceTotalKey}>Deposit due today</Text>
              <Text style={styles.priceTotalVal}>${fullPayment ? baseRate + serviceFee : deposit + serviceFee}</Text>
            </View>
            {!fullPayment && (
              <View style={styles.priceRow}>
                <Text style={[styles.priceKey, { color: color.warn }]}>Cash balance (due to Buddy)</Text>
                <Text style={[styles.priceVal, { color: color.warn }]}>${cashBalance}</Text>
              </View>
            )}
          </View>

          <View style={styles.paymentToggle}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                <Lock size={13} color={color.success} />
                <Text style={styles.toggleLabel}>Pay in full in-app</Text>
                <View style={styles.saferBadge}><Text style={styles.saferText}>SAFER</Text></View>
              </View>
              <Text style={styles.toggleSub}>No cash exchange with your Buddy</Text>
            </View>
            <Switch
              value={fullPayment}
              onValueChange={setFullPayment}
              trackColor={{ true: color.success, false: color.haze }}
              thumbColor={color.paperRaised}
            />
          </View>
        </Section>

        {/* Notice */}
        <View style={styles.confirmNotice}>
          <AlertTriangle size={14} color={color.warn} />
          <Text style={styles.confirmNoticeText}>
            Booking is not confirmed until deposit or full in-app payment is completed.
          </Text>
        </View>

        {/* Cancellation policy */}
        <View style={{ paddingHorizontal: space.lg, marginTop: space.sm }}>
          <PolicyAccordion />
        </View>

        {/* Policy checkbox */}
        <Pressable
          style={styles.policyRow}
          onPress={() => setPolicyAccepted(v => !v)}
        >
          <View style={[styles.checkbox, policyAccepted && styles.checkboxChecked]}>
            {policyAccepted && <Text style={styles.checkmark}>✓</Text>}
          </View>
          <Text style={styles.policyText}>
            I confirm this booking is for cultural, social, or practical travel support only. This platform does not facilitate dating or adult services.
          </Text>
        </Pressable>

        <View style={{ height: 120 + insets.bottom }} />
      </ScrollView>

      {/* Confirm button */}
      <View style={[styles.stickyBottom, { paddingBottom: insets.bottom + space.md }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.dueLabel}>Due today</Text>
          <Text style={styles.dueAmount}>${totalDueNow}</Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.confirmBtn,
            (!policyAccepted || submitting) && styles.confirmBtnDisabled,
            pressed && { opacity: layout.pressedOpacity },
          ]}
          onPress={handleBook}
          disabled={!policyAccepted || submitting}
        >
          <CreditCard size={16} color={color.onInk} />
          <Text style={styles.confirmBtnText}>
            {submitting ? 'Processing…' : 'Confirm & Pay'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: color.ink },
  scroll: { paddingBottom: 20 },
  buddyRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, backgroundColor: color.paperRaised,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  buddyAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  buddyInitial: { fontSize: 20, fontWeight: '700', color: color.onInk },
  buddyName: { ...t.bodyStrong, color: color.ink },
  buddyCity: { ...t.small, color: color.mute },
  verifiedPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EEF8F3', borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 4 },
  verifiedText: { fontSize: 10, fontWeight: '700', color: color.success, fontFamily: 'Courier' },
  pkgList: { gap: space.sm, marginTop: space.xs },
  pkgOption: {
    borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze,
    padding: space.md, backgroundColor: color.paperRaised,
  },
  pkgOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0ED' },
  pkgOptionText: { ...t.body, color: color.ink },
  pkgOptionTextActive: { color: color.signal, fontWeight: '700' },
  catChip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  catChipActive: { backgroundColor: color.signal, borderColor: color.signal },
  catChipText: { ...t.small, fontWeight: '600', color: color.ink },
  catChipTextActive: { color: color.onInk },
  row: { flexDirection: 'row', gap: space.md },
  inputWrap: {},
  inputLabel: { ...t.small, fontWeight: '600', color: color.mute, marginBottom: 4 },
  input: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    ...t.body, color: color.ink,
  },
  notesInput: { height: 80, textAlignVertical: 'top' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  stepBtn: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBtnText: { fontSize: 20, color: color.ink, fontWeight: '600' },
  stepValue: { ...t.bodyStrong, color: color.ink, minWidth: 80, textAlign: 'center' },
  locationNotice: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#EEF8F3', borderRadius: radius.sm, padding: space.sm,
  },
  locationNoticeText: { ...t.small, color: color.success, flex: 1 },
  zoneOption: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, padding: space.sm, marginBottom: space.xs,
  },
  zoneOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0ED' },
  zoneOptionText: { ...t.small, color: color.ink, flex: 1 },
  zoneOptionTextActive: { color: color.signal, fontWeight: '700' },
  safePrefRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  safePrefLabel: { ...t.bodyStrong, color: color.ink },
  safePrefSub: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 16 },
  safeToggle: {
    borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 4,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  safeToggleOn: { backgroundColor: color.success, borderColor: color.success },
  safeToggleText: { fontSize: 9, fontWeight: '800', color: color.mute, fontFamily: 'Courier', letterSpacing: 0.5 },
  safeToggleTextOn: { color: '#fff' },
  priceTable: { gap: space.sm },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  priceKey: { ...t.body, color: color.mute },
  priceVal: { ...t.body, color: color.ink, fontWeight: '600' },
  priceDivider: { height: 1, backgroundColor: color.haze, marginVertical: space.xs },
  priceTotalKey: { ...t.bodyStrong, color: color.ink },
  priceTotalVal: { ...t.bodyStrong, color: color.ink, fontSize: 18 },
  paymentToggle: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    marginTop: space.md, backgroundColor: '#EEF8F3',
    borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.success,
  },
  toggleLabel: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
  saferBadge: { backgroundColor: color.success, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  saferText: { fontSize: 9, fontWeight: '800', color: '#fff', fontFamily: 'Courier', letterSpacing: 0.5 },
  confirmNotice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: '#FFF8ED', borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.warn,
  },
  confirmNoticeText: { ...t.small, color: color.warn, flex: 1, lineHeight: 18 },
  policyRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    marginHorizontal: space.lg, marginTop: space.lg,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
    borderColor: color.haze, backgroundColor: color.paperRaised,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: color.signal, borderColor: color.signal },
  checkmark: { color: '#fff', fontWeight: '700', fontSize: 13 },
  policyText: { ...t.small, color: color.mute, flex: 1, lineHeight: 18 },
  stickyBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze,
    paddingHorizontal: space.lg, paddingTop: space.md,
    ...shadow.float,
  },
  dueLabel: { ...t.small, color: color.mute },
  dueAmount: { ...t.bodyStrong, color: color.ink, fontSize: 20 },
  confirmBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md,
  },
  confirmBtnDisabled: { backgroundColor: color.haze },
  confirmBtnText: { ...t.bodyStrong, color: color.onInk },
});

const sec = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.xl },
  title: { ...t.small, fontWeight: '700', color: color.mute, letterSpacing: 0.5, marginBottom: space.sm, textTransform: 'uppercase' },
});

const pol = StyleSheet.create({
  box: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, flex: 1 },
  body: { ...t.body, color: color.mute, marginTop: space.sm, lineHeight: 20 },
});
