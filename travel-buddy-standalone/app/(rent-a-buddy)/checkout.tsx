import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, TextInput,
  Alert, Modal,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Shield, CheckCircle, Info, ChevronDown, ChevronUp,
  AlertTriangle, MapPin, CalendarCheck, Calendar, Clock,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout, avatar } from '../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState } from '../../src/components/primitives';
import { Stamp } from '../../src/components/ui';
import {
  getBuddyProfile, createBooking, getBuddyBlockedDates,
  isBookingUnavailable, bookingErrorCopy,
  type BuddyProfile, type BuddyPackage, type BuddyCategory, type BuddyBlockedRange,
} from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStickyBarInset } from '../../src/hooks/useBottomInset';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalTimePicker } from '../../src/components/selectors/GlobalTimePicker';
import { DurationPicker, type DurationOption } from '../../src/components/selectors/DurationPicker';
import {
  fromISODate, fromHHmm, formatDisplayDate, formatDisplayTime, toISODate,
} from '../../src/lib/dateTime/formatters';

type AsyncStorageStub = { setItem(k: string, v: string): Promise<void>; getItem(k: string): Promise<string | null> };
const getStorage = (): AsyncStorageStub | null => {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
};
const TUTORIAL_KEY = 'rab_safety_tutorial_shown';

function SafetyTutorialModal({ visible, onAcknowledge }: { visible: boolean; onAcknowledge: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={tut.overlay}>
        <View style={tut.sheet}>
          <View style={tut.iconRow}>
            <Shield size={28} color={color.success} />
          </View>
          <Text style={tut.title}>Before you book</Text>
          <Text style={tut.sub}>Please review these important safety guidelines.</Text>

          <View style={tut.rule}>
            <AlertTriangle size={14} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={tut.ruleTitle}>Not a dating service</Text>
              <Text style={tut.ruleSub}>Rent a Buddy is a social travel companion service. Romantic or sexual expectations are strictly prohibited.</Text>
            </View>
          </View>

          <View style={tut.rule}>
            <AlertTriangle size={14} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={tut.ruleTitle}>No upfront cash payments</Text>
              <Text style={tut.ruleSub}>In-app payment is coming soon. Payment is agreed directly with your Buddy after they confirm your booking — never pay cash to anyone before your session begins.</Text>
            </View>
          </View>

          <View style={tut.rule}>
            <Shield size={14} color={color.success} />
            <View style={{ flex: 1 }}>
              <Text style={tut.ruleTitle}>Safe Return is always on</Text>
              <Text style={tut.ruleSub}>Your session has built-in safety check-ins. Share your location with your Trusted Circle and use the SOS button if needed.</Text>
            </View>
          </View>

          <Pressable style={tut.btn} onPress={onAcknowledge}>
            <Text style={tut.btnText}>I understand — continue to book</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

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

const BUDDY_DURATION_OPTIONS: DurationOption[] = [
  { label: '1 h', seconds: 3600 },
  { label: '2 h', seconds: 7200 },
  { label: '3 h', seconds: 10800 },
  { label: '4 h', seconds: 14400 },
  { label: '6 h', seconds: 21600 },
  { label: '8 h', seconds: 28800 },
  { label: '10 h', seconds: 36000 },
  { label: '12 h', seconds: 43200 },
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
  const { inset: barInset, onBarLayout } = useStickyBarInset();
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
  const [duration, setDuration] = useState(2 * 3600);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [blockedRanges, setBlockedRanges] = useState<BuddyBlockedRange[]>([]);
  const [groupSize, setGroupSize] = useState(1);
  const [zoneIndex, setZoneIndex] = useState<number | null>(null);
  const [customZone, setCustomZone] = useState('');
  const [notes, setNotes] = useState('');
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [safetyPrefs, setSafetyPrefs] = useState<Record<string, boolean>>({
    safeReturn: true, shareLocation: false, publicOnly: true,
  });
  const [tutorialVisible, setTutorialVisible] = useState(false);
  const [pendingBook, setPendingBook] = useState(false);
  // Set when the server refuses because the feature is not open (Rent a Buddy is
  // deliberately closed for launch). Held as state, not shown as an Alert: an
  // alert is dismissed and leaves the user staring at a Book button that cannot
  // work. This is a state of the feature, so it stays on screen.
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

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
      if (pkg) { setSelectedPackage(pkg); setDuration(pkg.durationH * 3600); setCategory(pkg.category as BuddyCategory); }
    }
  }, [buddyId, params.packageId]);

  useEffect(() => { load(); }, [load]);

  // Load the buddy's blocked/vacation dates so the picker greys them out.
  useEffect(() => {
    if (!buddyId) return;
    let alive = true;
    getBuddyBlockedDates(buddyId).then((res) => {
      if (alive && res.ok) setBlockedRanges(res.data.blocked ?? []);
    });
    return () => { alive = false; };
  }, [buddyId]);

  // Expand blocked ranges into individual ISO dates (capped at 366 days per range).
  const blockedDates = React.useMemo(() => {
    const out: string[] = [];
    for (const r of blockedRanges) {
      const start = fromISODate(r.startDate);
      const end = fromISODate(r.endDate) ?? start;
      if (!start || !end) continue;
      const d = new Date(start);
      for (let i = 0; i <= 366 && d <= end; i++) {
        out.push(toISODate(d));
        d.setDate(d.getDate() + 1);
      }
    }
    return out;
  }, [blockedRanges]);

  const hourlyRate = buddy?.hourlyRateUsd ?? 0;

  const submitBooking = async (acceptSafety = false) => {
    if (!buddy) return;
    const durationH = Math.max(1, Math.round(duration / 3600));
    setSubmitting(true);
    const res = await createBooking({
      buddyId: buddy.id,
      packageId: selectedPackage?.id,
      bookingDate: date,
      startTime: time || undefined,
      durationH,
      groupSize,
      city: buddy.city,
      countryCode: (buddy as any).country_code ?? (buddy as any).country ?? undefined,
      meetupLocation: location || undefined,
      category,
      notes: notes || undefined,
      acceptSafety,
    });
    setSubmitting(false);

    if (!res.ok) {
      if (isBookingUnavailable(res.error)) {
        setUnavailableReason(bookingErrorCopy(res.error));
        return;
      }
      // Genuine failure — still routed through bookingErrorCopy so no raw
      // error code can reach the user.
      Alert.alert('Booking failed', bookingErrorCopy(res.error));
      return;
    }
    const bookingId = res.data.booking?.id;
    if (bookingId) {
      router.replace({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: bookingId, fromCheckout: '1' } });
    }
  };

  const handleBook = async () => {
    if (!buddy || !policyAccepted || unavailableReason) return;
    if (!date.trim()) { Alert.alert('Missing date', 'Please select a booking date.'); return; }
    if (blockedDates.includes(date)) {
      Alert.alert('Date unavailable', 'This Buddy is not available on that date. Please pick another date.');
      return;
    }
    if (!location.trim()) { Alert.alert('Missing location', 'Please enter a meetup location.'); return; }

    const storage = getStorage();
    if (storage) {
      const shown = await storage.getItem(TUTORIAL_KEY).catch(() => null);
      if (!shown) {
        setTutorialVisible(true);
        setPendingBook(true);
        return;
      }
    }
    await submitBooking(false);
  };

  if (loading) return <TravelLoadingState label="Loading…" />;
  if (error || !buddy) return <TravelErrorState title="Couldn't load" sub={error ?? undefined} onRetry={load} />;

  return (
    <KeyboardSafeScrollView style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Book a Buddy</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: barInset }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Feature-closed banner — persistent, above the form. */}
        {unavailableReason && (
          <View style={styles.unavailableBanner} accessibilityRole="alert" testID="booking-unavailable-banner">
            <Info size={15} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={styles.unavailableTitle}>Not available yet</Text>
              <Text style={styles.unavailableBody}>{unavailableReason}</Text>
            </View>
          </View>
        )}

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
                  onPress={() => { setSelectedPackage(pkg); setDuration(pkg.durationH * 3600); setCategory(pkg.category as BuddyCategory); }}
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
              <Pressable
                style={[styles.input, styles.inputTrigger]}
                onPress={() => setShowDatePicker(true)}
              >
                <Calendar size={14} color={date ? color.ink : color.haze} />
                <Text style={date ? styles.inputTriggerText : styles.inputPlaceholder} numberOfLines={1}>
                  {date ? formatDisplayDate(fromISODate(date) ?? new Date()) : 'Select date'}
                </Text>
              </Pressable>
            </View>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.inputLabel}>Start time (optional)</Text>
              <Pressable
                style={[styles.input, styles.inputTrigger]}
                onPress={() => setShowTimePicker(true)}
              >
                <Clock size={14} color={time ? color.ink : color.haze} />
                <Text style={time ? styles.inputTriggerText : styles.inputPlaceholder} numberOfLines={1}>
                  {time ? (fromHHmm(time) ? formatDisplayTime(fromHHmm(time)!) : time) : 'Select (optional)'}
                </Text>
              </Pressable>
            </View>
          </View>
        </Section>

        {/* Duration */}
        {!selectedPackage && (
          <Section title="Duration">
            <DurationPicker
              showChips
              visible={true}
              value={duration}
              onChange={(s) => { if (s != null) setDuration(s); }}
              onClose={() => {}}
              options={BUDDY_DURATION_OPTIONS}
            />
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
            placeholderTextColor={color.haze}
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
            placeholderTextColor={color.haze}
            multiline
            numberOfLines={3}
          />
        </Section>

        {/* Payment explanation */}
        <View style={[styles.paymentNotice, { marginHorizontal: space.lg, marginTop: space.xl }]}>
          <Info size={13} color={color.deep} />
          <Text style={styles.paymentNoticeText}>
            No payment is charged through the app. You and your Buddy agree on payment directly after they confirm your booking.
          </Text>
        </View>

        {/* Notice */}
        <View style={styles.confirmNotice}>
          <AlertTriangle size={14} color={color.warn} />
          <Text style={styles.confirmNoticeText}>
            Your request is sent to the Buddy for review. Booking is confirmed only after they accept.
          </Text>
        </View>

        {/* Cancellation policy */}
        <View style={{ paddingHorizontal: space.lg, marginTop: space.sm }}>
          <PolicyAccordion />
        </View>

        {/* Legal disclaimer */}
        <View style={styles.legalDisclaimer}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.xs }}>
            <Shield size={13} color={color.mute} />
            <Text style={styles.legalTitle}>Community Companionship Only</Text>
          </View>
          <Text style={styles.legalBody}>
            Rent a Buddy is a local guide and travel companionship service only. It is{' '}
            <Text style={{ fontWeight: '700' }}>not</Text> a dating, escort, adult-service, romantic,
            or sexual-service platform. All meetups begin at public locations. In an emergency, call
            local services immediately (112 / 911 / 999).
          </Text>
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
      </ScrollView>

      {/* Confirm button */}
      <View style={[styles.stickyBottom, { paddingBottom: insets.bottom + space.md }]} onLayout={onBarLayout}>
        <Pressable
          style={({ pressed }) => [
            styles.confirmBtn,
            (!policyAccepted || submitting || !!unavailableReason) && styles.confirmBtnDisabled,
            pressed && { opacity: layout.pressedOpacity },
          ]}
          onPress={handleBook}
          disabled={!policyAccepted || submitting || !!unavailableReason}
          testID="checkout-confirm-btn"
        >
          <CalendarCheck size={16} color={color.onInk} />
          <Text style={styles.confirmBtnText}>
            {unavailableReason
              ? 'Not available yet'
              : submitting ? 'Sending request…' : 'Request Booking'}
          </Text>
        </Pressable>
      </View>

      <GlobalCalendarPicker
        visible={showDatePicker}
        mode="single"
        value={date || null}
        allowPast={false}
        disabledDates={blockedDates}
        disabledDatesNote="Crossed-out dates are unavailable — this Buddy is away or fully blocked."
        onConfirm={(v) => { setDate(v ?? ''); setShowDatePicker(false); }}
        onCancel={() => setShowDatePicker(false)}
        title="Select booking date"
      />
      <GlobalTimePicker
        visible={showTimePicker}
        value={time || null}
        allowClear
        onChange={(v) => { setTime(v ?? ''); setShowTimePicker(false); }}
        onClose={() => setShowTimePicker(false)}
        title="Select start time"
      />

      <SafetyTutorialModal
        visible={tutorialVisible}
        onAcknowledge={async () => {
          setTutorialVisible(false);
          const storage = getStorage();
          if (storage) await storage.setItem(TUTORIAL_KEY, '1').catch(() => {});
          if (pendingBook) {
            setPendingBook(false);
            // acceptSafety=true records first_booking_safety_acknowledged_at server-side
            await submitBooking(true);
          }
        }}
      />
    </KeyboardSafeScrollView>
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
  unavailableBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: '#EBF0FF', borderRadius: radius.md,
    padding: space.md, borderWidth: 1, borderColor: color.deep,
  },
  unavailableTitle: { ...t.bodyStrong, color: color.deep, marginBottom: 2 },
  unavailableBody: { ...t.small, color: color.deep, lineHeight: 18 },
  buddyRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, backgroundColor: color.paperRaised,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  buddyAvatar: {
    width: avatar.s48, height: avatar.s48, borderRadius: avatar.s48 / 2,
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
  inputTrigger: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 },
  inputTriggerText: { ...t.body, color: color.ink, flex: 1 },
  inputPlaceholder: { ...t.body, color: color.haze, flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  stepBtn: {
    width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2,
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
  paymentNotice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginTop: space.md, backgroundColor: '#EBF0FF', borderRadius: radius.md,
    padding: space.md, borderWidth: 1, borderColor: color.deep,
  },
  paymentNoticeText: { ...t.small, color: color.deep, flex: 1, lineHeight: 18 },
  confirmNotice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: '#FFF8ED', borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.warn,
  },
  confirmNoticeText: { ...t.small, color: color.warn, flex: 1, lineHeight: 18 },
  legalDisclaimer: {
    marginHorizontal: space.lg, marginTop: space.lg,
    backgroundColor: '#F7F7F7', borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  legalTitle: { ...t.small, fontWeight: '700', color: color.ink, letterSpacing: 0.2 },
  legalBody: { ...t.small, color: color.mute, lineHeight: 18 },
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
  confirmBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md,
  },
  confirmBtnDisabled: { backgroundColor: color.haze },
  confirmBtnText: { ...t.bodyStrong, color: color.onInk },
});

const tut = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: color.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: space.xl, gap: space.md,
  },
  iconRow: { alignItems: 'center', marginBottom: space.sm },
  title: { ...t.title, color: color.ink, textAlign: 'center' },
  sub: { ...t.body, color: color.mute, textAlign: 'center' },
  rule: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.sm },
  ruleTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  ruleSub: { ...t.small, color: color.mute, lineHeight: 18 },
  btn: {
    backgroundColor: color.ink, borderRadius: radius.md,
    paddingVertical: space.md, alignItems: 'center', marginTop: space.sm,
  },
  btnText: { ...t.bodyStrong, color: color.onInk },
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
