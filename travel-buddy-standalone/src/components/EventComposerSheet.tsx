/**
 * EventComposerSheet — multi-step bottom sheet for creating or editing an Event.
 *
 * Steps:
 *   1. Basics   — title, description, dates, cover media
 *   2. Location — location name / place picker
 *   3. Settings — capacity, age, trust score, verified-only, visibility,
 *                 chat toggle, price field
 *   4. Review   — summary before publish/save-as-draft
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  ScrollView, Switch, ActivityIndicator, Image, Alert,
} from 'react-native';
import { X, ChevronRight, ChevronLeft, CalendarClock, MapPin, Settings2, Eye, Clock, Camera, ImageIcon, Video as VideoIcon, RefreshCw } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { MediaSourceSheet } from './ui/MediaSourceSheet.tsx';
import { createEvent, updateEvent, type CreateEventInput, type UpdateEventInput, type EventSummary, type EventVisibility } from '../services/events.ts';
import { uploadMedia } from '../services/media.ts';
import { GeneratedHeaderPicker } from './visuals/GeneratedHeaderPicker.tsx';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { VIDEO_MAX_DURATION_SECONDS } from '../constants/mediaLimits.ts';
import { VideoThumbnail } from './ui/VideoThumbnail.tsx';
import { GlobalCalendarPicker } from './selectors/GlobalCalendarPicker.tsx';
import { GlobalTimePicker } from './selectors/GlobalTimePicker.tsx';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import { color, space, radius, type as t, dot } from '../theme/tokens.ts';
import { formatEventLocation } from '../lib/location/formatEventLocation.ts';
import { resolvePickedPlace } from '../lib/location/applyPickedPlace.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';

interface Props {
  onDismiss: () => void;
  onCreated: (ev: EventSummary) => void;
  /** When set, the sheet is in edit mode — all fields are pre-populated. */
  initialEvent?: EventSummary;
  /** Called after a successful edit save. */
  onUpdated?: (ev: EventSummary) => void;
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

export function EventComposerSheet({ onDismiss, onCreated, initialEvent, onUpdated }: Props) {
  const { isEnabled } = useFeatureFlags();
  const isEditMode = !!initialEvent;

  const [step, setStep] = useState<Step>('basics');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);

  // Basics — dates use ISO strings; times use HH:mm
  const [title, setTitle]           = useState(initialEvent?.title ?? '');
  const [description, setDescription] = useState(initialEvent?.description ?? '');
  const [startDateStr, setStartDateStr] = useState<string | null>(
    initialEvent?.startsAt ? initialEvent.startsAt.slice(0, 10) : null,
  );
  const [startTime, setStartTime] = useState<string | null>(
    initialEvent?.startsAt ? initialEvent.startsAt.slice(11, 16) : null,
  );
  const [endDateStr, setEndDateStr] = useState<string | null>(
    initialEvent?.endsAt ? initialEvent.endsAt.slice(0, 10) : null,
  );
  const [endTime, setEndTime] = useState<string | null>(
    initialEvent?.endsAt ? initialEvent.endsAt.slice(11, 16) : null,
  );
  const [category, setCategory] = useState(initialEvent?.category ?? '');

  // Cover media
  const [coverUrl, setCoverUrl] = useState<string | null>(initialEvent?.coverUrl ?? null);
  const [coverMediaType, setCoverMediaType] = useState<'image' | 'video' | null>(
    initialEvent?.coverMediaType ?? null,
  );
  const [coverLocalUri, setCoverLocalUri] = useState<string | null>(null);
  const [coverImageWidth, setCoverImageWidth] = useState<number | null>(null);
  const [coverImageHeight, setCoverImageHeight] = useState<number | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [coverSheetOpen, setCoverSheetOpen] = useState(false);

  // Picker visibility
  const [calPickerFor,  setCalPickerFor]  = useState<'start' | 'end' | null>(null);
  const [timePickerFor, setTimePickerFor] = useState<'start' | 'end' | null>(null);

  // Location
  const [locationName, setLocationName] = useState(initialEvent?.locationName ?? '');
  const [city, setCity] = useState(initialEvent?.city ?? '');
  const [country, setCountry] = useState(initialEvent?.country ?? '');

  // Settings
  const [maxAttendees, setMaxAttendees] = useState(
    initialEvent?.maxAttendees != null ? String(initialEvent.maxAttendees) : '',
  );
  const [ageMin, setAgeMin] = useState(
    initialEvent?.ageMin != null ? String(initialEvent.ageMin) : '',
  );
  const [ageMax, setAgeMax] = useState(
    initialEvent?.ageMax != null ? String(initialEvent.ageMax) : '',
  );
  const [trustScoreMin, setTrustScoreMin] = useState(
    initialEvent?.trustScoreMin != null ? String(initialEvent.trustScoreMin) : '',
  );
  const [verifiedOnly, setVerifiedOnly]   = useState(initialEvent?.verifiedOnly ?? false);
  const [visibility, setVisibility]       = useState<EventVisibility>(initialEvent?.visibility ?? 'public');
  const [chatEnabled, setChatEnabled]     = useState(initialEvent?.chatEnabled ?? true);
  const [waitlistEnabled, setWaitlistEnabled] = useState(initialEvent?.waitlistEnabled ?? true);
  const [priceType, setPriceType] = useState<'free' | 'external'>(
    (initialEvent?.priceType as 'free' | 'external') ?? 'free',
  );
  const [priceUrl, setPriceUrl] = useState(initialEvent?.priceUrl ?? '');

  // ── AI header state (create-mode draft + edit-mode banner) ─────────────────
  /** Event ID for AI generation: real ID in edit mode, or draft ID in create mode. */
  const [draftEventId, setDraftEventId] = useState<string | null>(initialEvent?.id ?? null);
  /** Dismissed state for the "details changed" banner in edit mode. */
  const [headerUpdateDismissed, setHeaderUpdateDismissed] = useState(false);
  /** Increment to externally trigger regeneration from the banner. */
  const [regenerateTriggerKey, setRegenerateTriggerKey] = useState(0);
  /** Prevent auto-suggest from firing more than once per session. */
  const autoSuggestFiredRef = React.useRef(false);

  const stepIndex = STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  // ── Cover media picker ──────────────────────────────────────────────────────
  async function handleCoverResult(asset: ImagePicker.ImagePickerAsset) {
    setUploadError(null);
    const isVideo = asset.type === 'video' || (asset.mimeType ?? '').startsWith('video/');
    const pickedMediaType: 'image' | 'video' = isVideo ? 'video' : 'image';

    // Show local preview immediately
    setCoverLocalUri(asset.uri);
    setCoverMediaType(pickedMediaType);
    setCoverUrl(null);

    // Upload — pass the 'event' surface so the 120 s duration limit applies
    setUploadingCover(true);
    const uploadResult = await uploadMedia(
      {
        uri: asset.uri,
        mimeType: asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
        fileName: asset.fileName ?? undefined,
        fileSize: asset.fileSize ?? undefined,
        type: pickedMediaType,
        duration: asset.duration != null ? asset.duration / 1000 : null,
      },
      { surface: 'event' },
    );
    setUploadingCover(false);

    // HEIC fail-soft guard: the server stored the raw bytes but could not decode
    // the image (libvips without HEIF support). processed=false on a successful
    // image upload means the media is unrenderable — treat it as a hard error.
    // Videos always return processed=false (no server transcode), so scope to images.
    if (uploadResult.ok && uploadResult.processed === false && pickedMediaType === 'image') {
      setUploadError("This photo format isn't supported — please re-upload as JPEG or PNG");
      setCoverLocalUri(null);
      setCoverMediaType(null);
      return;
    }

    if (!uploadResult.ok || !uploadResult.url) {
      const uploadMsg =
        uploadResult.errorKind === 'rate_limited' ? 'Too many uploads — please wait a moment and try again.' :
        uploadResult.errorKind === 'invalid_payload' ? "This file couldn't be read — try a different photo." :
        (uploadResult.message ?? 'Upload failed. Try again.');
      setUploadError(uploadMsg);
      setCoverLocalUri(null);
      setCoverMediaType(null);
      return;
    }
    setCoverUrl(uploadResult.url);
    setCoverImageWidth(uploadResult.width ?? null);
    setCoverImageHeight(uploadResult.height ?? null);
  }

  function handleRemoveCover() {
    setCoverUrl(null);
    setCoverMediaType(null);
    setCoverLocalUri(null);
    setCoverImageWidth(null);
    setCoverImageHeight(null);
    setUploadError(null);
  }

  // ── AI header: draft creation + auto-suggest ──────────────────────────────

  /**
   * In create mode, creates a minimal draft event the first time we need an
   * entity ID (for AI generation). Returns the existing draftEventId when
   * already created. In edit mode, returns the existing event ID directly.
   */
  async function createDraftIfNeeded(): Promise<string | null> {
    if (draftEventId) return draftEventId;
    const res = await createEvent({
      title: title.trim() || 'Draft',
      publishNow: false,
    });
    if (!res.ok || !res.data) return null;
    setDraftEventId(res.data.id);
    return res.data.id;
  }

  // Auto-suggest: fires once when title + start date are both set, the flag is
  // ON, and the user has not uploaded a cover. Creates a silent draft first to
  // obtain an entity ID, then triggers the picker via the draftEventId state.
  React.useEffect(() => {
    if (isEditMode) return;                          // edit mode has its own flow
    if (autoSuggestFiredRef.current) return;
    if (!isEnabled('ai_event_auto_suggest_enabled')) return;
    if (!title.trim() || !startDateStr) return;
    if (coverUrl || coverLocalUri) return;           // user already uploaded

    autoSuggestFiredRef.current = true;

    // Debounce 1.5 s so rapid edits don't spam draft creation.
    const timer = setTimeout(async () => {
      const eid = await createDraftIfNeeded();
      if (eid) {
        // Increment the trigger so GeneratedHeaderPicker fires requestGeneration
        // now that an entity ID exists. The ref-based guard in the picker ensures
        // this is ignored on mount (lastTriggerRef starts at the initial value),
        // so this increment always represents a real post-mount intent to generate.
        setRegenerateTriggerKey((k) => k + 1);
      }
    }, 1500);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, startDateStr, coverUrl, coverLocalUri]);

  // ── Edit-mode change detection for the "update header?" banner ────────────

  const hasChangedMajorFields = isEditMode && (
    title       !== (initialEvent?.title ?? '')           ||
    description !== (initialEvent?.description ?? '')     ||
    locationName!== (initialEvent?.locationName ?? '')    ||
    startDateStr!== (initialEvent?.startsAt?.slice(0, 10) ?? null)
  );
  const showHeaderUpdateBanner =
    isEditMode && hasChangedMajorFields && !headerUpdateDismissed;

  function nextStep() {
    if (step === 'basics') {
      if (!title.trim()) { setError('Title is required'); return; }
      if (uploadingCover) { setError('Please wait for the cover upload to finish'); return; }
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
    if (uploadingCover) {
      setError('Please wait for the cover upload to finish');
      return;
    }
    setSaving(true);
    setError(null);

    const sharedFields = {
      title:        title.trim(),
      description:  description.trim() || undefined,
      locationName: locationName.trim() || undefined,
      city:         city.trim() || undefined,
      country:      country.trim() || undefined,
      startsAt:     buildISODateTime(startDateStr, startTime),
      endsAt:       buildISODateTime(endDateStr,   endTime),
      coverUrl:     coverUrl ?? undefined,
      coverMediaType: coverMediaType ?? undefined,
      coverImageWidth:  coverImageWidth ?? undefined,
      coverImageHeight: coverImageHeight ?? undefined,
      category:     category.trim() || undefined,
      maxAttendees: maxAttendees ? parseInt(maxAttendees) : undefined,
      ageMin:       ageMin ? parseInt(ageMin) : undefined,
      ageMax:       ageMax ? parseInt(ageMax) : undefined,
      trustScoreMin:trustScoreMin ? parseFloat(trustScoreMin) : undefined,
      verifiedOnly: verifiedOnly || undefined,
      visibility,
      chatEnabled,
      waitlistEnabled,
      priceType,
      priceUrl:     priceType === 'external' && priceUrl.trim() ? priceUrl.trim() : undefined,
    };

    // ── Edit mode ───────────────────────────────────────────────────────────
    if (isEditMode && initialEvent) {
      const updateInput: UpdateEventInput = {
        ...sharedFields,
        state: publishNow ? 'open' : 'draft',
      };
      const res = await updateEvent(initialEvent.id, updateInput);
      setSaving(false);
      if (!res.ok || !res.data) {
        setError(res.message ?? 'Failed to save event');
        return;
      }
      onUpdated?.(res.data);
      return;
    }

    // ── Create mode: if a draft was created for AI generation, update it ───
    if (draftEventId) {
      const updateInput: UpdateEventInput = {
        ...sharedFields,
        state: publishNow ? 'open' : 'draft',
      };
      const res = await updateEvent(draftEventId, updateInput);
      setSaving(false);
      if (!res.ok || !res.data) {
        setError(res.message ?? 'Failed to create event');
        return;
      }
      onCreated(res.data);
      return;
    }

    // ── Create mode: no draft yet, create fresh ────────────────────────────
    const createInput: CreateEventInput = { ...sharedFields, publishNow };
    const res = await createEvent(createInput);
    setSaving(false);
    if (!res.ok || !res.data) {
      setError(res.message ?? 'Failed to create event');
      return;
    }
    onCreated(res.data);
  }

  // ── Picker: today's ISO date as the minimum ────────────────────────────────
  const todayISO = new Date().toISOString().slice(0, 10);

  // Resolved local URI for preview (before upload completes, use local; after, use remote)
  const previewUri = coverUrl ?? coverLocalUri;

  return (
    <KeyboardSafeScrollView style={s.kav}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.head}>
            <Text style={s.headTitle}>{isEditMode ? 'Edit Event' : 'New Event'}</Text>
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

                {/* ── Cover media picker ── */}
                <Text style={s.label}>Cover image or video (optional)</Text>
                {previewUri ? (
                  <View style={s.coverPreviewWrap}>
                    {coverMediaType === 'video' ? (
                      <VideoThumbnail
                        posterUri={previewUri}
                        style={s.coverPreview}
                      />
                    ) : (
                      <Image source={{ uri: previewUri }} style={s.coverPreview} resizeMode="cover" />
                    )}
                    {/* Upload overlay */}
                    {uploadingCover && (
                      <View style={s.coverUploadOverlay}>
                        <ActivityIndicator color="#fff" />
                        <Text style={s.coverUploadText}>Uploading…</Text>
                      </View>
                    )}
                    {/* Remove button */}
                    {!uploadingCover && (
                      <Pressable style={s.coverRemoveBtn} onPress={handleRemoveCover} hitSlop={8}>
                        <X size={14} color="#fff" />
                      </Pressable>
                    )}
                    {/* Media type badge */}
                    {coverMediaType === 'video' && !uploadingCover && (
                      <View style={s.coverVideoBadge}>
                        <VideoIcon size={10} color="#fff" />
                        <Text style={s.coverVideoBadgeText}>Video</Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <Pressable
                    style={[s.input, s.coverPickerBtn]}
                    onPress={() => setCoverSheetOpen(true)}
                    disabled={uploadingCover}
                  >
                    <Camera size={16} color={color.mute} />
                    <ImageIcon size={16} color={color.mute} />
                    <Text style={[s.coverPickerText]}>Camera or Photo Library</Text>
                  </Pressable>
                )}
                <MediaSourceSheet
                  visible={coverSheetOpen}
                  onClose={() => setCoverSheetOpen(false)}
                  onResult={handleCoverResult}
                  allowsVideo
                  videoMaxDuration={VIDEO_MAX_DURATION_SECONDS.event}
                  title="Event cover"
                />
                {uploadError ? (
                  <Text style={s.uploadErrorText}>{uploadError}</Text>
                ) : null}

                {/* ── AI header picker ── */}
                <Text style={s.label}>AI header image (optional)</Text>

                {/* Edit-mode banner: major fields changed → offer to update header */}
                {showHeaderUpdateBanner && (
                  <View style={s.headerUpdateBanner}>
                    <RefreshCw size={13} color="#B45309" />
                    <Text style={s.headerUpdateBannerText}>
                      Your details changed — update header?
                    </Text>
                    <Pressable
                      style={s.headerUpdateBtn}
                      onPress={() => {
                        setRegenerateTriggerKey((k) => k + 1);
                        setHeaderUpdateDismissed(true);
                      }}
                      hitSlop={6}
                    >
                      <Text style={s.headerUpdateBtnText}>Update</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setHeaderUpdateDismissed(true)}
                      hitSlop={8}
                    >
                      <X size={14} color={color.mute} />
                    </Pressable>
                  </View>
                )}

                <GeneratedHeaderPicker
                  entityType="event"
                  entityId={draftEventId}
                  purpose="event_header"
                  currentImageUri={previewUri}
                  onUpload={() => setCoverSheetOpen(true)}
                  onRequestEntityId={createDraftIfNeeded}
                  regenerateTrigger={regenerateTriggerKey}
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
                    // QA round 2, bug 6 — routed through the shared resolvePickedPlace
                    // rule (the same one gems/submit uses). Blank fields fill silently;
                    // a divergent typed spelling is reported as a CONFLICT the user is
                    // asked about, instead of being silently kept — which is how
                    // divergent city/country spellings used to persist. Manual override
                    // is preserved: typed text is never overwritten without a prompt.
                    const { fill, conflict, hasConflict } = resolvePickedPlace(place, { city, country });
                    if (fill.city) setCity(fill.city);
                    if (fill.country) setCountry(fill.country);
                    setLocationPickerVisible(false);
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
                            },
                          },
                        ],
                      );
                    }
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
                  {/* Cover preview in review */}
                  {previewUri && coverMediaType === 'video' && (
                    <VideoThumbnail posterUri={previewUri} style={s.reviewCoverThumb} />
                  )}
                  {previewUri && coverMediaType === 'image' && (
                    <Image source={{ uri: previewUri }} style={s.reviewCoverThumb} resizeMode="cover" />
                  )}

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
                      <Text style={s.reviewMeta}>{formatEventLocation(locationName, city)}</Text>
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
                  style={[s.publishBtn, (saving || uploadingCover) && { opacity: 0.6 }]}
                  onPress={() => handleSave(true)}
                  disabled={saving || uploadingCover}
                >
                  <Text style={s.publishBtnText}>
                    {saving
                      ? (isEditMode ? 'Saving…' : 'Publishing…')
                      : (isEditMode ? 'Save changes' : 'Publish event')}
                  </Text>
                </Pressable>

                {!isEditMode && (
                  <Pressable
                    style={[s.draftBtn, (saving || uploadingCover) && { opacity: 0.6 }]}
                    onPress={() => handleSave(false)}
                    disabled={saving || uploadingCover}
                  >
                    <Text style={s.draftBtnText}>Save as draft</Text>
                  </Pressable>
                )}
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
              <Pressable
                style={[s.navNext, uploadingCover && { opacity: 0.6 }]}
                onPress={nextStep}
                disabled={uploadingCover}
              >
                {uploadingCover ? (
                  <ActivityIndicator size="small" color={color.onInk} />
                ) : (
                  <Text style={s.navNextText}>Next</Text>
                )}
                {!uploadingCover && <ChevronRight size={18} color={color.onInk} />}
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
  stepDot:    { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2, backgroundColor: color.haze },
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
  visDot:     { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: color.signal },
  priceBtn:   { flex: 1, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center', backgroundColor: color.paper },
  priceBtnActive:{ borderColor: color.signal, backgroundColor: color.signal },
  priceBtnText:{ ...t.small, color: color.mute, fontWeight: '600' },
  priceBtnTextActive:{ color: color.onInk },
  // Cover media
  coverPickerBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  coverPickerText:    { ...t.body, color: color.mute },
  coverPreviewWrap:   { borderRadius: radius.md, overflow: 'hidden', position: 'relative', height: 160 },
  coverPreview:       { width: '100%', height: 160, borderRadius: radius.md },
  coverUploadOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', gap: 8 },
  coverUploadText:    { color: '#fff', ...t.small, fontWeight: '600' },
  coverRemoveBtn:     { position: 'absolute', top: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12, padding: 4 },
  coverVideoBadge:    { position: 'absolute', bottom: 6, left: 6, flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  coverVideoBadgeText:{ color: '#fff', fontSize: 10, fontWeight: '700' },
  uploadErrorText:    { ...t.small, color: '#DC2626', marginTop: 4 },
  reviewCard: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, marginBottom: space.lg },
  reviewCoverThumb:   { width: '100%', height: 140, borderRadius: radius.md, marginBottom: space.sm },
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
  // ── Header-update banner (edit mode) ───────────────────────────────────────
  headerUpdateBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  headerUpdateBannerText: {
    ...t.small,
    color: '#92400E',
    flex: 1,
    fontWeight: '500',
  },
  headerUpdateBtn: {
    backgroundColor: '#B45309',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  headerUpdateBtnText: {
    ...t.small,
    color: '#fff',
    fontWeight: '700',
    fontSize: 11,
  },
});
