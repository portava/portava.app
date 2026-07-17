/**
 * EventComposerSheet — multi-step bottom sheet for creating or editing an Event.
 *
 * Steps:
 *   1. Basics   — title, description, dates
 *   2. Location — location name / place picker
 *   3. Settings — capacity, age, trust score, verified-only, visibility,
 *                 chat toggle, price field
 *   4. Review   — summary before publish/save-as-draft
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  ScrollView, Switch,
} from 'react-native';
import { X, ChevronRight, ChevronLeft, CalendarClock, MapPin, Settings2, Eye, Clock } from 'lucide-react-native';
import { createEvent, type CreateEventInput, type EventSummary, type EventVisibility } from '../services/events.ts';
import { GlobalCalendarPicker } from './selectors/GlobalCalendarPicker.tsx';
import { GlobalTimePicker } from './selectors/GlobalTimePicker.tsx';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';

interface Props {
  onDismiss: () => void;
  onCreated: (ev: EventSummary) => void;
}

type Step = 'basics' | 'location' | 'settings' | 'review';

const STEPS: Step[] = ['basics', 'location', 'settings', 'review'];
const STEP_LABELS: Record<Step, string> = {
  basics: 'Basics',
  location: 'Location',
  settings: 'Settings',
  review: 'Review',
};

const VISIBILITIES: { key: EventVisibility; label: string; desc: string }[] = [
  { key: 'public',      label: 'Public',      desc: 'Anyone can discover & RSVP' },
  { key: 'friends_only',label: 'Friends only', desc: 'Only your friends can see it' },
  { key: 'invite_only', label: 'Invite only',  desc: 'Requires your approval to join' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildISODateTime(dateISO: string | null, timeHHmm: string | null): string | undefined {
  if (!dateISO) return undefined;
  const timePart = timeHHmm ? `${timeHHmm}:00` : '00:00:00';
  return `${dateISO}T${timePart}`;
}

function formatDateDisplay(dateISO: string): string {
  return new Date(dateISO + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function formatTimeDisplay(hhMm: string): string {
  const [h, m] = hhMm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDateTimeReview(dateISO: string | null, timeHHmm: string | null): string {
  if (!dateISO) return 'Date TBD';
  const datePart = formatDateDisplay(dateISO);
  if (!timeHHmm) return datePart;
  return `${datePart} · ${formatTimeDisplay(timeHHmm)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EventComposerSheet({ onDismiss, onCreated }: Props) {
  const [step, setStep] = useState<Step>('basics');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);

  // Basics — dates use ISO strings; times use HH:mm
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDateStr, setStartDateStr] = useState<string | null>(null);
  const [startTime,    setStartTime]    = useState<string | null>(null);
  const [endDateStr,   setEndDateStr]   = useState<string | null>(null);
  const [endTime,      setEndTime]      = useState<string | null>(null);
  const [category, setCategory] = useState('');

  // Picker visibility
  const [calPickerFor,  setCalPickerFor]  = useState<'start' | 'end' | null>(null);
  const [timePickerFor, setTimePickerFor] = useState<'start' | 'end' | null>(null);

  // Location
  const [locationName, setLocationName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');

  // Settings
  const [maxAttendees, setMaxAttendees] = useState('');
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [trustScoreMin, setTrustScoreMin] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [visibility, setVisibility] = useState<EventVisibility>('public');
  const [chatEnabled, setChatEnabled] = useState(true);
  const [waitlistEnabled, setWaitlistEnabled] = useState(true);
  const [priceType, setPriceType] = useState<'free' | 'external'>('free');
  const [priceUrl, setPriceUrl] = useState('');

  const stepIndex = STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  function nextStep() {
    if (step === 'basics') {
      if (!title.trim()) { setError('Title is required'); return; }
      if (startDateStr && endDateStr) {
        const startISO = buildISODateTime(startDateStr, startTime);
        const endISO   = buildISODateTime(endDateStr,   endTime);
        if (startISO && endISO && endISO <= startISO) {
          setError('End date must be after start date');
          return;
        }
      }
    }
    setError(null);
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  }

  function prevStep() {
    setError(null);
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }

  async function handleSave(publishNow: boolean) {
    setSaving(true);
    setError(null);

    const input: CreateEventInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      locationName: locationName.trim() || undefined,
      city: city.trim() || undefined,
      country: country.trim() || undefined,
      startsAt: buildISODateTime(startDateStr, startTime),
      endsAt:   buildISODateTime(endDateStr,   endTime),
      category: category.trim() || undefined,
      maxAttendees: maxAttendees ? parseInt(maxAttendees) : undefined,
      ageMin: ageMin ? parseInt(ageMin) : undefined,
      ageMax: ageMax ? parseInt(ageMax) : undefined,
      trustScoreMin: trustScoreMin ? parseFloat(trustScoreMin) : undefined,
      verifiedOnly: verifiedOnly || undefined,
      visibility,
      chatEnabled,
      waitlistEnabled,
      priceType,
      priceUrl: priceType === 'external' && priceUrl.trim() ? priceUrl.trim() : undefined,
      publishNow,
    };

    const res = await createEvent(input);
    setSaving(false);
    if (!res.ok || !res.data) {
      setError(res.message ?? 'Failed to create event');
      return;
    }
    onCreated(res.data);
  }

  // ── Picker: today's ISO date as the minimum ────────────────────────────────
  const todayISO = new Date().toISOString().slice(0, 10);

  return (
    <KeyboardSafeScrollView style={s.kav}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.head}>
            <Text style={s.headTitle}>New Event</Text>
            <View style={s.stepIndicator}>
              {STEPS.map((st, i) => (
                <View key={st} style={[s.stepDot, i <= stepIndex && s.stepDotActive]} />
              ))}
            </View>
            <Pressable onPress={onDismiss} hitSlop={8}><X size={20} color={color.ink} /></Pressable>
          </View>

          <Text style={s.stepLabel}>{STEP_LABELS[step]}</Text>

          <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">

            {/* ── Step: Basics ── */}
            {step === 'basics' && (
              <>
                <Text style={s.label}>Title *</Text>
                <TextInput
                  style={s.input}
                  placeholder="e.g. Sunset hike at Mount Batang"
                  placeholderTextColor={color.faint}
                  value={title}
                  onChangeText={setTitle}
                  maxLength={200}
                  autoFocus
                />

                <Text style={s.label}>Description</Text>
                <TextInput
                  style={[s.input, s.textarea]}
                  placeholder="Tell people what to expect…"
                  placeholderTextColor={color.faint}
                  value={description}
                  onChangeText={setDescription}
                  maxLength={2000}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />

                <Text style={s.label}>Category</Text>
                <TextInput
                  style={s.input}
                  placeholder="e.g. Hiking, Food, Nightlife…"
                  placeholderTextColor={color.faint}
                  value={category}
                  onChangeText={setCategory}
                  maxLength={60}
                />

                {/* Start date */}
                <Text style={s.label}>Start date</Text>
                <Pressable style={[s.input, s.pickerTrigger]} onPress={() => setCalPickerFor('start')}>
                  <CalendarClock size={14} color={startDateStr ? color.ink : color.faint} />
                  <Text style={[s.pickerTriggerText, !startDateStr && s.placeholder]}>
                    {startDateStr ? formatDateDisplay(startDateStr) : 'Pick a start date'}
                  </Text>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>

                {/* Start time (optional) */}
                <Text style={s.label}>Start time (optional)</Text>
                <Pressable style={[s.input, s.pickerTrigger]} onPress={() => setTimePickerFor('start')}>
                  <Clock size={14} color={startTime ? color.ink : color.faint} />
                  <Text style={[s.pickerTriggerText, !startTime && s.placeholder]}>
                    {startTime ? formatTimeDisplay(startTime) : 'Pick a start time'}
                  </Text>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>

                {/* End date (optional) */}
                <Text style={s.label}>End date (optional)</Text>
                <Pressable style={[s.input, s.pickerTrigger]} onPress={() => setCalPickerFor('end')}>
                  <CalendarClock size={14} color={endDateStr ? color.ink : color.faint} />
                  <Text style={[s.pickerTriggerText, !endDateStr && s.placeholder]}>
                    {endDateStr ? formatDateDisplay(endDateStr) : 'Pick an end date'}
                  </Text>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>

                {/* End time (optional) */}
                <Text style={s.label}>End time (optional)</Text>
                <Pressable style={[s.input, s.pickerTrigger]} onPress={() => setTimePickerFor('end')}>
                  <Clock size={14} color={endTime ? color.ink : color.faint} />
                  <Text style={[s.pickerTriggerText, !endTime && s.placeholder]}>
                    {endTime ? formatTimeDisplay(endTime) : 'Pick an end time'}
                  </Text>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>
              </>
            )}

            {/* ── Step: Location ── */}
            {step === 'location' && (
              <>
                <Text style={s.label}>Location</Text>
                <Pressable style={[s.input, s.locationRow]} onPress={() => setLocationPickerVisible(true)}>
                  <MapPin size={14} color={color.mute} />
                  <Text style={[s.locationText, !locationName && s.placeholder]} numberOfLines={1}>
                    {locationName || 'Pick a location…'}
                  </Text>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>
                <GlobalPlacePicker
                  visible={locationPickerVisible}
                  title="Event location"
                  placeholder="City, venue or address…"
                  allowGPS
                  usedFor="event_location"
                  onSelect={(place) => {
                    setLocationName(place.displayName);
                    if (place.city) setCity(place.city);
                    if (place.country) setCountry(place.country);
                    setLocationPickerVisible(false);
                  }}
                  onClose={() => setLocationPickerVisible(false)}
                />

                <Text style={s.label}>City (optional)</Text>
                <TextInput
                  style={s.input}
                  placeholder="e.g. Cebu City"
                  placeholderTextColor={color.faint}
                  value={city}
                  onChangeText={setCity}
                  maxLength={100}
                />

                <Text style={s.label}>Country (optional)</Text>
                <TextInput
                  style={s.input}
                  placeholder="e.g. Philippines"
                  placeholderTextColor={color.faint}
                  value={country}
                  onChangeText={setCountry}
                  maxLength={100}
                />
              </>
            )}

            {/* ── Step: Settings ── */}
            {step === 'settings' && (
              <>
                <Text style={s.label}>Max attendees (optional)</Text>
                <TextInput
                  style={s.input}
                  placeholder="Leave blank for unlimited"
                  placeholderTextColor={color.faint}
                  value={maxAttendees}
                  onChangeText={setMaxAttendees}
                  keyboardType="numeric"
                  maxLength={6}
                />

                <Text style={s.label}>Age range (optional)</Text>
                <View style={s.row}>
                  <TextInput
                    style={[s.input, { flex: 1 }]}
                    placeholder="Min age"
                    placeholderTextColor={color.faint}
                    value={ageMin}
                    onChangeText={setAgeMin}
                    keyboardType="numeric"
                    maxLength={3}
                  />
                  <Text style={s.rangeSep}>–</Text>
                  <TextInput
                    style={[s.input, { flex: 1 }]}
                    placeholder="Max age"
                    placeholderTextColor={color.faint}
                    value={ageMax}
                    onChangeText={setAgeMax}
                    keyboardType="numeric"
                    maxLength={3}
                  />
                </View>

                <Text style={s.label}>Minimum trust score (0–100, optional)</Text>
                <TextInput
                  style={s.input}
                  placeholder="e.g. 60"
                  placeholderTextColor={color.faint}
                  value={trustScoreMin}
                  onChangeText={setTrustScoreMin}
                  keyboardType="numeric"
                  maxLength={5}
                />

                <View style={s.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.toggleLabel}>Verified users only</Text>
                    <Text style={s.toggleSub}>Only users with verified identity can join</Text>
                  </View>
                  <Switch value={verifiedOnly} onValueChange={setVerifiedOnly} />
                </View>

                <View style={s.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.toggleLabel}>Enable chat</Text>
                    <Text style={s.toggleSub}>Creates a group chat for attendees</Text>
                  </View>
                  <Switch value={chatEnabled} onValueChange={setChatEnabled} />
                </View>

                <View style={s.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.toggleLabel}>Enable waitlist</Text>
                    <Text style={s.toggleSub}>Allow people to queue when full</Text>
                  </View>
                  <Switch value={waitlistEnabled} onValueChange={setWaitlistEnabled} />
                </View>

                <Text style={s.label}>Visibility</Text>
                {VISIBILITIES.map((v) => (
                  <Pressable
                    key={v.key}
                    style={[s.visRow, visibility === v.key && s.visRowActive]}
                    onPress={() => setVisibility(v.key)}
                  >
                    <Eye size={16} color={visibility === v.key ? color.signal : color.mute} />
                    <View style={{ flex: 1 }}>
                      <Text style={[s.visLabel, visibility === v.key && s.visLabelActive]}>{v.label}</Text>
                      <Text style={s.visDesc}>{v.desc}</Text>
                    </View>
                    {visibility === v.key && (
                      <View style={s.visDot} />
                    )}
                  </Pressable>
                ))}

                <Text style={s.label}>Price</Text>
                <View style={s.row}>
                  {(['free', 'external'] as const).map((p) => (
                    <Pressable
                      key={p}
                      style={[s.priceBtn, priceType === p && s.priceBtnActive]}
                      onPress={() => setPriceType(p)}
                    >
                      <Text style={[s.priceBtnText, priceType === p && s.priceBtnTextActive]}>
                        {p === 'free' ? 'Free' : 'External link'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {priceType === 'external' && (
                  <TextInput
                    style={s.input}
                    placeholder="https://tickets.example.com/…"
                    placeholderTextColor={color.faint}
                    value={priceUrl}
                    onChangeText={setPriceUrl}
                    keyboardType="url"
                    autoCapitalize="none"
                  />
                )}
              </>
            )}

            {/* ── Step: Review ── */}
            {step === 'review' && (
              <>
                <View style={s.reviewCard}>
                  <Text style={s.reviewTitle}>{title}</Text>
                  {description ? <Text style={s.reviewDesc}>{description}</Text> : null}

                  <View style={s.reviewRow}>
                    <CalendarClock size={14} color={color.mute} />
                    <Text style={s.reviewMeta}>
                      {formatDateTimeReview(startDateStr, startTime)}
                    </Text>
                  </View>

                  {endDateStr ? (
                    <View style={s.reviewRow}>
                      <CalendarClock size={14} color={color.mute} />
                      <Text style={s.reviewMeta}>
                        {'Ends: ' + formatDateTimeReview(endDateStr, endTime)}
                      </Text>
                    </View>
                  ) : null}

                  {locationName ? (
                    <View style={s.reviewRow}>
                      <MapPin size={14} color={color.mute} />
                      <Text style={s.reviewMeta}>{locationName}{city ? `, ${city}` : ''}</Text>
                    </View>
                  ) : null}

                  <View style={s.reviewRow}>
                    <Eye size={14} color={color.mute} />
                    <Text style={s.reviewMeta}>{VISIBILITIES.find((v) => v.key === visibility)?.label}</Text>
                  </View>

                  {maxAttendees ? (
                    <View style={s.reviewRow}>
                      <Settings2 size={14} color={color.mute} />
                      <Text style={s.reviewMeta}>Max {maxAttendees} attendees</Text>
                    </View>
                  ) : null}
                </View>

                <Pressable
                  style={[s.publishBtn, saving && { opacity: 0.6 }]}
                  onPress={() => handleSave(true)}
                  disabled={saving}
                >
                  <Text style={s.publishBtnText}>{saving ? 'Publishing…' : 'Publish event'}</Text>
                </Pressable>

                <Pressable
                  style={[s.draftBtn, saving && { opacity: 0.6 }]}
                  onPress={() => handleSave(false)}
                  disabled={saving}
                >
                  <Text style={s.draftBtnText}>Save as draft</Text>
                </Pressable>
              </>
            )}

            {error ? <Text style={s.errorText}>{error}</Text> : null}
          </ScrollView>

          {/* Navigation */}
          <View style={s.nav}>
            {!isFirst && (
              <Pressable style={s.navBack} onPress={prevStep}>
                <ChevronLeft size={18} color={color.mute} />
                <Text style={s.navBackText}>Back</Text>
              </Pressable>
            )}
            <View style={{ flex: 1 }} />
            {!isLast && (
              <Pressable style={s.navNext} onPress={nextStep}>
                <Text style={s.navNextText}>Next</Text>
                <ChevronRight size={18} color={color.onInk} />
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* ── Date pickers (rendered outside ScrollView to avoid clipping) ── */}
      <GlobalCalendarPicker
        visible={calPickerFor === 'start'}
        mode="single"
        title="Start date"
        value={startDateStr ?? undefined}
        minDate={todayISO}
        allowPast={false}
        onConfirm={(iso) => { setStartDateStr(iso as string); setCalPickerFor(null); }}
        onCancel={() => setCalPickerFor(null)}
      />
      <GlobalCalendarPicker
        visible={calPickerFor === 'end'}
        mode="single"
        title="End date"
        value={endDateStr ?? undefined}
        minDate={startDateStr ?? todayISO}
        allowPast={false}
        onConfirm={(iso) => { setEndDateStr(iso as string); setCalPickerFor(null); }}
        onCancel={() => setCalPickerFor(null)}
      />
      <GlobalTimePicker
        visible={timePickerFor === 'start'}
        title="Start time"
        value={startTime}
        allowClear
        onChange={(v) => { setStartTime(v); }}
        onClose={() => setTimePickerFor(null)}
      />
      <GlobalTimePicker
        visible={timePickerFor === 'end'}
        title="End time"
        value={endTime}
        allowClear
        onChange={(v) => { setEndTime(v); }}
        onClose={() => setTimePickerFor(null)}
      />
    </KeyboardSafeScrollView>
  );
}

const s = StyleSheet.create({
  kav:        { position: 'absolute', inset: 0, zIndex: 100 },
  backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet:      { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%' },
  head:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.md },
  headTitle:  { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  stepIndicator:{ flexDirection: 'row', gap: 5 },
  stepDot:    { width: 6, height: 6, borderRadius: 3, backgroundColor: color.haze },
  stepDotActive:{ backgroundColor: color.signal },
  stepLabel:  { ...t.small, color: color.mute, fontWeight: '700', paddingHorizontal: space.lg, paddingTop: space.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  body:       { padding: space.lg, gap: space.sm, paddingBottom: space.xl },
  label:      { ...t.small, color: color.mute, fontWeight: '700', marginTop: space.sm },
  input:      { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: 10, ...t.body, color: color.ink },
  textarea:   { height: 90 },
  pickerTrigger:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickerTriggerText: { flex: 1, ...t.body, color: color.ink },
  placeholder:{ color: color.faint },
  locationRow:{ flexDirection: 'row', alignItems: 'center', gap: 8 },
  locationText:{ flex: 1, ...t.body, color: color.ink },
  row:        { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  rangeSep:   { ...t.body, color: color.mute },
  toggleRow:  { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  toggleLabel:{ ...t.body, color: color.ink, fontWeight: '600' },
  toggleSub:  { ...t.small, color: color.mute },
  visRow:     { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, marginBottom: space.xs },
  visRowActive:{ borderColor: color.signal, backgroundColor: '#F0FDF4' },
  visLabel:   { ...t.body, color: color.ink, fontWeight: '600' },
  visLabelActive:{ color: color.signal },
  visDesc:    { ...t.small, color: color.mute },
  visDot:     { width: 8, height: 8, borderRadius: 4, backgroundColor: color.signal },
  priceBtn:   { flex: 1, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center', backgroundColor: color.paper },
  priceBtnActive:{ borderColor: color.signal, backgroundColor: color.signal },
  priceBtnText:{ ...t.small, color: color.mute, fontWeight: '600' },
  priceBtnTextActive:{ color: color.onInk },
  reviewCard: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, marginBottom: space.lg },
  reviewTitle:{ ...t.title, color: color.ink, fontWeight: '800', fontSize: 18 },
  reviewDesc: { ...t.body, color: color.mute },
  reviewRow:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewMeta: { ...t.small, color: color.mute },
  publishBtn: { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', marginBottom: space.sm },
  publishBtnText:{ ...t.body, color: color.onInk, fontWeight: '700' },
  draftBtn:   { backgroundColor: color.paper, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  draftBtnText:{ ...t.body, color: color.mute, fontWeight: '600' },
  errorText:  { ...t.small, color: '#DC2626', textAlign: 'center', marginTop: space.sm },
  nav:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: color.haze, gap: space.md },
  navBack:    { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: space.sm },
  navBackText:{ ...t.body, color: color.mute, fontWeight: '600' },
  navNext:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill },
  navNextText:{ ...t.body, color: color.onInk, fontWeight: '700' },
});
