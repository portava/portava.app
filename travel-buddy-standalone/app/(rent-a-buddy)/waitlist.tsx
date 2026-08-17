import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, TextInput, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, Bell, MapPin, CheckCircle, Calendar, Clock } from 'lucide-react-native';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import type { Place } from '../../src/lib/location/placeTypes';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalTimePicker } from '../../src/components/selectors/GlobalTimePicker';
import { formatDisplayDate, fromISODate, fromHHmm, formatDisplayTime } from '../../src/lib/dateTime/formatters';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import { Stamp } from '../../src/components/ui';
import { joinWaitlist, type BuddyCategory, bookingErrorCopy } from '../../src/services/rentABuddy';
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

const BUDGETS = ['Under $20/hr', '$20–$40/hr', '$40–$70/hr', 'Flexible'];

export default function RentABuddyWaitlist() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ city?: string }>();

  const [city, setCity] = useState(params.city ?? '');
  const [cityCoords, setCityCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<BuddyCategory | null>(null);
  const [desiredDate, setDesiredDate] = useState('');
  const [desiredTime, setDesiredTime] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [budget, setBudget] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const canSubmit = city.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const res = await joinWaitlist(city.trim(), selectedCategory ?? undefined, cityCoords ?? undefined, {
      desiredDate: desiredDate || undefined,
      desiredTime: desiredTime || undefined,
      budgetUsd: budget ? Number.parseFloat(budget) : undefined,
      notes: notes.trim() || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      Alert.alert('Error', bookingErrorCopy(res.error));
      return;
    }
    // The API doesn't return a queue position — never invent one. The
    // confirmation screen simply omits the position card when null.
    setQueuePosition(null);
    setConfirmed(true);
  };

  if (confirmed) {
    return (
      <View style={[styles.page, styles.confirmedPage]}>
        <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
          <Pressable style={styles.backBtn} onPress={() => router.push('/(rent-a-buddy)/' as any)}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Waitlist</Text>
        </View>

        <View style={styles.confirmedBody}>
          <View style={styles.confirmedIcon}>
            <CheckCircle size={48} color={color.success} />
          </View>
          <Stamp label="You're on the list" tone="signal" rotate={-2} style={{ marginBottom: space.md }} />
          <Text style={styles.confirmedTitle}>We'll find you a Buddy</Text>
          <Text style={styles.confirmedSub}>
            You're in the queue for {city}
            {selectedCategory ? ` — ${CATEGORIES.find(c => c.key === selectedCategory)?.label}` : ''}.
          </Text>

          {queuePosition != null && (
            <View style={styles.positionCard}>
              <Text style={styles.positionLabel}>YOUR POSITION</Text>
              <Text style={styles.positionNumber}>#{queuePosition}</Text>
              <Text style={styles.positionSub}>in the {city} waitlist</Text>
            </View>
          )}

          <Text style={styles.notifyText}>
            We'll send you a push notification as soon as a verified Buddy is available for your criteria.
          </Text>

          <Pressable
            style={styles.backHomeBtn}
            onPress={() => router.push('/(rent-a-buddy)/' as any)}
          >
            <Text style={styles.backHomeBtnText}>Back to Rent a Buddy</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Join Waitlist</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.intro}>
          <Bell size={24} color={color.signal} />
          <Text style={styles.introTitle}>No Buddies available yet</Text>
          <Text style={styles.introSub}>
            Join the waitlist and we'll notify you the moment a verified Buddy matches your criteria in this city.
          </Text>
        </View>

        {/* City */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>City *</Text>
          <View style={styles.inputRow}>
            <MapPin size={14} color={color.mute} />
            <Pressable style={{ flex: 1 }} onPress={() => setCityPickerOpen(true)}>
              <Text style={[styles.input, !city && { color: color.haze }]} numberOfLines={1}>
                {city || 'Which city are you visiting?'}
              </Text>
            </Pressable>
          </View>
        </View>

        <GlobalPlacePicker
          visible={cityPickerOpen}
          onClose={() => setCityPickerOpen(false)}
          onSelect={(place: Place) => {
            setCity(place.city ?? place.name);
            setCityCoords(place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null);
          }}
          mode="city"
          title="Which city are you visiting?"
          usedFor="buddy_waitlist"
        />

        {/* Category */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Type of Buddy (optional)</Text>
          <View style={styles.catGrid}>
            {CATEGORIES.map(cat => (
              <Pressable
                key={cat.key}
                style={[styles.catChip, selectedCategory === cat.key && styles.catChipActive]}
                onPress={() => setSelectedCategory(c => c === cat.key ? null : cat.key)}
              >
                <Text style={[styles.catChipText, selectedCategory === cat.key && styles.catChipTextActive]}>
                  {cat.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Desired date & time */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Desired date & time (optional)</Text>
          <View style={styles.dateTimeRow}>
            <Pressable style={[styles.inputRow, styles.dateInput]} onPress={() => setShowDatePicker(true)}>
              <Calendar size={14} color={desiredDate ? color.ink : color.mute} />
              <Text style={[styles.input, !desiredDate && { color: color.haze }]} numberOfLines={1}>
                {desiredDate
                  ? (() => { const d = fromISODate(desiredDate); return d ? formatDisplayDate(d) : desiredDate; })()
                  : 'Select date'}
              </Text>
            </Pressable>
            <Pressable style={[styles.inputRow, styles.timeInput]} onPress={() => setShowTimePicker(true)}>
              <Clock size={14} color={desiredTime ? color.ink : color.mute} />
              <Text style={[styles.input, !desiredTime && { color: color.haze }]} numberOfLines={1}>
                {desiredTime
                  ? (() => { const d = fromHHmm(desiredTime); return d ? formatDisplayTime(d) : desiredTime; })()
                  : 'Time'}
              </Text>
            </Pressable>
          </View>
          <GlobalCalendarPicker
            visible={showDatePicker}
            mode="single"
            value={desiredDate || null}
            title="Desired date"
            onConfirm={(v) => { setDesiredDate(v ?? ''); setShowDatePicker(false); }}
            onCancel={() => setShowDatePicker(false)}
          />
          <GlobalTimePicker
            visible={showTimePicker}
            value={desiredTime || null}
            title="Desired time"
            allowClear
            onChange={(v) => setDesiredTime(v ?? '')}
            onClose={() => setShowTimePicker(false)}
          />
        </View>

        {/* Budget */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Budget (optional)</Text>
          <View style={styles.budgetRow}>
            {BUDGETS.map(b => (
              <Pressable
                key={b}
                style={[styles.catChip, budget === b && styles.catChipActive]}
                onPress={() => setBudget(bv => bv === b ? '' : b)}
              >
                <Text style={[styles.catChipText, budget === b && styles.catChipTextActive]}>{b}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Notes */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Additional notes (optional)</Text>
          <TextInput
            style={styles.textArea}
            value={notes}
            onChangeText={setNotes}
            placeholder="Any specific needs or details for your Buddy search…"
            placeholderTextColor={color.haze}
            multiline
            numberOfLines={3}
          />
        </View>

        <View style={{ height: 120 + insets.bottom }} />
      </ScrollView>

      {/* Submit */}
      <View style={[styles.stickyBottom, { paddingBottom: insets.bottom + space.md }]}>
        <Bell size={16} color={color.onInk} />
        <Pressable
          style={({ pressed }) => [
            styles.submitBtn,
            !canSubmit && styles.submitBtnDisabled,
            pressed && canSubmit && { opacity: layout.pressedOpacity },
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          <Text style={styles.submitBtnText}>
            {submitting ? 'Joining…' : 'Notify me when a Buddy is matched'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  confirmedPage: {},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: color.ink },
  scroll: { padding: space.lg },
  intro: {
    alignItems: 'center', gap: space.sm, paddingVertical: space.xl,
    borderBottomWidth: 1, borderBottomColor: color.haze, marginBottom: space.lg,
  },
  introTitle: { ...t.title, color: color.ink, textAlign: 'center' },
  introSub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  field: { marginBottom: space.lg },
  fieldLabel: { ...t.small, fontWeight: '700', color: color.mute, marginBottom: space.sm, letterSpacing: 0.3, textTransform: 'uppercase' },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, height: 48, paddingHorizontal: space.md,
  },
  input: { ...t.body, color: color.ink, flex: 1 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  catChip: {
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  catChipActive: { backgroundColor: color.signal, borderColor: color.signal },
  catChipText: { ...t.small, fontWeight: '600', color: color.ink },
  catChipTextActive: { color: color.onInk },
  budgetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  dateTimeRow: { flexDirection: 'row', gap: space.sm },
  dateInput: { flex: 2 },
  timeInput: { flex: 1 },
  textArea: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.md, ...t.body, color: color.ink,
    height: 90, textAlignVertical: 'top',
  },
  stickyBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze,
    paddingHorizontal: space.lg, paddingTop: space.md,
    ...shadow.float,
  },
  submitBtn: { flex: 1, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  submitBtnDisabled: { backgroundColor: color.haze },
  submitBtnText: { ...t.bodyStrong, color: color.onInk },
  confirmedBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  confirmedIcon: { marginBottom: space.md },
  confirmedTitle: { ...t.title, color: color.ink, textAlign: 'center' },
  confirmedSub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  positionCard: {
    backgroundColor: color.ink, borderRadius: radius.lg, padding: space.xl,
    alignItems: 'center', width: '100%', ...shadow.float,
  },
  positionLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.onInkMute, letterSpacing: 2 },
  positionNumber: { fontSize: 56, fontWeight: '800', color: color.onInk, fontFamily: 'Courier', letterSpacing: -2 },
  positionSub: { ...t.small, color: color.onInkMute },
  notifyText: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  backHomeBtn: { backgroundColor: color.ink, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: space.md, marginTop: space.sm },
  backHomeBtnText: { ...t.bodyStrong, color: color.onInk },
});
