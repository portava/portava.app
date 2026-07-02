/**
 * Create Event wizard — /events/create
 *
 * Full-screen 4-step wizard with auto-save to draft.
 * Pass ?draftId=<id> to resume an existing draft.
 *
 * Steps:
 *   1. Basics   — title, description, category, dates
 *   2. Location — place picker + city/country
 *   3. Settings — capacity, age, trust, verified, visibility, chat, waitlist, price
 *   4. Review   — summary before Publish or Save as draft
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  ScrollView, Switch, Alert, ActivityIndicator, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, ChevronRight, ChevronLeft,
  CalendarClock, MapPin, Settings2, Eye, FileEdit,
} from 'lucide-react-native';
import {
  createEvent, createDraft, updateDraft, publishDraft, getDraft,
  type EventVisibility, type EventRsvpStatus, type EventDraft,
} from '../../../src/services/events';
import { DatePickerField } from '../../../src/components/DateTimePickerField';
import { GlobalPlacePicker } from '../../../src/components/selectors/GlobalPlacePicker';
import { color, space, radius, type as t, shadow } from '../../../src/theme/tokens';

type Step = 'basics' | 'location' | 'settings' | 'review';
const STEPS: Step[] = ['basics', 'location', 'settings', 'review'];
const STEP_LABELS: Record<Step, string> = {
  basics: 'Basics',
  location: 'Location',
  settings: 'Settings',
  review: 'Review',
};

const VISIBILITIES: { key: EventVisibility; label: string; desc: string }[] = [
  { key: 'public',       label: 'Public',       desc: 'Anyone can discover & RSVP' },
  { key: 'friends_only', label: 'Friends only',  desc: 'Only your friends can see it' },
  { key: 'invite_only',  label: 'Invite only',   desc: 'Requires your approval to join' },
];

const RSVP_OPTION_KEYS: { key: EventRsvpStatus; label: string }[] = [
  { key: 'going',      label: 'Going' },
  { key: 'maybe',      label: 'Maybe' },
  { key: 'interested', label: 'Interested' },
  { key: 'cant_go',    label: "Can't go" },
];

export default function CreateEventScreen() {
  const insets = useSafeAreaInsets();
  const { draftId: draftIdParam } = useLocalSearchParams<{ draftId?: string }>();

  const [step, setStep] = useState<Step>('basics');
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(draftIdParam ?? null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);

  const [locationName, setLocationName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [locationLat, setLocationLat] = useState<number | undefined>();
  const [locationLng, setLocationLng] = useState<number | undefined>();

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
  const [rsvpOptions, setRsvpOptions] = useState<EventRsvpStatus[]>(['going', 'maybe', 'interested', 'cant_go']);

  const stepIndex = STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  // ── Load draft on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    if (draftIdParam) {
      loadDraft(draftIdParam);
    }
  }, [draftIdParam]);

  async function loadDraft(id: string) {
    const res = await getDraft(id);
    if (!res.ok || !res.data) return;
    const d = res.data;
    if (d.title) setTitle(d.title);
    if (d.description) setDescription(d.description);
    if (d.category) setCategory(d.category);
    if (d.startsAt) setStartDate(new Date(d.startsAt));
    if (d.endsAt) setEndDate(new Date(d.endsAt));
    if (d.locationName) setLocationName(d.locationName);
    if (d.city) setCity(d.city);
    if (d.country) setCountry(d.country);
    if (d.maxAttendees != null) setMaxAttendees(String(d.maxAttendees));
    if (d.ageMin != null) setAgeMin(String(d.ageMin));
    if (d.ageMax != null) setAgeMax(String(d.ageMax));
    if (d.trustScoreMin != null) setTrustScoreMin(String(d.trustScoreMin));
    if (d.verifiedOnly != null) setVerifiedOnly(d.verifiedOnly);
    if (d.visibility) setVisibility(d.visibility);
    setChatEnabled(d.chatEnabled);
    setWaitlistEnabled(d.waitlistEnabled);
    if (d.priceType) setPriceType(d.priceType);
    if (d.priceUrl) setPriceUrl(d.priceUrl);
  }

  // ── Autosave draft ──────────────────────────────────────────────────────────
  function scheduleAutosave() {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      saveDraftSilent();
    }, 2500);
  }

  async function saveDraftSilent() {
    if (!title.trim()) return;
    const payload = buildPayload();
    try {
      if (draftId) {
        await updateDraft(draftId, payload);
      } else {
        const res = await createDraft(payload);
        if (res.ok && res.data) setDraftId(res.data.id);
      }
      setDraftSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch {
    }
  }

  function buildPayload() {
    return {
      title: title.trim() || undefined,
      description: description.trim() || undefined,
      category: category.trim() || undefined,
      startsAt: startDate?.toISOString(),
      endsAt: endDate?.toISOString(),
      locationName: locationName.trim() || undefined,
      locationLat,
      locationLng,
      city: city.trim() || undefined,
      country: country.trim() || undefined,
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
    };
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  function nextStep() {
    if (step === 'basics' && !title.trim()) {
      setError('Title is required');
      return;
    }
    setError(null);
    scheduleAutosave();
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  }

  function prevStep() {
    setError(null);
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }

  // ── Save as draft ───────────────────────────────────────────────────────────
  async function handleSaveDraft() {
    setDrafting(true);
    setError(null);
    const payload = buildPayload();
    let ok = false;
    if (draftId) {
      const res = await updateDraft(draftId, payload);
      ok = res.ok;
      if (!ok) setError(res.message ?? 'Failed to save draft');
    } else {
      const res = await createDraft(payload);
      ok = res.ok;
      if (ok && res.data) setDraftId(res.data.id);
      else if (!ok) setError(res.message ?? 'Failed to save draft');
    }
    setDrafting(false);
    if (ok) {
      Alert.alert('Draft saved', 'You can resume this draft from the Events tab.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    }
  }

  // ── Publish ─────────────────────────────────────────────────────────────────
  async function handlePublish() {
    setSaving(true);
    setError(null);
    const payload = buildPayload();
    let eventId: string | undefined;

    if (draftId) {
      const res = await publishDraft(draftId, { ...payload, publishNow: true });
      if (!res.ok || !res.data) { setError(res.message ?? 'Failed to publish'); setSaving(false); return; }
      eventId = res.data.id;
    } else {
      const res = await createEvent({ ...payload, title: title.trim() || 'Untitled', publishNow: true });
      if (!res.ok || !res.data) { setError(res.message ?? 'Failed to publish'); setSaving(false); return; }
      eventId = res.data.id;
    }

    setSaving(false);
    router.replace(`/event/${eventId}` as any);
  }

  // ── Discard ──────────────────────────────────────────────────────────────────
  function handleDiscard() {
    Alert.alert('Discard event?', 'Your unsaved changes will be lost.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={handleDiscard} hitSlop={8} style={styles.backBtn}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <View style={styles.headerMid}>
            <Text style={styles.headerTitle}>New Event</Text>
            {draftSavedAt && (
              <Text style={styles.headerSaved}>Draft saved {draftSavedAt}</Text>
            )}
          </View>
          <Pressable
            style={styles.draftBtn}
            onPress={handleSaveDraft}
            disabled={drafting || !title.trim()}
          >
            {drafting
              ? <ActivityIndicator size="small" color={color.mute} />
              : <FileEdit size={16} color={title.trim() ? color.ink : color.faint} />
            }
          </Pressable>
        </View>

        {/* Step indicator */}
        <View style={styles.stepBar}>
          {STEPS.map((st, i) => (
            <View key={st} style={[styles.stepSeg, i <= stepIndex && styles.stepSegActive]} />
          ))}
        </View>
        <Text style={styles.stepLabel}>{STEP_LABELS[step]}</Text>

        {/* Body */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── Step: Basics ── */}
          {step === 'basics' && (
            <>
              <Text style={styles.label}>Title *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Sunset hike at Mount Batang"
                placeholderTextColor={color.faint}
                value={title}
                onChangeText={(v) => { setTitle(v); scheduleAutosave(); }}
                maxLength={200}
                autoFocus
              />

              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Tell people what to expect…"
                placeholderTextColor={color.faint}
                value={description}
                onChangeText={(v) => { setDescription(v); scheduleAutosave(); }}
                maxLength={2000}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />

              <Text style={styles.label}>Category</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Hiking, Food, Nightlife…"
                placeholderTextColor={color.faint}
                value={category}
                onChangeText={(v) => { setCategory(v); scheduleAutosave(); }}
                maxLength={60}
              />

              <Text style={styles.label}>Start date & time</Text>
              <DatePickerField
                value={startDate}
                onChange={(d) => { setStartDate(d); scheduleAutosave(); }}
                minimumDate={new Date()}
                placeholder="Pick a start date"
              />

              <Text style={styles.label}>End date & time (optional)</Text>
              <DatePickerField
                value={endDate}
                onChange={(d) => { setEndDate(d); scheduleAutosave(); }}
                minimumDate={startDate ?? new Date()}
                placeholder="Pick an end date"
              />
            </>
          )}

          {/* ── Step: Location ── */}
          {step === 'location' && (
            <>
              <Text style={styles.label}>Location</Text>
              <Pressable
                style={[styles.input, styles.locationRow]}
                onPress={() => setLocationPickerVisible(true)}
              >
                <MapPin size={14} color={color.mute} />
                <Text
                  style={[styles.locationText, !locationName && styles.placeholder]}
                  numberOfLines={1}
                >
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
                  if (place.lat != null) setLocationLat(place.lat);
                  if (place.lng != null) setLocationLng(place.lng);
                  setLocationPickerVisible(false);
                  scheduleAutosave();
                }}
                onClose={() => setLocationPickerVisible(false)}
              />

              <Text style={styles.label}>City (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Cebu City"
                placeholderTextColor={color.faint}
                value={city}
                onChangeText={(v) => { setCity(v); scheduleAutosave(); }}
                maxLength={100}
              />

              <Text style={styles.label}>Country (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Philippines"
                placeholderTextColor={color.faint}
                value={country}
                onChangeText={(v) => { setCountry(v); scheduleAutosave(); }}
                maxLength={100}
              />
            </>
          )}

          {/* ── Step: Settings ── */}
          {step === 'settings' && (
            <>
              <Text style={styles.label}>Max attendees (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="Leave blank for unlimited"
                placeholderTextColor={color.faint}
                value={maxAttendees}
                onChangeText={setMaxAttendees}
                keyboardType="numeric"
                maxLength={6}
              />

              <Text style={styles.label}>Age range (optional)</Text>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Min age"
                  placeholderTextColor={color.faint}
                  value={ageMin}
                  onChangeText={setAgeMin}
                  keyboardType="numeric"
                  maxLength={3}
                />
                <Text style={styles.rangeSep}>–</Text>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Max age"
                  placeholderTextColor={color.faint}
                  value={ageMax}
                  onChangeText={setAgeMax}
                  keyboardType="numeric"
                  maxLength={3}
                />
              </View>

              <Text style={styles.label}>Minimum trust score (0–100, optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 60"
                placeholderTextColor={color.faint}
                value={trustScoreMin}
                onChangeText={setTrustScoreMin}
                keyboardType="numeric"
                maxLength={5}
              />

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Verified users only</Text>
                  <Text style={styles.toggleSub}>Only users with verified identity can join</Text>
                </View>
                <Switch value={verifiedOnly} onValueChange={setVerifiedOnly} />
              </View>

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Enable chat</Text>
                  <Text style={styles.toggleSub}>Creates a group chat for attendees</Text>
                </View>
                <Switch value={chatEnabled} onValueChange={setChatEnabled} />
              </View>

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Enable waitlist</Text>
                  <Text style={styles.toggleSub}>Allow people to queue when full</Text>
                </View>
                <Switch value={waitlistEnabled} onValueChange={setWaitlistEnabled} />
              </View>

              <Text style={styles.label}>Visibility</Text>
              {VISIBILITIES.map((v) => (
                <Pressable
                  key={v.key}
                  style={[styles.visRow, visibility === v.key && styles.visRowActive]}
                  onPress={() => setVisibility(v.key)}
                >
                  <Eye size={16} color={visibility === v.key ? color.signal : color.mute} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.visLabel, visibility === v.key && styles.visLabelActive]}>
                      {v.label}
                    </Text>
                    <Text style={styles.visDesc}>{v.desc}</Text>
                  </View>
                  {visibility === v.key && <View style={styles.visDot} />}
                </Pressable>
              ))}

              <Text style={styles.label}>RSVP options</Text>
              {RSVP_OPTION_KEYS.map((opt) => {
                const active = rsvpOptions.includes(opt.key);
                return (
                  <Pressable
                    key={opt.key}
                    style={[styles.rsvpOptRow, active && styles.rsvpOptRowActive]}
                    onPress={() => {
                      if (active && rsvpOptions.length > 1) {
                        setRsvpOptions((prev) => prev.filter((k) => k !== opt.key));
                      } else if (!active) {
                        setRsvpOptions((prev) => [...prev, opt.key]);
                      }
                    }}
                  >
                    <Text style={[styles.rsvpOptText, active && styles.rsvpOptTextActive]}>
                      {opt.label}
                    </Text>
                    {active && <Text style={styles.rsvpOptCheck}>✓</Text>}
                  </Pressable>
                );
              })}

              <Text style={styles.label}>Price</Text>
              <View style={styles.row}>
                {(['free', 'external'] as const).map((p) => (
                  <Pressable
                    key={p}
                    style={[styles.priceBtn, priceType === p && styles.priceBtnActive]}
                    onPress={() => setPriceType(p)}
                  >
                    <Text style={[styles.priceBtnText, priceType === p && styles.priceBtnTextActive]}>
                      {p === 'free' ? 'Free' : 'External link'}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {priceType === 'external' && (
                <TextInput
                  style={styles.input}
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
              <View style={styles.reviewCard}>
                <Text style={styles.reviewTitle}>{title}</Text>
                {description ? <Text style={styles.reviewDesc}>{description}</Text> : null}

                {category ? (
                  <View style={styles.reviewRow}>
                    <Settings2 size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>{category}</Text>
                  </View>
                ) : null}

                <View style={styles.reviewRow}>
                  <CalendarClock size={13} color={color.mute} />
                  <Text style={styles.reviewMeta}>
                    {startDate
                      ? startDate.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                      : 'Date TBD'}
                  </Text>
                </View>

                {locationName ? (
                  <View style={styles.reviewRow}>
                    <MapPin size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>
                      {locationName}{city ? `, ${city}` : ''}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.reviewRow}>
                  <Eye size={13} color={color.mute} />
                  <Text style={styles.reviewMeta}>
                    {VISIBILITIES.find((v) => v.key === visibility)?.label}
                  </Text>
                </View>

                {maxAttendees ? (
                  <View style={styles.reviewRow}>
                    <Settings2 size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>Max {maxAttendees} attendees</Text>
                  </View>
                ) : null}

                {priceType === 'external' && priceUrl ? (
                  <View style={styles.reviewRow}>
                    <Settings2 size={13} color={color.mute} />
                    <Text style={styles.reviewMeta} numberOfLines={1}>Ticketed · {priceUrl}</Text>
                  </View>
                ) : null}
              </View>

              {error ? <Text style={styles.errorText}>{error}</Text> : null}

              <Pressable
                style={[styles.publishBtn, saving && { opacity: 0.6 }]}
                onPress={handlePublish}
                disabled={saving}
              >
                {saving
                  ? <ActivityIndicator color={color.onInk} />
                  : <Text style={styles.publishBtnText}>Publish event</Text>}
              </Pressable>

              <Pressable
                style={[styles.saveDraftBtn, drafting && { opacity: 0.6 }]}
                onPress={handleSaveDraft}
                disabled={drafting}
              >
                <Text style={styles.saveDraftBtnText}>Save as draft</Text>
              </Pressable>
            </>
          )}

          {step !== 'review' && error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>

        {/* Navigation */}
        <View style={[styles.nav, { paddingBottom: insets.bottom + space.sm }]}>
          {!isFirst && (
            <Pressable style={styles.navBack} onPress={prevStep}>
              <ChevronLeft size={18} color={color.mute} />
              <Text style={styles.navBackText}>Back</Text>
            </Pressable>
          )}
          {isFirst && <View style={styles.navBack} />}
          <View style={{ flex: 1 }} />
          {!isLast && (
            <Pressable style={styles.navNext} onPress={nextStep}>
              <Text style={styles.navNextText}>Next</Text>
              <ChevronRight size={18} color={color.onInk} />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: color.paper },
  header:          { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  backBtn:         { padding: 4 },
  headerMid:       { flex: 1 },
  headerTitle:     { ...t.title, color: color.ink, fontWeight: '800' },
  headerSaved:     { ...t.small, color: color.faint },
  draftBtn:        { padding: 6 },
  stepBar:         { flexDirection: 'row', height: 4, backgroundColor: color.haze, gap: 2 },
  stepSeg:         { flex: 1, backgroundColor: color.haze },
  stepSegActive:   { backgroundColor: color.signal },
  stepLabel:       { ...t.small, color: color.mute, fontWeight: '700', paddingHorizontal: space.lg, paddingTop: space.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  body:            { padding: space.lg, gap: space.sm, paddingBottom: space.xxl },
  label:           { ...t.small, color: color.mute, fontWeight: '700', marginTop: space.sm },
  input:           { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: 10, ...t.body, color: color.ink },
  textarea:        { height: 90 },
  locationRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  locationText:    { flex: 1, ...t.body, color: color.ink },
  placeholder:     { color: color.faint },
  row:             { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  rangeSep:        { ...t.body, color: color.mute },
  toggleRow:       { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  toggleLabel:     { ...t.body, color: color.ink, fontWeight: '600' },
  toggleSub:       { ...t.small, color: color.mute },
  visRow:          { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, marginBottom: space.xs },
  visRowActive:    { borderColor: color.signal, backgroundColor: '#F0FDF4' },
  visLabel:        { ...t.body, color: color.ink, fontWeight: '600' },
  visLabelActive:  { color: color.signal },
  visDesc:         { ...t.small, color: color.mute },
  visDot:          { width: 8, height: 8, borderRadius: 4, backgroundColor: color.signal },
  rsvpOptRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, marginBottom: space.xs },
  rsvpOptRowActive:{ borderColor: color.signal },
  rsvpOptText:     { ...t.body, color: color.mute },
  rsvpOptTextActive:{ color: color.ink, fontWeight: '600' },
  rsvpOptCheck:    { ...t.body, color: color.signal },
  priceBtn:        { flex: 1, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center', backgroundColor: color.paperRaised },
  priceBtnActive:  { borderColor: color.signal, backgroundColor: color.signal },
  priceBtnText:    { ...t.small, color: color.mute, fontWeight: '600' },
  priceBtnTextActive:{ color: color.onInk },
  reviewCard:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, marginBottom: space.md },
  reviewTitle:     { ...t.title, color: color.ink, fontWeight: '800', fontSize: 18 },
  reviewDesc:      { ...t.body, color: color.mute },
  reviewRow:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewMeta:      { ...t.small, color: color.mute, flex: 1 },
  errorText:       { ...t.small, color: '#DC2626', textAlign: 'center', marginTop: space.sm },
  publishBtn:      { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', marginBottom: space.sm, ...shadow.card },
  publishBtnText:  { ...t.body, color: color.onInk, fontWeight: '700' },
  saveDraftBtn:    { backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  saveDraftBtnText:{ ...t.body, color: color.mute, fontWeight: '600' },
  nav:             { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  navBack:         { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: space.sm, minWidth: 70 },
  navBackText:     { ...t.body, color: color.mute, fontWeight: '600' },
  navNext:         { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill },
  navNextText:     { ...t.body, color: color.onInk, fontWeight: '700' },
});
