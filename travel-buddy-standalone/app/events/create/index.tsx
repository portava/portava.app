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
  ScrollView, Switch, Alert, ActivityIndicator, Image, Platform,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import { router, useLocalSearchParams } from 'expo-router';
import { useMediaPicker } from '../../../src/hooks/useMediaPicker.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, ChevronRight, ChevronLeft,
  CalendarClock, MapPin, Settings2, Eye, FileEdit,
  Users, Lock, Clock, Shield, Ticket, UserPlus, Camera, X, Sparkles,
} from 'lucide-react-native';
import {
  createEvent, createDraft, updateDraft, publishDraft, getDraft, inviteUserToEvent,
  type EventVisibility, type EventRsvpStatus, type EventDraft,
} from '../../../src/services/events';
import { postCompassCreateSuggestions, type CompassCreateSuggestion } from '../../../src/services/compass';
import { getMyCircles, type CircleRow } from '../../../src/services/circles';
import { listMyTrips, type TripRow } from '../../../src/services/trips';
import { searchUsers, type TravelerSearchResult } from '../../../src/services/follows';
import { uploadMedia, validateMedia } from '../../../src/services/media';
import { formatEventLocation } from '../../../src/lib/location/formatEventLocation';
import { resolvePickedPlace } from '../../../src/lib/location/applyPickedPlace';
import { GlobalCalendarPicker } from '../../../src/components/selectors/GlobalCalendarPicker';
import { GlobalTimePicker } from '../../../src/components/selectors/GlobalTimePicker';
import {
  composeLocalDate, splitIso, defaultEndFor, validateEventTimes,
} from '../../../src/lib/eventDateTime';
import { GlobalPlacePicker } from '../../../src/components/selectors/GlobalPlacePicker';
import { Avatar } from '../../../src/components/ui';
import { color, space, radius, type as t, shadow, aspect, dot} from '../../../src/theme/tokens';
// Global Input Intelligence — Phase 5 (Creation). Inline, NON-BLOCKING duplicate
// detection (§20/§55) + §23 validation on the event title. Degrades to nothing
// when the (parallel-PR) endpoint is absent; never blocks or changes submit.
import { useCreationAssistance } from '../../../src/hooks/useCreationAssistance.ts';
import {
  CreationAssist,
  CREATION_FIELD_IDS,
  type DuplicateCandidate,
} from '../../../src/platform/input-assistance';

// ── Date/time display helpers ─────────────────────────────────────────────────

function formatDateLabel(dateStr: string): string {
  const d = composeLocalDate(dateStr, '12:00');
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : dateStr;
}

function formatTimeLabel(timeStr: string): string {
  const d = composeLocalDate('2000-01-01', timeStr);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : timeStr;
}

function todayLocalDateStr(): string {
  return splitIso(new Date().toISOString()).dateStr;
}

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
  { key: 'public',       label: 'Public',         desc: 'Anyone can discover & RSVP',                  icon: Eye },
  { key: 'friends_only', label: 'Friends only',    desc: 'Only your friends can see it',                icon: Users },
  { key: 'invite_only',  label: 'Invite only',     desc: 'Requires your approval to join',              icon: Lock },
  { key: 'circle',       label: 'Circle members',  desc: 'Only members of a selected circle can see it', icon: Users },
  { key: 'trip',         label: 'Trip crew',        desc: 'Only crew members of a selected trip',         icon: MapPin },
];

const RSVP_OPTION_KEYS: { key: EventRsvpStatus; label: string; desc: string }[] = [
  { key: 'going',      label: 'Going',     desc: 'Attendee confirms attendance' },
  { key: 'maybe',      label: 'Maybe',     desc: 'Attendee is interested but not sure' },
  { key: 'interested', label: 'Interested', desc: 'Attendee wants to follow updates' },
  { key: 'cant_go',    label: "Can't go",  desc: 'Attendee declines but stays connected' },
];

type JoinMode = 'open' | 'approval' | 'invite_only';

export default function CreateEventScreen() {
  const { pickMedia } = useMediaPicker();
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
  const [vibe, setVibe] = useState('');

  // ── Compass create-suggestions (category hints) ──────────────────────────────
  const [compassSuggestions, setCompassSuggestions] = useState<CompassCreateSuggestion[]>([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const compassSuggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Step 2: Date/Time ───────────────────────────────────────────────────────
  // Date and time are collected separately (shared calendar + clock pickers,
  // no manual text entry) and composed into local-timezone Date instants.
  const [startDateStr, setStartDateStr] = useState('');
  const [startTime, setStartTime]       = useState('');
  const [endDateStr, setEndDateStr]     = useState('');
  const [endTime, setEndTime]           = useState('');
  const [dtPicker, setDtPicker] = useState<null | 'startDate' | 'startTime' | 'endDate' | 'endTime'>(null);
  const startDate = composeLocalDate(startDateStr, startTime);
  const endDate   = composeLocalDate(endDateStr, endTime);

  // ── Step 3: Location ────────────────────────────────────────────────────────
  const [locationName, setLocationName] = useState(preLocation ?? '');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [locationLat, setLocationLat] = useState<number | undefined>();
  const [locationLng, setLocationLng] = useState<number | undefined>();
  // Destination timezone (from the selected place, e.g. Asia/Manila for
  // Cebu) — falls back to the device timezone only until a location has
  // been picked in Step 3, so Step 2's date/time display isn't misleading.
  const [locationTimezone, setLocationTimezone] = useState<string | null>(null);

  // §20/§55 — as the event is titled, surface likely-existing Events/Places so
  // the user can confirm the intended entity instead of creating a duplicate, plus
  // any §23 validation. NON-BLOCKING: advisory + dismissible; submit is unchanged.
  const titleAssist = useCreationAssistance({
    context: 'event_title',
    fieldId: CREATION_FIELD_IDS.eventTitle,
    text: title,
    sessionContext: { surface: 'event_create' },
  });
  const handlePickExistingEvent = useCallback((c: DuplicateCandidate) => {
    // §55 "user confirms intended entity" — route to the existing record to
    // verify. The in-progress draft is preserved; this never blocks creation.
    if (c.route) router.push(c.route as any);
  }, []);

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
  const [circles, setCircles] = useState<CircleRow[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [circlesLoading, setCirclesLoading] = useState(false);
  const [tripsLoading, setTripsLoading] = useState(false);
  // Show cover to non-members — only relevant for non-public events.
  // Auto-set to true when visibility is public; user controls it for private.
  const [showHeaderPublicly, setShowHeaderPublicly] = useState(false);

  // ── Step 7: Tickets ─────────────────────────────────────────────────────────
  const [priceType, setPriceType] = useState<'free' | 'external'>('free');
  const [priceUrl, setPriceUrl] = useState('');

  // ── Cover photo ─────────────────────────────────────────────────────────────
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);

  // ── Step 8: Invite ──────────────────────────────────────────────────────────
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<TravelerSearchResult[]>([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const [inviteSending, setInviteSending] = useState<string | null>(null);
  const inviteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stepIndex = STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  // ── Load draft on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    if (draftIdParam) loadDraft(draftIdParam);
  }, [draftIdParam]);

  // ── Compass category hints — debounced on title change ───────────────────────
  useEffect(() => {
    if (compassSuggestTimer.current) clearTimeout(compassSuggestTimer.current);
    if (title.trim().length < 3) { setCompassSuggestions([]); return; }
    compassSuggestTimer.current = setTimeout(() => {
      postCompassCreateSuggestions({ type: 'event', titleDraft: title.trim() })
        .then((res) => {
          if (res.ok && res.suggestions) {
            setCompassSuggestions(res.suggestions);
            setDismissedSuggestions(new Set());
          }
        })
        .catch(() => {});
    }, 600);
    return () => {
      if (compassSuggestTimer.current) clearTimeout(compassSuggestTimer.current);
    };
  }, [title]);

  async function loadDraft(id: string) {
    const res = await getDraft(id);
    if (!res.ok || !res.data) return;
    const d = res.data;
    if (d.title) setTitle(d.title);
    if (d.description) setDescription(d.description);
    if (d.category) setCategory(d.category);
    if (d.startsAt) {
      const p = splitIso(d.startsAt);
      setStartDateStr(p.dateStr); setStartTime(p.timeStr);
    }
    if (d.endsAt) {
      const p = splitIso(d.endsAt);
      setEndDateStr(p.dateStr); setEndTime(p.timeStr);
    }
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
    if (d.showHeaderPublicly != null) setShowHeaderPublicly(d.showHeaderPublicly);
    setChatEnabled(d.chatEnabled);
    setWaitlistEnabled(d.waitlistEnabled);
    if (d.priceType) setPriceType(d.priceType);
    if (d.priceUrl) setPriceUrl(d.priceUrl);
    if (d.coverUrl) { setCoverUrl(d.coverUrl); setCoverUri(d.coverUrl); }
    // Restore the last incomplete step across all 9 steps.
    // Walk forward through the step sequence and stop at the first gap.
    // Step 1 — basics: title is required
    if (!d.title) { setStep('basics'); return; }
    // Step 2 — datetime: start date required
    if (!d.startsAt) { setStep('datetime'); return; }
    // Step 3 — location: locationName required
    if (!d.locationName) { setStep('location'); return; }
    // Step 4 — capacity: maxAttendees required (joinMode has a default so skip)
    if (d.maxAttendees == null) { setStep('capacity'); return; }
    // Step 5 — age/trust: considered done even if all blank (all optional)
    //   However if the field was explicitly cleared (null vs undefined) we can't
    //   tell, so we treat step 5 as always visited once capacity is set.
    // Step 6 — privacy: visibility has a default ('public') so check if it
    //   was explicitly saved to the draft (non-null).
    if (!d.visibility) { setStep('privacy'); return; }
    // Step 7 — tickets: priceType has a default ('free'); if missing, resume here.
    if (!d.priceType) { setStep('tickets'); return; }
    // Step 8 — invite: optional step; skip to preview if already reached tickets.
    // Step 9 — preview: default landing if all prior steps are satisfied.
    setStep('preview');
  }

  // ── Autosave ────────────────────────────────────────────────────────────────
  const scheduleSave = useCallback(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => saveDraftSilent(), 2500);
  }, []);

  // ── Load circles + trips when entering the Privacy step ─────────────────────
  useEffect(() => {
    if (step !== 'privacy') return;
    if (circles.length === 0 && !circlesLoading) {
      setCirclesLoading(true);
      getMyCircles().then((c) => { setCircles(c); setCirclesLoading(false); });
    }
    if (trips.length === 0 && !tripsLoading) {
      setTripsLoading(true);
      listMyTrips().then((t) => { setTrips(t); setTripsLoading(false); });
    }
  }, [step]);

  // ── Cover photo picker ───────────────────────────────────────────────────────
  async function handlePickCoverPhoto() {
    const assets = await pickMedia({
      title: 'Add cover photo',
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.85,
    });
    if (!assets?.[0]) return;
    const asset = assets[0];
    setCoverUri(asset.uri);
    setCoverUrl(null);
    setCoverUploading(true);
    const media = {
      uri: asset.uri,
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileName: asset.fileName,
      fileSize: asset.fileSize,
      width: asset.width,
      height: asset.height,
      type: 'image' as const,
    };
    const validation = validateMedia(media);
    if (!validation.ok) {
      Alert.alert('Photo error', validation.message);
      setCoverUri(null);
      setCoverUploading(false);
      return;
    }
    const up = await uploadMedia(media);
    setCoverUploading(false);
    if (!up.ok || !up.url) {
      const uploadMsg =
        up.errorKind === 'rate_limited' ? 'Too many uploads — please wait a moment and try again.' :
        up.errorKind === 'invalid_payload' ? "This file couldn't be read — try a different photo." :
        (up.message ?? 'Could not upload cover photo');
      Alert.alert('Upload failed', uploadMsg);
      setCoverUri(null);
      return;
    }
    setCoverUrl(up.url);
    scheduleSave();
  }

  function handleRemoveCoverPhoto() {
    setCoverUri(null);
    setCoverUrl(null);
    scheduleSave();
  }

  // ── Visibility setter — clears orphaned circleId/tripId ─────────────────────
  function handleSetVisibility(v: EventVisibility) {
    if (v !== 'circle') setCircleId(undefined);
    if (v !== 'trip')   setTripId(undefined);
    setVisibility(v);
    // Public events always show header publicly; private ones default to hidden.
    if (v === 'public') setShowHeaderPublicly(true);
    else setShowHeaderPublicly(false);
    scheduleSave();
  }

  // ── Invite search ───────────────────────────────────────────────────────────
  function handleInviteQueryChange(q: string) {
    setInviteQuery(q);
    if (inviteTimer.current) clearTimeout(inviteTimer.current);
    if (!q.trim()) { setInviteResults([]); return; }
    inviteTimer.current = setTimeout(async () => {
      setInviteSearching(true);
      const res = await searchUsers(q.trim());
      setInviteResults(res.ok ? (res.data ?? []) : []);
      setInviteSearching(false);
    }, 400);
  }

  async function handleSendInvite(user: TravelerSearchResult) {
    if (!draftId) {
      // Need a draft first so we have an event id to invite against
      setInviteSending(user.id);
      const payload = buildPayload();
      const res = await createDraft(payload);
      if (!res.ok || !res.data) {
        setInviteSending(null);
        Alert.alert('Save draft first', res.message ?? 'Could not create draft to send invite.');
        return;
      }
      setDraftId(res.data.id);
      const invRes = await inviteUserToEvent(res.data.id, user.id);
      setInviteSending(null);
      if (invRes.ok) setInvitedIds((prev) => new Set([...prev, user.id]));
      else Alert.alert('Error', invRes.message ?? 'Could not send invite');
      return;
    }
    setInviteSending(user.id);
    const invRes = await inviteUserToEvent(draftId, user.id);
    setInviteSending(null);
    if (invRes.ok) setInvitedIds((prev) => new Set([...prev, user.id]));
    else Alert.alert('Error', invRes.message ?? 'Could not send invite');
  }

  function buildPayload() {
    return {
      title: title.trim() || undefined,
      description: description.trim() || undefined,
      category: category.trim() || undefined,
      vibe: vibe.trim() || undefined,
      startsAt: startDate?.toISOString(),
      endsAt: endDate?.toISOString(),
      locationName: locationName.trim() || undefined,
      locationLat,
      locationLng,
      timezone: locationTimezone || undefined,
      city: city.trim() || undefined,
      country: country.trim() || undefined,
      maxAttendees: maxAttendees ? parseInt(maxAttendees) : undefined,
      joinMode,
      rsvpOptions,
      ageMin: ageMin ? parseInt(ageMin) : undefined,
      ageMax: ageMax ? parseInt(ageMax) : undefined,
      trustScoreMin: trustScoreMin ? parseFloat(trustScoreMin) : undefined,
      verifiedOnly: verifiedOnly || undefined,
      safetyNotes: safetyNotes.trim() || undefined,
      visibility,
      circleId: circleId || undefined,
      tripId: tripId || undefined,
      chatEnabled,
      waitlistEnabled,
      priceType,
      priceUrl: priceType === 'external' && priceUrl.trim() ? priceUrl.trim() : undefined,
      coverUrl: coverUrl || undefined,
      showHeaderPublicly: visibility === 'public' ? true : showHeaderPublicly,
    };
  }

  async function saveDraftSilent() {
    if (!title.trim()) return;
    const payload = buildPayload();
    try {
      if (draftId) {
        const res = await updateDraft(draftId, payload);
        if (res.ok) setDraftSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      } else {
        const res = await createDraft(payload);
        if (res.ok && res.data) {
          setDraftId(res.data.id);
          setDraftSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        }
      }
    } catch { }
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  function nextStep() {
    if (step === 'basics' && !title.trim()) {
      setError('Title is required');
      return;
    }
    if (step === 'datetime') {
      const err = validateEventTimes(
        { dateStr: startDateStr, timeStr: startTime },
        { dateStr: endDateStr, timeStr: endTime },
      );
      if (err) { setError(err.message); return; }
    }
    if (step === 'privacy' && visibility === 'circle' && !circleId) {
      setError('Select a circle to scope this event to');
      return;
    }
    if (step === 'privacy' && visibility === 'trip' && !tripId) {
      setError('Select a trip to attach this event to');
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
    // Validate date/time before hitting the API so the error names the exact field.
    const dtErr = validateEventTimes(
      { dateStr: startDateStr, timeStr: startTime },
      { dateStr: endDateStr, timeStr: endTime },
    );
    if (dtErr) { setError(`Date & Time: ${dtErr.message}`); return; }

    // QA round 2, bug 5. PublishDraftSchema (api-server/src/routes/events.ts)
    // requires title, startsAt and locationName — but buildPayload() drops empty
    // strings with `|| undefined`, so the key never reaches the server and zod
    // answers with a bare "Required" that names no field. The user was left on
    // step 9 (Preview) with no idea that step 3 (Location) was the problem.
    // Validate here, name the field, and jump the wizard to the owning step.
    if (!title.trim()) {
      setError('Title is required.');
      setStep('basics');
      return;
    }
    if (!startDate) {
      setError('Start date & time are required.');
      setStep('datetime');
      return;
    }
    if (!locationName.trim()) {
      setError('Venue or location is required — pick a place on the Location step.');
      setStep('location');
      return;
    }

    setSaving(true);
    setError(null);
    const payload = buildPayload();
    let eventId: string | undefined;

    if (draftId) {
      const res = await publishDraft(draftId, { ...payload, publishNow: true });
      if (res.ok && res.data) {
        eventId = res.data.id;
      } else if (/not.?found|no longer|unavailable|does not exist/i.test(res.message ?? '')) {
        // Only fall back to direct creation when the draft itself is gone or the
        // drafts backend is unavailable — never for validation/business-rule
        // failures, which must surface to the user instead of being bypassed.
        const fallback = await createEvent({ ...payload, title: title.trim() || 'Untitled', publishNow: true });
        if (!fallback.ok || !fallback.data) { setError(fallback.message ?? 'Failed to publish'); setSaving(false); return; }
        eventId = fallback.data.id;
      } else {
        setError(res.message ?? 'Failed to publish');
        setSaving(false);
        return;
      }
    } else {
      const res = await createEvent({ ...payload, title: title.trim() || 'Untitled', publishNow: true });
      if (!res.ok || !res.data) { setError(res.message ?? 'Failed to publish'); setSaving(false); return; }
      eventId = res.data.id;
    }

    setSaving(false);
    router.replace(`/event/${eventId}` as any);
  }

  function handleDiscard() {
    // Nothing to lose yet (no draft autosaved, no title typed) — leave immediately,
    // no confirmation needed.
    if (!draftId && !title.trim()) {
      router.back();
      return;
    }

    const msg = draftId
      ? 'Your unsaved changes will be lost. The saved draft will remain in your drafts.'
      : 'Your unsaved changes will be lost. No draft will be created.';

    // Alert.alert has no native counterpart on web (react-native's Alert module
    // is a no-op there), which made this header button appear completely dead
    // in the web preview — tapping it fired handleDiscard but no dialog ever
    // rendered and router.back() never ran. Mirror the window.confirm fallback
    // already used in app/layover/[id].tsx for web.
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Discard changes?\n\n${msg}`)) {
        router.back();
      }
      return;
    }

    Alert.alert('Discard changes?', msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard', style: 'destructive',
        onPress: async () => {
          // If no draft exists yet (never autosaved), just leave without creating one
          router.back();
        },
      },
    ]);
  }

  return (
    <KeyboardSafeScrollView>
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
              {/* Cover photo picker */}
              <Text style={styles.label}>Cover photo</Text>
              <Pressable
                style={[styles.coverPicker, coverUri && styles.coverPickerFilled]}
                onPress={coverUploading ? undefined : handlePickCoverPhoto}
                disabled={coverUploading}
              >
                {coverUri ? (
                  <>
                    <Image source={{ uri: coverUri }} style={styles.coverPickerImage} resizeMode="cover" />
                    {coverUploading && (
                      <View style={styles.coverPickerOverlay}>
                        <ActivityIndicator color="#fff" />
                        <Text style={styles.coverUploadingText}>Uploading…</Text>
                      </View>
                    )}
                    {!coverUploading && (
                      <Pressable style={styles.coverRemoveBtn} onPress={handleRemoveCoverPhoto} hitSlop={10}>
                        <X size={14} color="#fff" />
                      </Pressable>
                    )}
                  </>
                ) : (
                  <View style={styles.coverPickerEmpty}>
                    <Camera size={28} color={color.mute} />
                    <Text style={styles.coverPickerHint}>Tap to add a cover photo</Text>
                    <Text style={styles.coverPickerSub}>16:9 ratio looks best</Text>
                  </View>
                )}
              </Pressable>
              {coverUrl && !coverUploading && (
                <View style={styles.coverUploadedRow}>
                  <Text style={styles.coverUploadedText}>✓ Cover photo uploaded</Text>
                </View>
              )}

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

              <CreationAssist
                duplicates={titleAssist.duplicates}
                validation={titleAssist.validation}
                onPickExisting={handlePickExistingEvent}
              />

              {/* ── Compass category hints ── */}
              {compassSuggestions.filter((s) => !dismissedSuggestions.has(s.category)).length > 0 && (
                <View style={styles.compassHintsRow}>
                  <View style={styles.compassHintsLabel}>
                    <Sparkles size={10} color={color.signal} />
                    <Text style={styles.compassHintsLabelText}>Compass suggests:</Text>
                  </View>
                  <View style={styles.compassChips}>
                    {compassSuggestions
                      .filter((s) => !dismissedSuggestions.has(s.category))
                      .map((s) => (
                        <View key={s.category} style={styles.compassChip}>
                          <Pressable
                            style={styles.compassChipInner}
                            onPress={() => {
                              setCategory(s.category);
                              if (s.vibe) setVibe(s.vibe);
                              setDismissedSuggestions((prev) => {
                                const next = new Set(prev);
                                next.add(s.category);
                                return next;
                              });
                              scheduleSave();
                            }}
                          >
                            <Text style={styles.compassChipText}>{s.category}</Text>
                          </Pressable>
                          <Pressable
                            hitSlop={6}
                            onPress={() => {
                              setDismissedSuggestions((prev) => {
                                const next = new Set(prev);
                                next.add(s.category);
                                return next;
                              });
                            }}
                          >
                            <X size={10} color={color.mute} />
                          </Pressable>
                        </View>
                      ))}
                  </View>
                </View>
              )}

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
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Pressable
                  style={[styles.input, styles.locationRow, { flex: 1.4 }]}
                  onPress={() => setDtPicker('startDate')}
                  accessibilityRole="button"
                  accessibilityLabel={startDateStr ? `Start date: ${formatDateLabel(startDateStr)}` : 'Pick a start date'}
                >
                  <CalendarClock size={14} color={startDateStr ? color.signal : color.faint} />
                  <Text style={[styles.locationText, !startDateStr && styles.placeholder]} numberOfLines={1}>
                    {startDateStr ? formatDateLabel(startDateStr) : 'Pick date'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.input, styles.locationRow, { flex: 1 }]}
                  onPress={() => setDtPicker('startTime')}
                  accessibilityRole="button"
                  accessibilityLabel={startTime ? `Start time: ${formatTimeLabel(startTime)}` : 'Pick a start time'}
                >
                  <Clock size={14} color={startTime ? color.signal : color.faint} />
                  <Text style={[styles.locationText, !startTime && styles.placeholder]} numberOfLines={1}>
                    {startTime ? formatTimeLabel(startTime) : 'Pick time'}
                  </Text>
                </Pressable>
              </View>

              <Text style={styles.label}>End date & time (optional)</Text>
              <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
                <Pressable
                  style={[styles.input, styles.locationRow, { flex: 1.4 }]}
                  onPress={() => setDtPicker('endDate')}
                  accessibilityRole="button"
                  accessibilityLabel={endDateStr ? `End date: ${formatDateLabel(endDateStr)}` : 'Pick an end date'}
                >
                  <CalendarClock size={14} color={endDateStr ? color.signal : color.faint} />
                  <Text style={[styles.locationText, !endDateStr && styles.placeholder]} numberOfLines={1}>
                    {endDateStr ? formatDateLabel(endDateStr) : 'Pick date'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.input, styles.locationRow, { flex: 1 }]}
                  onPress={() => setDtPicker('endTime')}
                  accessibilityRole="button"
                  accessibilityLabel={endTime ? `End time: ${formatTimeLabel(endTime)}` : 'Pick an end time'}
                >
                  <Clock size={14} color={endTime ? color.signal : color.faint} />
                  <Text style={[styles.locationText, !endTime && styles.placeholder]} numberOfLines={1}>
                    {endTime ? formatTimeLabel(endTime) : 'Pick time'}
                  </Text>
                </Pressable>
                {(endDateStr || endTime) ? (
                  <Pressable
                    hitSlop={8}
                    onPress={() => { setEndDateStr(''); setEndTime(''); scheduleSave(); }}
                    accessibilityRole="button"
                    accessibilityLabel="Clear end date and time"
                  >
                    <X size={15} color={color.mute} />
                  </Pressable>
                ) : null}
              </View>

              {startDate && (
                <View style={styles.infoBox}>
                  <Clock size={14} color={color.mute} />
                  <Text style={styles.infoText}>
                    {startDate.toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {endDate ? ` – ${endDate.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                    {` · ${locationTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`}
                    {!locationTimezone ? ' (device time — pick a location in Step 3 for local time)' : ''}
                  </Text>
                </View>
              )}

              <GlobalCalendarPicker
                mode="single"
                visible={dtPicker === 'startDate'}
                title="Start date"
                value={startDateStr || null}
                minDate={todayLocalDateStr()}
                onConfirm={(v) => {
                  if (v) setStartDateStr(v);
                  setDtPicker(null);
                  scheduleSave();
                }}
                onCancel={() => setDtPicker(null)}
              />
              <GlobalTimePicker
                visible={dtPicker === 'startTime'}
                title="Start time"
                value={startTime || '18:00'}
                onChange={(v) => { if (v) setStartTime(v); scheduleSave(); }}
                onClose={() => setDtPicker(null)}
              />
              <GlobalCalendarPicker
                mode="single"
                visible={dtPicker === 'endDate'}
                title="End date"
                value={endDateStr || startDateStr || null}
                minDate={startDateStr || todayLocalDateStr()}
                onConfirm={(v) => {
                  if (v) {
                    setEndDateStr(v);
                    // Default the end time to start + 2h so an equal start/end
                    // pair can never be produced by defaults.
                    if (!endTime && startDateStr && startTime) {
                      const def = defaultEndFor(startDateStr, startTime);
                      setEndTime(def.timeStr);
                      if (def.dateStr > v) setEndDateStr(def.dateStr);
                    }
                  }
                  setDtPicker(null);
                  scheduleSave();
                }}
                onCancel={() => setDtPicker(null)}
              />
              <GlobalTimePicker
                visible={dtPicker === 'endTime'}
                title="End time"
                value={endTime || (startDateStr && startTime ? defaultEndFor(startDateStr, startTime).timeStr : '20:00')}
                onChange={(v) => {
                  if (!v) return;
                  setEndTime(v);
                  // If no end date chosen yet, default to the start date —
                  // rolling to the next day for overnight events.
                  if (!endDateStr && startDateStr) {
                    const cand = composeLocalDate(startDateStr, v);
                    const s = composeLocalDate(startDateStr, startTime || '00:00');
                    if (cand && s && cand.getTime() <= s.getTime()) {
                      const next = new Date(s); next.setDate(next.getDate() + 1);
                      const pad = (n: number) => String(n).padStart(2, '0');
                      setEndDateStr(`${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`);
                    } else {
                      setEndDateStr(startDateStr);
                    }
                  }
                  scheduleSave();
                }}
                onClose={() => setDtPicker(null)}
              />
            </>
          )}

          {/* ── Step 3: Location ── */}
          {step === 'location' && (
            <>
              {/* QA round 2, bug 5: the server requires this field; the form never said so. */}
              <Text style={styles.label}>Venue or location *</Text>
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
                  // QA round 2, bug 6 — routed through the shared resolvePickedPlace
                  // rule (the same one gems/submit uses). Blank fields fill silently;
                  // a divergent typed spelling is reported as a CONFLICT the user is
                  // asked about, instead of being silently kept — which let divergent
                  // city/country spellings persist. Manual override is preserved.
                  const { fill, conflict, hasConflict } = resolvePickedPlace(place, { city, country });
                  if (fill.city) { setCity(fill.city); }
                  if (fill.country) { setCountry(fill.country); }
                  // Coordinates + timezone are §17 dependent fields, not free text,
                  // so they bind directly from the resolved place.
                  if (place.lat != null) setLocationLat(place.lat);
                  if (place.lng != null) setLocationLng(place.lng);
                  if (place.timezone) setLocationTimezone(place.timezone);
                  setLocationPickerVisible(false);
                  scheduleSave();
                  if (hasConflict) {
                    Alert.alert(
                      'Replace what you typed?',
                      `${place.displayName} is linked. Replace the location details you entered with its own?`,
                      [
                        { text: 'Keep mine', style: 'cancel' },
                        {
                          text: 'Use this place',
                          onPress: () => {
                            if (conflict.city) setCity(conflict.city);
                            if (conflict.country) setCountry(conflict.country);
                            scheduleSave();
                          },
                        },
                      ],
                    );
                  }
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
                    onPress={() => handleSetVisibility(v.key)}
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

              {/* Circle picker — shown when 'circle' visibility is selected */}
              {visibility === 'circle' && (
                <>
                  <Text style={styles.label}>Which circle?</Text>
                  {circlesLoading ? (
                    <ActivityIndicator size="small" color={color.signal} style={{ marginTop: space.sm }} />
                  ) : circles.length === 0 ? (
                    <View style={styles.infoBox}>
                      <Users size={14} color={color.mute} />
                      <Text style={styles.infoText}>You don't have any circles yet. Create one from your profile.</Text>
                    </View>
                  ) : (
                    circles.map((c) => (
                      <Pressable
                        key={c.id}
                        style={[styles.optRow, circleId === c.id && styles.optRowActive]}
                        onPress={() => { setCircleId(c.id); scheduleSave(); }}
                      >
                        <Users size={16} color={circleId === c.id ? color.signal : color.mute} />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.optLabel, circleId === c.id && styles.optLabelActive]}>{c.name}</Text>
                        </View>
                        {circleId === c.id && <View style={styles.optDot} />}
                      </Pressable>
                    ))
                  )}
                </>
              )}

              {/* Cover image privacy — only relevant for non-public events */}
              {visibility !== 'public' && (
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.toggleLabel}>Show cover image to non-members</Text>
                    <Text style={styles.toggleSub}>
                      When off, non-members see a generic placeholder instead of your cover photo
                    </Text>
                  </View>
                  <Switch
                    value={showHeaderPublicly}
                    onValueChange={(v) => { setShowHeaderPublicly(v); scheduleSave(); }}
                    trackColor={{ true: color.signal, false: color.haze }}
                    thumbColor={color.paperRaised}
                    accessibilityLabel="Show cover image to non-members"
                  />
                </View>
              )}

              {/* Trip picker — shown when 'trip' visibility is selected */}
              {visibility === 'trip' && (
                <>
                  <Text style={styles.label}>Which trip?</Text>
                  {tripsLoading ? (
                    <ActivityIndicator size="small" color={color.signal} style={{ marginTop: space.sm }} />
                  ) : trips.length === 0 ? (
                    <View style={styles.infoBox}>
                      <MapPin size={14} color={color.mute} />
                      <Text style={styles.infoText}>You don't have any trips yet. Create one from the Trips tab.</Text>
                    </View>
                  ) : (
                    trips.map((trip) => (
                      <Pressable
                        key={trip.id}
                        style={[styles.optRow, tripId === trip.id && styles.optRowActive]}
                        onPress={() => { setTripId(trip.id); scheduleSave(); }}
                      >
                        <MapPin size={16} color={tripId === trip.id ? color.signal : color.mute} />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.optLabel, tripId === trip.id && styles.optLabelActive]}>{trip.title}</Text>
                          <Text style={styles.optDesc}>{trip.destinationCity}{trip.destinationCountry ? `, ${trip.destinationCountry}` : ''}</Text>
                        </View>
                        {tripId === trip.id && <View style={styles.optDot} />}
                      </Pressable>
                    ))
                  )}
                </>
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
                      Portava does not process payments. Attendees will be directed to your external link for ticket purchase.
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
            <View style={styles.inviteStep}>
              <Text style={styles.label}>Invite friends</Text>
              <Text style={styles.hint}>Search by name or handle. You can also invite more after publishing.</Text>
              <TextInput
                style={[styles.input, { marginTop: space.sm }]}
                placeholder="Search travellers…"
                placeholderTextColor={color.faint}
                value={inviteQuery}
                onChangeText={handleInviteQueryChange}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {inviteSearching && (
                <ActivityIndicator size="small" color={color.signal} style={{ marginTop: space.sm }} />
              )}
              {inviteResults.length > 0 && (
                <View style={styles.inviteResults}>
                  {inviteResults.map((u) => {
                    const sent = invitedIds.has(u.id);
                    const sending = inviteSending === u.id;
                    return (
                      <View key={u.id} style={styles.inviteRow}>
                        <Avatar uri={u.avatarUrl ?? ''} size={36} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.inviteName} numberOfLines={1}>
                            {u.displayName ?? u.username ?? ''}
                          </Text>
                          {u.username && u.displayName && (
                            <Text style={styles.inviteHandle}>@{u.username}</Text>
                          )}
                        </View>
                        <Pressable
                          style={[styles.inviteBtn, sent && styles.inviteBtnSent]}
                          onPress={() => !sent && handleSendInvite(u)}
                          disabled={sent || sending}
                        >
                          {sending
                            ? <ActivityIndicator size="small" color={color.onInk} />
                            : <Text style={styles.inviteBtnText}>{sent ? 'Invited ✓' : 'Invite'}</Text>}
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              )}
              {invitedIds.size > 0 && (
                <View style={styles.infoBox}>
                  <UserPlus size={14} color={color.success} />
                  <Text style={[styles.infoText, { color: color.success }]}>
                    {invitedIds.size} invite{invitedIds.size !== 1 ? 's' : ''} sent
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* ── Step 9: Preview ── */}
          {step === 'preview' && (
            <>
              <View style={styles.reviewCard}>
                {coverUri ? (
                  <Image source={{ uri: coverUri }} style={styles.reviewCover} resizeMode="cover" />
                ) : null}
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
                    <Text style={styles.reviewMeta}>{formatEventLocation(locationName, city)}</Text>
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

                {visibility === 'circle' && circleId && (
                  <View style={styles.reviewRow}>
                    <Users size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>
                      Circle: {circles.find((c) => c.id === circleId)?.name ?? circleId}
                    </Text>
                  </View>
                )}
                {visibility === 'trip' && tripId && (
                  <View style={styles.reviewRow}>
                    <MapPin size={13} color={color.mute} />
                    <Text style={styles.reviewMeta}>
                      Trip: {trips.find((tr) => tr.id === tripId)?.title ?? tripId}
                    </Text>
                  </View>
                )}

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
    </KeyboardSafeScrollView>
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
  optDot:            { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: color.signal },
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
  hint:              { ...t.small, color: color.mute },
  inviteStep:        { gap: space.md },
  inviteResults:     { borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  inviteRow:         { flexDirection: 'row', alignItems: 'center', padding: space.md, gap: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  inviteName:        { ...t.body, color: color.ink, fontWeight: '600' },
  inviteHandle:      { ...t.small, color: color.mute },
  inviteBtn:         { backgroundColor: color.signal, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill },
  inviteBtnSent:     { backgroundColor: color.haze },
  inviteBtnText:     { ...t.small, color: color.onInk, fontWeight: '700' },
  coverPicker:          { width: '100%', aspectRatio: aspect.wide, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze, borderStyle: 'dashed', overflow: 'hidden', backgroundColor: color.paperRaised },
  coverPickerFilled:    { borderStyle: 'solid', borderColor: color.haze },
  coverPickerImage:     { width: '100%', height: '100%' },
  coverPickerOverlay:   { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', gap: 8 },
  coverUploadingText:   { ...t.small, color: '#fff', fontWeight: '600' },
  coverRemoveBtn:       { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12, padding: 4 },
  coverPickerEmpty:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  coverPickerHint:      { ...t.body, color: color.mute, fontWeight: '600' },
  coverPickerSub:       { ...t.small, color: color.faint },
  coverUploadedRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  coverUploadedText:    { ...t.small, color: color.success, fontWeight: '600' },
  compassHintsRow:      { gap: space.xs, marginTop: space.xs },
  compassHintsLabel:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  compassHintsLabelText:{ ...t.small, color: color.signal, fontSize: 11, fontWeight: '600' },
  compassChips:         { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  compassChip:          { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal + '12', borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 5 },
  compassChipInner:     { flexDirection: 'row', alignItems: 'center' },
  compassChipText:      { ...t.small, color: color.signal, fontSize: 12, fontWeight: '600' },
  reviewCover:          { width: '100%', aspectRatio: aspect.wide, borderRadius: radius.md, marginBottom: space.xs },
  reviewCard:           { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, marginBottom: space.md, overflow: 'hidden' },
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
