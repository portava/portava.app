/**
 * Create Event wizard — /events/create
 *
 * Full-screen 9-step wizard with auto-save to draft after every step.
 * Pass ?draftId=<id> to resume an existing draft (restores last incomplete step).
 *
 * Steps:
 *   1. Basics        — title, description, category
 *   2. Date & Time   — start/end datetime pickers
 *   3. Location      — place picker + city/country
 *   4. Capacity      — max attendees, join mode (open/approval/invite-only)
 *   5. Age/Trust     — min age, max age, trust score, verified-only, safety notes
 *   6. Privacy       — visibility, circle/trip context
 *   7. Tickets       — free vs external link
 *   8. Invite people — (coming soon stub)
 *   9. Preview       — summary + Publish / Save as draft
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Users, Lock, Clock, Shield, Ticket, UserPlus,
} from 'lucide-react-native';
import {
  createEvent, createDraft, updateDraft, publishDraft, getDraft,
  type EventVisibility, type EventRsvpStatus, type EventDraft,
} from '../../../src/services/events';
import { DatePickerField } from '../../../src/components/DateTimePickerField';
import { GlobalPlacePicker } from '../../../src/components/selectors/GlobalPlacePicker';
import { color, space, radius, type as t, shadow } from '../../../src/theme/tokens';

type Step = 'basics' | 'datetime' | 'location' | 'capacity' | 'age_trust' | 'privacy' | 'tickets' | 'invite' | 'preview';
const STEPS: Step[] = ['basics', 'datetime', 'location', 'capacity', 'age_trust', 'privacy', 'tickets', 'invite', 'preview'];
const STEP_LABELS: Record<Step, string> = {
  basics:    'Basics',
  datetime:  'Date & Time',
  location:  'Location',
  capacity:  'Capacity',
  age_trust: 'Age & Trust',
  privacy:   'Privacy',
  tickets:   'Tickets',
  invite:    'Invite People',
  preview:   'Preview',
};

const VISIBILITIES: { key: EventVisibility; label: string; desc: string; icon: any }[] = [
  { key: 'public',       label: 'Public',       desc: 'Anyone can discover & RSVP', icon: Eye },
  { key: 'friends_only', label: 'Friends only',  desc: 'Only your friends can see it', icon: Users },
  { key: 'invite_only',  label: 'Invite only',   desc: 'Requires your approval to join', icon: Lock },
];

const RSVP_OPTION_KEYS: { key: EventRsvpStatus; label: string; desc: string }[] = [
  { key: 'going',      label: 'Going',     desc: 'Attendee confirms attendance' },
  { key: 'maybe',      label: 'Maybe',     desc: 'Attendee is interested but not sure' },
  { key: 'interested', label: 'Interested', desc: 'Attendee wants to follow updates' },
  { key: 'cant_go',    label: "Can't go",  desc: 'Attendee declines but stays connected' },
];

type JoinMode = 'open' | 'approval' | 'invite_only';

export default function CreateEventScreen() {
  const insets = useSafeAreaInsets();
  const { draftId: draftIdParam, preLocation, preCircleId, preTripId, preTitle } =
    useLocalSearchParams<{ draftId?: string; preLocation?: string; preCircleId?: string; preTripId?: string; preTitle?: string }>();

  const [step, setStep] = useState<Step>('basics');
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(draftIdParam ?? null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Step 1: Basics ──────────────────────────────────────────────────────────
  const [title, setTitle] = useState(preTitle ?? '');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  // ── Step 2: Date/Time ───────────────────────────────────────────────────────
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);

  // ── Step 3: Location ────────────────────────────────────────────────────────
  const [locationName, setLocationName] = useState(preLocation ?? '');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [locationLat, setLocationLat] = useState<number | undefined>();
  const [locationLng, setLocationLng] = useState<number | undefined>();

  // ── Step 4: Capacity ────────────────────────────────────────────────────────
  const [maxAttendees, setMaxAttendees] = useState('');
  const [joinMode, setJoinMode] = useState<JoinMode>('open');
  const [waitlistEnabled, setWaitlistEnabled] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [rsvpOptions, setRsvpOptions] = useState<EventRsvpStatus[]>(['going', 'maybe', 'interested', 'cant_go']);

  // ── Step 5: Age/Trust ───────────────────────────────────────────────────────
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [trustScoreMin, setTrustScoreMin] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [safetyNotes, setSafetyNotes] = useState('');

  // ── Step 6: Privacy ─────────────────────────────────────────────────────────
  const [visibility, setVisibility] = useState<EventVisibility>('public');
  const [circleId, setCircleId] = useState<string | undefined>(preCircleId);
  const [tripId, setTripId] = useState<string | undefined>(preTripId);

  // ── Step 7: Tickets ─────────────────────────────────────────────────────────
  const [priceType, setPriceType] = useState<'free' | 'external'>('free');
  const [priceUrl, setPriceUrl] = useState('');

  const stepIndex = STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  // ── Load draft on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    if (draftIdParam) loadDraft(draftIdParam);
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
    if (d.circleId) setCircleId(d.circleId);
    if (d.tripId) setTripId(d.tripId);
    setChatEnabled(d.chatEnabled);
    setWaitlistEnabled(d.waitlistEnabled);
    if (d.priceType) setPriceType(d.priceType);
    if (d.priceUrl) setPriceUrl(d.priceUrl);
    // Restore last incomplete step based on filled fields
    if (!d.startsAt) { setStep('datetime'); return; }
    if (!d.locationName) { setStep('location'); return; }
    if (!d.maxAttendees) { setStep('capacity'); return; }
  }

  // ── Autosave ────────────────────────────────────────────────────────────────
  const scheduleSave = useCallback(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => saveDraftSilent(), 2500);
  }, []);

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
      circleId: circleId || undefined,
      tripId: tripId || undefined,
      chatEnabled,
      waitlistEnabled,
      priceType,
      priceUrl: priceType === 'external' && priceUrl.trim() ? priceUrl.trim() : undefined,
    };
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
    } catch { }
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  function nextStep() {
    if (step === 'basics' && !title.trim()) {
      setError('Title is required');
      return;
    }
    if (step === 'tickets' && priceType === 'external' && priceUrl && !priceUrl.startsWith('http')) {
      setError('Enter a valid URL starting with https://');
      return;
    }
    setError(null);
    saveDraftSilent();
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
          <Pressable onPress={handleDiscard} hitSlop={8} style={styles.headerBtn}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <View style={styles.headerMid}>
            <Text style={styles.headerTitle}>New Event</Text>
            {draftSavedAt && <Text style={styles.headerSaved}>Draft saved {draftSavedAt}</Text>}
          </View>
          <Pressable
            style={styles.headerBtn}
            onPress={handleSaveDraft}
            disabled={drafting || !title.trim()}
          >
            {drafting
              ? <ActivityIndicator size="small" color={color.mute} />
              : <FileEdit size={16} color={title.trim() ? color.ink : color.faint} />}
          </Pressable>
        </View>

        {/* Progress bar */}
        <View style={styles.stepBar}>
          {STEPS.map((st, i) => (
            <View key={st} style={[styles.stepSeg, i <= stepIndex && styles.stepSegActive]} />
          ))}
        </View>
        <View style={styles.stepLabelRow}>
          <Text style={styles.stepCounter}>Step {stepIndex + 1} of {STEPS.length}</Text>
          <Text style={styles.stepLabel}>{STEP_LABELS[step]}</Text>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── Step 1: Basics ── */}
          {step === 'basics' && (
            <>
              <Text style={styles.label}>Event title *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Sunset hike at Mount Batang"
                placeholderTextColor={color.faint}
                value={title}
                onChangeText={(v) => { setTitle(v); scheduleSave(); }}
                maxLength={200}
                autoFocus
              />
              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Tell people what to expect, what to bring, what's included…"
                placeholderTextColor={color.faint}
                value={description}
                onChangeText={(v) => { setDescription(v); scheduleSave(); }}
                maxLength={2000}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />
              <Text style={styles.label}>Category</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Hiking, Food, Nightlife, Music…"
                placeholderTextColor={color.faint}
                value={category}
                onChangeText={(v) => { setCategory(v); scheduleSave(); }}
                maxLength={60}
              />
            </>
          )}

          {/* ── Step 2: Date & Time ── */}
          {step === 'datetime' && (
            <>
              <Text style={styles.label}>Start date & time</Text>
              <DatePickerField
                value={startDate}
                onChange={(d) => { setStartDate(d); scheduleSave(); }}
                minimumDate={new Date()}
                placeholder="Pick a start date & time"
              />
              <Text style={styles.label}>End date & time (optional)</Text>
              <DatePickerField
                value={endDate}
                onChange={(d) => { setEndDate(d); scheduleSave(); }}
                minimumDate={startDate ?? new Date()}
                placeholder="Pick an end date & time"
              />
              {startDate && (
                <View style={styles.infoBox}>
                  <Clock size={14} color={color.mute} />
                  <Text style={styles.infoText}>
                    {startDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                    {endDate ? ` – ${endDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}
                  </Text>
                </View>
              )}
            </>
          )}

          {/* ── Step 3: Location ── */}
          {step === 'location' && (
            <>
              <Text style={styles.label}>Venue or location</Text>
              <Pressable
                style={[styles.input, styles.locationRow]}
                onPress={() => setLocationPickerVisible(true)}
              >
                <MapPin size={14} color={color.mute} />
                <Text style={[styles.locationText, !locationName && styles.placeholder]} numberOfLines={1}>
                  {locationName || 'Search for a venue, landmark, or address…'}
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
                  scheduleSave();
                }}
                onClose={() => setLocationPickerVisible(false)}
              />
              <Text style={styles.label}>City (optional — auto-filled from location)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Cebu City"
                placeholderTextColor={color.faint}
                value={city}
                onChangeText={(v) => { setCity(v); scheduleSave(); }}
                maxLength={100}
              />
              <Text style={styles.label}>Country (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Philippines"
                placeholderTextColor={color.faint}
                value={country}
                onChangeText={(v) => { setCountry(v); scheduleSave(); }}
                maxLength={100}
              />
            </>
          )}

          {/* ── Step 4: Capacity ── */}
          {step === 'capacity' && (
            <>
              <Text style={styles.label}>Max attendees (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="Leave blank for unlimited"
                placeholderTextColor={color.faint}
                value={maxAttendees}
                onChangeText={(v) => { setMaxAttendees(v); scheduleSave(); }}
                keyboardType="numeric"
                maxLength={6}
              />

              <Text style={styles.label}>How can people join?</Text>
              {([
                { key: 'open', label: 'Open RSVP', desc: 'Anyone can RSVP immediately' },
                { key: 'approval', label: 'Request to join', desc: 'You approve each attendee' },
                { key: 'invite_only', label: 'Invite only', desc: 'Only people you invite can join' },
              ] as { key: JoinMode; label: string; desc: string }[]).map((opt) => (
                <Pressable
                  key={opt.key}
                  style={[styles.optRow, joinMode === opt.key && styles.optRowActive]}
                  onPress={() => { setJoinMode(opt.key); scheduleSave(); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.optLabel, joinMode === opt.key && styles.optLabelActive]}>{opt.label}</Text>
                    <Text style={styles.optDesc}>{opt.desc}</Text>
                  </View>
                  {joinMode === opt.key && <View style={styles.optDot} />}
                </Pressable>
              ))}

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Enable waitlist</Text>
                  <Text style={styles.toggleSub}>Allow people to queue when capacity is full</Text>
                </View>
                <Switch value={waitlistEnabled} onValueChange={(v) => { setWaitlistEnabled(v); scheduleSave(); }} />
              </View>

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Enable group chat</Text>
                  <Text style={styles.toggleSub}>Creates a chat for confirmed attendees</Text>
                </View>
                <Switch value={chatEnabled} onValueChange={(v) => { setChatEnabled(v); scheduleSave(); }} />
              </View>

              <Text style={styles.label}>RSVP options for attendees</Text>
              {RSVP_OPTION_KEYS.map((opt) => {
                const active = rsvpOptions.includes(opt.key);
                return (
                  <Pressable
                    key={opt.key}
                    style={[styles.rsvpOptRow, active && styles.rsvpOptRowActive]}
                    onPress={() => {
                      if (active && rsvpOptions.length > 1) {
                        setRsvpOptions((prev) => prev.filter((k) => k !== opt.key));
                        scheduleSave();
                      } else if (!active) {
                        setRsvpOptions((prev) => [...prev, opt.key]);
                        scheduleSave();
                      }
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.optLabel, active && styles.optLabelActive]}>{opt.label}</Text>
                      <Text style={styles.optDesc}>{opt.desc}</Text>
                    </View>
                    {active && <Text style={styles.checkMark}>✓</Text>}
                  </Pressable>
                );
              })}
            </>
          )}

          {/* ── Step 5: Age & Trust ── */}
          {step === 'age_trust' && (
            <>
              <Text style={styles.label}>Age range (optional)</Text>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Min age"
                  placeholderTextColor={color.faint}
                  value={ageMin}
                  onChangeText={(v) => { setAgeMin(v); scheduleSave(); }}
                  keyboardType="numeric"
                  maxLength={3}
                />
                <Text style={styles.rangeSep}>–</Text>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="Max age"
                  placeholderTextColor={color.faint}
                  value={ageMax}
                  onChangeText={(v) => { setAgeMax(v); scheduleSave(); }}
                  keyboardType="numeric"
                  maxLength={3}
                />
              </View>
              {ageMin ? (
                <View style={styles.gatePreview}>
                  <Shield size={13} color="#059669" />
                  <Text style={styles.gatePreviewText}>
                    Shown on event card: "Ages {ageMin}+{ageMax ? `–${ageMax}` : ''}"
                  </Text>
                </View>
              ) : null}

              <Text style={styles.label}>Minimum trust score (0–100, optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 60 — users below this score cannot join"
                placeholderTextColor={color.faint}
                value={trustScoreMin}
                onChangeText={(v) => { setTrustScoreMin(v); scheduleSave(); }}
                keyboardType="numeric"
                maxLength={5}
              />

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Require verified identity</Text>
                  <Text style={styles.toggleSub}>Only users who verified their ID can join</Text>
                </View>
                <Switch value={verifiedOnly} onValueChange={(v) => { setVerifiedOnly(v); scheduleSave(); }} />
              </View>

              <Text style={styles.label}>Safety notes (optional)</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Rules, safety expectations, what to bring, emergency contact…"
                placeholderTextColor={color.faint}
                value={safetyNotes}
                onChangeText={(v) => { setSafetyNotes(v); scheduleSave(); }}
                maxLength={1000}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
              {safetyNotes ? (
                <View style={styles.safetyPreview}>
                  <Shield size={13} color="#7C3AED" />
                  <Text style={styles.safetyPreviewText}>This will appear as a "Safety notes" section on the event detail page.</Text>
                </View>
              ) : null}
            </>
          )}

          {/* ── Step 6: Privacy ── */}
          {step === 'privacy' && (
            <>
              <Text style={styles.label}>Who can see this event?</Text>
              {VISIBILITIES.map((v) => {
                const Icon = v.icon;
                return (
                  <Pressable
                    key={v.key}
                    style={[styles.optRow, visibility === v.key && styles.optRowActive]}
                    onPress={() => { setVisibility(v.key); scheduleSave(); }}
                  >
                    <Icon size={16} color={visibility === v.key ? color.signal : color.mute} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.optLabel, visibility === v.key && styles.optLabelActive]}>{v.label}</Text>
                      <Text style={styles.optDesc}>{v.desc}</Text>
                    </View>
                    {visibility === v.key && <View style={styles.optDot} />}
                  </Pressable>
                );
              })}

              {circleId && (
                <View style={styles.infoBox}>
                  <Lock size={14} color={color.mute} />
                  <Text style={styles.infoText}>This event is attached to a circle. Visibility defaults to circle members.</Text>
                </View>
              )}
              {tripId && (
                <View style={styles.infoBox}>
                  <MapPin size={14} color={color.mute} />
                  <Text style={styles.infoText}>This event is attached to a trip itinerary.</Text>
                </View>
              )}
            </>
          )}

          {/* ── Step 7: Tickets ── */}
          {step === 'tickets' && (
            <>
              <Text style={styles.label}>Is this event free or ticketed?</Text>
              <View style={styles.row}>
                {(['free', 'external'] as const).map((p) => (
                  <Pressable
                    key={p}
                    style={[styles.priceBtn, priceType === p && styles.priceBtnActive]}
                    onPress={() => { setPriceType(p); scheduleSave(); }}
                  >
                    <Ticket size={14} color={priceType === p ? color.onInk : color.mute} />
                    <Text style={[styles.priceBtnText, priceType === p && styles.priceBtnTextActive]}>
                      {p === 'free' ? 'Free' : 'Ticketed (external)'}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {priceType === 'external' ? (
                <>
                  <Text style={styles.label}>Ticket / booking link</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="https://tickets.example.com/…"
                    placeholderTextColor={color.faint}
                    value={priceUrl}
                    onChangeText={(v) => { setPriceUrl(v); scheduleSave(); }}
                    keyboardType="url"
                    autoCapitalize="none"
                  />
                  <View style={styles.infoBox}>
                    <Ticket size={14} color={color.mute} />
                    <Text style={styles.infoText}>
                      Travel Buddy does not process payments. Attendees will be directed to your external link for ticket purchase.
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.infoBox}>
                  <Ticket size={14} color={color.success} />
                  <Text style={[styles.infoText, { color: color.success }]}>This event is free — no ticket or payment required.</Text>
                </View>
              )}
            </>
          )}

          {/* ── Step 8: Invite People ── */}
          {step === 'invite' && (
            <View style={styles.comingSoon}>
              <UserPlus size={40} color={color.faint} />
              <Text style={styles.comingSoonTitle}>Invite people</Text>
              <Text style={styles.comingSoonText}>
                You can invite friends, circle members, and trip crew after publishing. Skip to preview your event.
              </Text>
            </View>
          )}

          {/* ── Step 9: Preview ── */}
          {step === 'preview' && (
            <>
              <View style={styles.reviewCard}>
                <Text style={styles.reviewTitle}>{title || 'Untitled event'}</Text>
                {description ? <Text style={styles.reviewDesc} numberOfLines={3}>{description}</Text> : null}

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
                    {endDate ? ` – ${endDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                  </Text>
                </View>

                {locationName ? (
                  <View style={styles.reviewRow}>
                    <MapPin size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>{locationName}{city ? `, ${city}` : ''}</Text>
                  </View>
                ) : null}

                {maxAttendees ? (
                  <View style={styles.reviewRow}>
                    <Users size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>Up to {maxAttendees} attendees</Text>
                  </View>
                ) : null}

                <View style={styles.reviewRow}>
                  <Eye size={13} color={color.mute} />
                  <Text style={styles.reviewMeta}>
                    {VISIBILITIES.find((v) => v.key === visibility)?.label ?? visibility}
                  </Text>
                </View>

                {priceType === 'external' ? (
                  <View style={styles.reviewRow}>
                    <Ticket size={13} color={color.mute} />
                    <Text style={styles.reviewMeta} numberOfLines={1}>Ticketed · {priceUrl || 'link pending'}</Text>
                  </View>
                ) : (
                  <View style={styles.reviewRow}>
                    <Ticket size={13} color={color.success} />
                    <Text style={[styles.reviewMeta, { color: color.success }]}>Free event</Text>
                  </View>
                )}

                {(ageMin || verifiedOnly || trustScoreMin) && (
                  <View style={styles.reviewRow}>
                    <Shield size={13} color="#7C3AED" />
                    <Text style={styles.reviewMeta}>
                      {[
                        ageMin && `Age ${ageMin}+`,
                        trustScoreMin && `Trust ≥${trustScoreMin}`,
                        verifiedOnly && 'Verified only',
                      ].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                )}
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

          {step !== 'preview' && error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>

        {/* Navigation */}
        <View style={[styles.nav, { paddingBottom: insets.bottom + space.sm }]}>
          {!isFirst ? (
            <Pressable style={styles.navBack} onPress={prevStep}>
              <ChevronLeft size={18} color={color.mute} />
              <Text style={styles.navBackText}>Back</Text>
            </Pressable>
          ) : <View style={styles.navBack} />}
          <View style={{ flex: 1 }} />
          {!isLast && (
            <Pressable style={styles.navNext} onPress={nextStep}>
              <Text style={styles.navNextText}>{step === 'invite' ? 'Skip to preview' : 'Next'}</Text>
              <ChevronRight size={18} color={color.onInk} />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:         { flex: 1, backgroundColor: color.paper },
  header:            { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  headerBtn:         { padding: 4 },
  headerMid:         { flex: 1 },
  headerTitle:       { ...t.title, color: color.ink, fontWeight: '800' },
  headerSaved:       { ...t.small, color: color.faint },
  stepBar:           { flexDirection: 'row', height: 4, backgroundColor: color.haze, gap: 1 },
  stepSeg:           { flex: 1, backgroundColor: color.haze },
  stepSegActive:     { backgroundColor: color.signal },
  stepLabelRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm },
  stepCounter:       { ...t.small, color: color.faint },
  stepLabel:         { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  body:              { padding: space.lg, gap: space.sm, paddingBottom: space.xxl },
  label:             { ...t.small, color: color.mute, fontWeight: '700', marginTop: space.sm },
  input:             { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: 10, ...t.body, color: color.ink },
  textarea:          { height: 100 },
  locationRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  locationText:      { flex: 1, ...t.body, color: color.ink },
  placeholder:       { color: color.faint },
  row:               { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  rangeSep:          { ...t.body, color: color.mute },
  infoBox:           { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md },
  infoText:          { ...t.small, color: color.mute, flex: 1, lineHeight: 18 },
  gatePreview:       { flexDirection: 'row', alignItems: 'center', gap: 6, padding: space.sm },
  gatePreviewText:   { ...t.small, color: '#059669', flex: 1 },
  safetyPreview:     { flexDirection: 'row', alignItems: 'flex-start', gap: 6, padding: space.sm },
  safetyPreviewText: { ...t.small, color: '#7C3AED', flex: 1, lineHeight: 18 },
  optRow:            { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, marginBottom: space.xs },
  optRowActive:      { borderColor: color.signal },
  optLabel:          { ...t.body, color: color.mute, fontWeight: '600' },
  optLabelActive:    { color: color.ink },
  optDesc:           { ...t.small, color: color.faint },
  optDot:            { width: 8, height: 8, borderRadius: 4, backgroundColor: color.signal },
  toggleRow:         { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  toggleLabel:       { ...t.body, color: color.ink, fontWeight: '600' },
  toggleSub:         { ...t.small, color: color.mute },
  rsvpOptRow:        { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, marginBottom: space.xs },
  rsvpOptRowActive:  { borderColor: color.signal },
  checkMark:         { ...t.body, color: color.signal },
  priceBtn:          { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  priceBtnActive:    { borderColor: color.signal, backgroundColor: color.signal },
  priceBtnText:      { ...t.small, color: color.mute, fontWeight: '600' },
  priceBtnTextActive:{ color: color.onInk },
  comingSoon:        { alignItems: 'center', paddingVertical: space.xxl, gap: space.md },
  comingSoonTitle:   { ...t.title, color: color.ink, fontWeight: '800' },
  comingSoonText:    { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 280 },
  reviewCard:        { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, marginBottom: space.md },
  reviewTitle:       { ...t.title, color: color.ink, fontWeight: '800', fontSize: 18 },
  reviewDesc:        { ...t.body, color: color.mute },
  reviewRow:         { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewMeta:        { ...t.small, color: color.mute, flex: 1 },
  errorText:         { ...t.small, color: '#DC2626', textAlign: 'center', marginTop: space.sm },
  publishBtn:        { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', marginBottom: space.sm, ...shadow.card },
  publishBtnText:    { ...t.body, color: color.onInk, fontWeight: '700' },
  saveDraftBtn:      { backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  saveDraftBtnText:  { ...t.body, color: color.mute, fontWeight: '600' },
  nav:               { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  navBack:           { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: space.sm, minWidth: 70 },
  navBackText:       { ...t.body, color: color.mute, fontWeight: '600' },
  navNext:           { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill },
  navNextText:       { ...t.body, color: color.onInk, fontWeight: '700' },
});
