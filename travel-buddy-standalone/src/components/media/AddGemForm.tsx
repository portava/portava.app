/**
 * AddGemForm — two-step Add a Gem composer.
 *
 * Step 1 — Media
 *   Pick one photo or video. Types gated by feature flags:
 *     MEDIA_UPLOAD_PHOTO_ENABLED  → images allowed
 *     MEDIA_UPLOAD_VIDEO_ENABLED  → videos allowed
 *
 * Step 2 — Place + details
 *   Required: canonical place (GlobalPlacePicker), place name, place type,
 *             city/area, caption, visibility, "depicts selected place" checkbox.
 *   Optional: best time to visit, price level, accessibility, tips,
 *             crowd level, category tags, add to trip.
 *
 * Submit flow:
 *   1. Client validation (all required fields + checkbox)
 *   2. Upload media via useMediaComposer.uploadAll()
 *   3. POST /api/hidden-gems with canonical_place_id + source_confirmation=true
 *   4. Show "Your gem is being prepared" processing state
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Image,
  ActivityIndicator,
  Switch,
  Alert,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { X, MapPin, CheckSquare, Square, ChevronDown, Gem, Camera, ImageIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { color, space, radius, type as t, shadow, avatar } from '../../theme/tokens.ts';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import { useMediaComposer } from '../../hooks/useMediaComposer.ts';
import { useMediaPicker } from '../../hooks/useMediaPicker.ts';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker.tsx';
import { submitGem, type GemCategory } from '../../services/hiddenGems.ts';
import { listMyTrips, type TripRow } from '../../services/trips.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const VISIBILITIES = [
  { value: 'public',       label: 'Everyone' },
  { value: 'circle_only',  label: 'My circle' },
  { value: 'private',      label: 'Only me' },
] as const;

type GemVisibility = typeof VISIBILITIES[number]['value'];

const CATEGORIES: { value: GemCategory; label: string }[] = [
  { value: 'food',         label: '🍜 Food' },
  { value: 'drink',        label: '🍹 Drink' },
  { value: 'nature',       label: '🌿 Nature' },
  { value: 'culture',      label: '🏛 Culture' },
  { value: 'adventure',    label: '⛰ Adventure' },
  { value: 'nightlife',    label: '🌙 Nightlife' },
  { value: 'wellness',     label: '🧘 Wellness' },
  { value: 'local_secret', label: '🤫 Local Secret' },
  { value: 'market',       label: '🛍 Market' },
  { value: 'viewpoint',    label: '👁 Viewpoint' },
  { value: 'transport',    label: '🚉 Transport' },
  { value: 'other',        label: '✦ Other' },
];

const PRICE_LEVELS = [
  { value: 'free', label: 'Free' },
  { value: '$',    label: '$' },
  { value: '$$',   label: '$$' },
  { value: '$$$',  label: '$$$' },
  { value: '$$$$', label: '$$$$' },
] as const;

type PriceLevel = typeof PRICE_LEVELS[number]['value'];

const CROWD_LEVELS = [
  { value: 'quiet',    label: 'Quiet' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'busy',     label: 'Busy' },
  { value: 'very_busy',label: 'Very busy' },
] as const;

type CrowdLevel = typeof CROWD_LEVELS[number]['value'];

// ── Types ──────────────────────────────────────────────────────────────────────

type Step = 'media' | 'details' | 'processing' | 'done';

export interface AddGemFormProps {
  onSuccess?: (gemId: string) => void;
  onClose: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AddGemForm({ onSuccess, onClose }: AddGemFormProps) {
  const insets = useSafeAreaInsets();
  const { isEnabled } = useFeatureFlags();

  // Media flags
  const imageEnabled = isEnabled('MEDIA_UPLOAD_ENABLED')
    && isEnabled('MEDIA_UPLOAD_PHOTO_ENABLED');
  const videoEnabled = isEnabled('MEDIA_UPLOAD_ENABLED')
    && isEnabled('MEDIA_UPLOAD_VIDEO_ENABLED');

  // Media composer (hiddenGem policy: 1 item, images+videos gated above)
  const composer = useMediaComposer('hiddenGem');
  const { pickMedia } = useMediaPicker();

  // ── Flow state ──────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('media');
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);

  // ── Place state ─────────────────────────────────────────────────────────────
  const [placePickerOpen, setPlacePickerOpen] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [canonicalPlaceId, setCanonicalPlaceId] = useState<string | null>(null);

  // ── Required fields ─────────────────────────────────────────────────────────
  const [placeName, setPlaceName] = useState('');
  const [category, setCategory] = useState<GemCategory>('other');
  const [cityArea, setCityArea] = useState('');
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<GemVisibility>('public');
  const [confirmedDepicts, setConfirmedDepicts] = useState(false);

  // ── Optional fields ─────────────────────────────────────────────────────────
  const [bestTimeToVisit, setBestTimeToVisit] = useState('');
  const [priceLevel, setPriceLevel] = useState<PriceLevel | null>(null);
  const [accessibility, setAccessibility] = useState('');
  const [tips, setTips] = useState('');
  const [crowdLevel, setCrowdLevel] = useState<CrowdLevel | null>(null);

  // ── Trip picker ──────────────────────────────────────────────────────────────
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [activeTrips, setActiveTrips] = useState<TripRow[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);

  // ── Errors ──────────────────────────────────────────────────────────────────
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);

  // ── Processed gem ID (for status polling) ───────────────────────────────────
  const [gemId, setGemId] = useState<string | null>(null);

  // ── Load active trips when entering details step ─────────────────────────────
  useEffect(() => {
    if (step !== 'details') return;
    let cancelled = false;
    setTripsLoading(true);
    listMyTrips()
      .then((trips) => {
        if (cancelled) return;
        const active = trips.filter(
          (t) => t.status === 'active' || t.status === 'upcoming',
        );
        setActiveTrips(active);
      })
      .catch(() => {
        // Non-fatal — trip picker just stays empty
      })
      .finally(() => {
        if (!cancelled) setTripsLoading(false);
      });
    return () => { cancelled = true; };
  }, [step]);

  // ── Media picker ─────────────────────────────────────────────────────────────
  async function handlePickGemMedia() {
    const mediaTypes: ('images' | 'videos')[] = [
      ...(imageEnabled ? ['images' as const] : []),
      ...(videoEnabled ? ['videos' as const] : []),
    ];
    const assets = await pickMedia({
      title: 'Add gem media',
      mediaTypes,
      videoMaxDuration: 60,
    });
    if (assets?.[0]) composer.onPickResult(assets[0]);
  }

  // ── Place picker callback ────────────────────────────────────────────────────
  const handlePlaceSelect = useCallback((place: Place) => {
    const incomingName = place.name ?? '';
    const incomingCity = place.city ?? place.displayName ?? '';
    const hasCustomName = placeName.trim().length > 0;
    const hasCustomCity = cityArea.trim().length > 0;

    // Always commit the canonical link and close the picker
    setSelectedPlace(place);
    setCanonicalPlaceId(place.canonicalId ?? place.id ?? null);
    setPlacePickerOpen(false);
    // Clear place-related errors
    setErrors((prev) => {
      const next = { ...prev };
      delete next.place;
      delete next.placeName;
      delete next.cityArea;
      return next;
    });

    if (hasCustomName || hasCustomCity) {
      // User already typed something — ask before overwriting
      Alert.alert(
        'Update place details?',
        `"${incomingName}" is now linked. Replace your text with the linked place's name and city?`,
        [
          { text: 'Keep mine', style: 'cancel' },
          {
            text: 'Use place name',
            onPress: () => {
              setPlaceName(incomingName);
              setCityArea(incomingCity);
            },
          },
        ],
      );
    } else {
      // Fields are blank — pre-fill silently
      setPlaceName(incomingName);
      setCityArea(incomingCity);
    }
  }, [placeName, cityArea]);

  // ── Client validation ────────────────────────────────────────────────────────
  function validate(): boolean {
    const errs: Record<string, string> = {};

    if (composer.items.length === 0) {
      errs.media = 'Add a photo or video of the location.';
    }
    // canonicalPlaceId is optional — users can submit freehand gems without a
    // linked canonical place. When provided it is validated on the backend.
    if (!placeName.trim()) {
      errs.placeName = 'Place name is required.';
    }
    if (!cityArea.trim()) {
      errs.cityArea = 'City or area is required.';
    }
    if (!caption.trim()) {
      errs.caption = 'Caption is required.';
    }
    if (!confirmedDepicts) {
      errs.confirms = 'Please confirm this media actually depicts the selected place.';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Media step → details step ─────────────────────────────────────────────
  function handleNextFromMedia() {
    if (composer.items.length === 0) {
      setErrors({ media: 'Add a photo or video first.' });
      return;
    }
    setErrors({});
    setStep('details');
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!validate()) return;
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setGlobalError(null);

    try {
      // 1. Upload media
      const uploadResults = await composer.uploadAll();
      const firstResult = uploadResults.values().next().value;
      if (!firstResult?.ok || !firstResult.url) {
        // useMediaComposer.uploadItem already sets item.uploadError for all
        // failure modes (including HEIC processed=false). Both that setItems
        // call and this setGlobalError are batched into the same re-render, so
        // the JSX can prefer the item-level error (specific) over globalError
        // (generic fallback). See the `displayedError` derivation below.
        setGlobalError(firstResult?.message ?? 'Media upload failed. Please try again.');
        return;
      }

      // 2. Submit gem
      const gem = await submitGem({
        name: placeName.trim(),
        category,
        city: cityArea.trim(),
        country: selectedPlace?.country ?? undefined,
        neighborhood: selectedPlace?.district ?? undefined,
        description: caption.trim(),
        latitude: selectedPlace?.lat ?? undefined,
        longitude: selectedPlace?.lng ?? undefined,
        vibeTags: [],
        priceRange: priceLevel ?? undefined,
        bestTimeToGo: bestTimeToVisit.trim() || undefined,
        imageUrl: firstResult.url,
        // Dedicated "Add a Gem" creation flow fields.
        // canonicalPlaceId is optional — omit it when the user left the place
        // picker blank so the backend doesn't trigger the UUID-required gate.
        ...(canonicalPlaceId ? { canonicalPlaceId } : {}),
        sourceConfirmation: true,
        accessibility: accessibility.trim() || undefined,
        crowdLevel: crowdLevel ?? undefined,
        safetyNotes: tips.trim() || undefined,
        visibility,
        tripId: selectedTripId ?? undefined,
      });

      setGemId(gem.id);
      setStep('processing');

      // Auto-transition to done after a short wait
      setTimeout(() => {
        setStep('done');
        onSuccess?.(gem.id);
      }, 3000);
    } catch (err: any) {
      setGlobalError(err?.message ?? 'Could not publish your gem. Please try again.');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  // ── Render: media step ────────────────────────────────────────────────────
  if (step === 'media') {
    const primaryItem = composer.primaryItem;

    if (!imageEnabled && !videoEnabled) {
      return (
        <View style={[styles.centeredState, { paddingBottom: insets.bottom + 16 }]}>
          <Gem size={40} color={color.mute} />
          <Text style={styles.centeredTitle}>Media uploads disabled</Text>
          <Text style={styles.centeredBody}>
            Media uploads are currently unavailable. Check back later.
          </Text>
          <Pressable style={styles.closeTextBtn} onPress={onClose}>
            <Text style={styles.closeTextBtnLabel}>Close</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={[styles.step, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <StepHeader
          title="Add a Gem"
          subtitle="Step 1 of 2 — Select media"
          onClose={onClose}
        />

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.stepBody}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.stepDescription}>
            Add a photo or video that actually shows the place you're sharing.
            This media must depict the location — illustrative images are not allowed.
          </Text>

          {/* Media preview / picker */}
          {primaryItem ? (
            <View style={styles.mediaPreviewWrap}>
              {primaryItem.type === 'video' ? (
                <Video
                  source={{ uri: primaryItem.uri }}
                  style={styles.mediaPreview}
                  resizeMode={ResizeMode.COVER}
                  shouldPlay
                  isLooping
                  isMuted
                  useNativeControls={false}
                />
              ) : (
                <Image
                  source={{ uri: primaryItem.uri }}
                  style={styles.mediaPreview}
                  resizeMode="cover"
                />
              )}
              <Pressable
                style={styles.mediaRemoveBtn}
                onPress={() => composer.removeItem(primaryItem.id)}
                hitSlop={8}
              >
                <X size={14} color="#fff" />
              </Pressable>
              {primaryItem.type === 'video' && primaryItem.duration != null && (
                <View style={styles.durationBadge}>
                  <Text style={styles.durationText}>
                    {primaryItem.duration.toFixed(1)}s
                  </Text>
                </View>
              )}
            </View>
          ) : (
            <Pressable style={styles.mediaPickerBtn} onPress={handlePickGemMedia}>
              <View style={styles.mediaPickerBtnIcons}>
                <Camera size={20} color={color.mute} />
                <ImageIcon size={20} color={color.mute} />
              </View>
              <Text style={styles.mediaPickerBtnText}>Take Photo · Choose from Library</Text>
            </Pressable>
          )}

          {errors.media ? (
            <Text style={styles.fieldError}>{errors.media}</Text>
          ) : (
            <Text style={styles.hint}>
              {imageEnabled && videoEnabled
                ? 'Photos or videos (up to 60 s) — must show the actual place'
                : imageEnabled
                ? 'Photos only — must show the actual place'
                : 'Videos only (up to 60 s) — must show the actual place'}
            </Text>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            style={[styles.primaryBtn, composer.items.length === 0 && styles.btnDisabled]}
            onPress={handleNextFromMedia}
            disabled={composer.items.length === 0}
          >
            <Text style={styles.primaryBtnText}>Next — Add place details</Text>
          </Pressable>
        </View>

      </View>
    );
  }

  // ── Render: processing state ──────────────────────────────────────────────
  if (step === 'processing' || step === 'done') {
    return (
      <View style={[styles.centeredState, { paddingBottom: insets.bottom + 16 }]}>
        {step === 'processing' ? (
          <>
            <ActivityIndicator size="large" color={color.signal} />
            <Text style={styles.centeredTitle}>Your gem is being prepared</Text>
            <Text style={styles.centeredBody}>
              Sit tight — we're processing your media and registering the location.
            </Text>
          </>
        ) : (
          <>
            <Gem size={48} color="#10B981" />
            <Text style={styles.centeredTitle}>Gem submitted!</Text>
            <Text style={styles.centeredBody}>
              Your gem is now pending review. Once approved, it will appear in the Gems feed.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={onClose}>
              <Text style={styles.primaryBtnText}>Done</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  // ── Render: details step ──────────────────────────────────────────────────
  return (
    <View style={[styles.step, { paddingBottom: Math.max(insets.bottom, 16) }]}>
      <StepHeader
        title="Add a Gem"
        subtitle="Step 2 of 2 — Place details"
        onClose={onClose}
        onBack={() => setStep('media')}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.stepBody}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ── Required fields ─────────────────────────────────────────── */}

        {/* Place picker — optional canonical link */}
        <View style={styles.field}>
          <Text style={styles.label}>
            Link a known place{' '}
            <Text style={styles.optionalBadge}>(optional)</Text>
          </Text>
          <Pressable
            style={[
              styles.placeBtn,
              selectedPlace && styles.placeBtnActive,
            ]}
            onPress={() => setPlacePickerOpen(true)}
          >
            <MapPin size={14} color={selectedPlace ? '#10B981' : color.mute} />
            <Text
              style={[styles.placeBtnText, !selectedPlace && styles.placeBtnPlaceholder]}
              numberOfLines={1}
            >
              {selectedPlace
                ? `${selectedPlace.name}${selectedPlace.city ? `, ${selectedPlace.city}` : ''}`
                : 'Search for a place…'}
            </Text>
            {selectedPlace ? (
              <Pressable
                hitSlop={8}
                onPress={(e) => {
                  e.stopPropagation();
                  setSelectedPlace(null);
                  setCanonicalPlaceId(null);
                }}
              >
                <X size={14} color={color.mute} />
              </Pressable>
            ) : (
              <ChevronDown size={14} color={color.mute} />
            )}
          </Pressable>
          <Text style={styles.hint}>
            {selectedPlace
              ? 'Linked — contact info, hours, and enriched details will appear on the gem.'
              : "Can't find it? Skip this — you can still publish your gem without a link."}
          </Text>
        </View>

        {/* Place name */}
        <View style={styles.field}>
          <Text style={styles.label}>
            Place name <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={[styles.input, errors.placeName && styles.inputError]}
            value={placeName}
            onChangeText={setPlaceName}
            placeholder="e.g. Warung Nasi Campur Bu Oka"
            placeholderTextColor={color.faint}
            editable={!submitting}
          />
          {errors.placeName && (
            <Text style={styles.fieldError}>{errors.placeName}</Text>
          )}
        </View>

        {/* Category */}
        <View style={styles.field}>
          <Text style={styles.label}>
            Category <Text style={styles.required}>*</Text>
          </Text>
          <View style={styles.chipRow}>
            {CATEGORIES.map(({ value, label }) => (
              <Pressable
                key={value}
                style={[styles.chip, category === value && styles.chipActive]}
                onPress={() => setCategory(value)}
              >
                <Text style={[styles.chipText, category === value && styles.chipTextActive]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* City / area */}
        <View style={styles.field}>
          <Text style={styles.label}>
            City or area <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={[styles.input, errors.cityArea && styles.inputError]}
            value={cityArea}
            onChangeText={setCityArea}
            placeholder="e.g. Ubud, Bali"
            placeholderTextColor={color.faint}
            editable={!submitting}
          />
          {errors.cityArea && (
            <Text style={styles.fieldError}>{errors.cityArea}</Text>
          )}
        </View>

        {/* Caption */}
        <View style={styles.field}>
          <Text style={styles.label}>
            Caption <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={[styles.input, styles.multiline, errors.caption && styles.inputError]}
            value={caption}
            onChangeText={setCaption}
            placeholder="Describe what makes this place special…"
            placeholderTextColor={color.faint}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            maxLength={2000}
            editable={!submitting}
          />
          {errors.caption && (
            <Text style={styles.fieldError}>{errors.caption}</Text>
          )}
        </View>

        {/* Visibility */}
        <View style={styles.field}>
          <Text style={styles.label}>
            Visibility <Text style={styles.required}>*</Text>
          </Text>
          <View style={styles.chipRow}>
            {VISIBILITIES.map(({ value, label }) => (
              <Pressable
                key={value}
                style={[styles.chip, visibility === value && styles.chipActive]}
                onPress={() => setVisibility(value)}
              >
                <Text
                  style={[styles.chipText, visibility === value && styles.chipTextActive]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Depicts confirmation checkbox */}
        <Pressable
          style={[
            styles.checkboxRow,
            errors.confirms && styles.checkboxRowError,
          ]}
          onPress={() => {
            setConfirmedDepicts((v) => !v);
            if (errors.confirms) {
              setErrors((prev) => { const n = { ...prev }; delete n.confirms; return n; });
            }
          }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: confirmedDepicts }}
        >
          {confirmedDepicts ? (
            <CheckSquare size={20} color="#10B981" strokeWidth={2} />
          ) : (
            <Square size={20} color={errors.confirms ? color.signal : color.mute} strokeWidth={1.8} />
          )}
          <Text style={[styles.checkboxText, errors.confirms && styles.checkboxTextError]}>
            This media actually depicts the selected place — not a stock photo or unrelated location.
          </Text>
        </Pressable>
        {errors.confirms && (
          <Text style={[styles.fieldError, { marginTop: -8 }]}>{errors.confirms}</Text>
        )}

        {/* ── Optional fields ─────────────────────────────────────────── */}

        <View style={styles.divider} />
        <Text style={styles.optionalSection}>Optional details</Text>

        {/* Best time to visit */}
        <View style={styles.field}>
          <Text style={styles.label}>Best time to visit</Text>
          <TextInput
            style={styles.input}
            value={bestTimeToVisit}
            onChangeText={setBestTimeToVisit}
            placeholder="e.g. Early morning on weekdays"
            placeholderTextColor={color.faint}
            editable={!submitting}
          />
        </View>

        {/* Price level */}
        <View style={styles.field}>
          <Text style={styles.label}>Price level</Text>
          <View style={styles.chipRow}>
            {PRICE_LEVELS.map(({ value, label }) => (
              <Pressable
                key={value}
                style={[styles.chip, priceLevel === value && styles.chipActive]}
                onPress={() => setPriceLevel(priceLevel === value ? null : value)}
              >
                <Text
                  style={[styles.chipText, priceLevel === value && styles.chipTextActive]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Crowd level */}
        <View style={styles.field}>
          <Text style={styles.label}>Crowd level</Text>
          <View style={styles.chipRow}>
            {CROWD_LEVELS.map(({ value, label }) => (
              <Pressable
                key={value}
                style={[styles.chip, crowdLevel === value && styles.chipActive]}
                onPress={() => setCrowdLevel(crowdLevel === value ? null : value)}
              >
                <Text
                  style={[styles.chipText, crowdLevel === value && styles.chipTextActive]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Accessibility */}
        <View style={styles.field}>
          <Text style={styles.label}>Accessibility notes</Text>
          <TextInput
            style={styles.input}
            value={accessibility}
            onChangeText={setAccessibility}
            placeholder="e.g. Wheelchair accessible, stairs required…"
            placeholderTextColor={color.faint}
            editable={!submitting}
          />
        </View>

        {/* Tips */}
        <View style={styles.field}>
          <Text style={styles.label}>Insider tips</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={tips}
            onChangeText={setTips}
            placeholder="Share what you wish you knew before going…"
            placeholderTextColor={color.faint}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            maxLength={1000}
            editable={!submitting}
          />
        </View>

        {/* Add to trip */}
        <View style={styles.field}>
          <Text style={styles.label}>Add to a trip</Text>
          {tripsLoading ? (
            <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
          ) : activeTrips.length === 0 ? (
            <Text style={styles.hint}>No active or upcoming trips found.</Text>
          ) : (
            <View style={styles.chipRow}>
              {activeTrips.map((trip) => (
                <Pressable
                  key={trip.id}
                  style={[styles.chip, selectedTripId === trip.id && styles.chipActive]}
                  onPress={() => setSelectedTripId(selectedTripId === trip.id ? null : trip.id)}
                >
                  <Text
                    style={[styles.chipText, selectedTripId === trip.id && styles.chipTextActive]}
                    numberOfLines={1}
                  >
                    {trip.title}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Text style={styles.hint}>
            Attach this gem to one of your active trips — optional.
          </Text>
        </View>

        {/* Global error — prefer per-item upload errors (e.g. HEIC format
            rejection) that useMediaComposer commits in the same render batch
            as the generic globalError fallback set by handleSubmit. */}
        {(() => {
          const composerUploadError =
            composer.items.find((it) => it.uploadState === 'error' && it.uploadError)
              ?.uploadError ?? null;
          const displayedError = composerUploadError ?? globalError;
          return displayedError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{displayedError}</Text>
            </View>
          ) : null;
        })()}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.primaryBtn, submitting && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Publish Gem</Text>
          )}
        </Pressable>
      </View>

      {/* Place picker */}
      <GlobalPlacePicker
        visible={placePickerOpen}
        title="Select a place"
        usedFor="gem_place"
        onSelect={handlePlaceSelect}
        onClose={() => setPlacePickerOpen(false)}
      />
    </View>
  );
}

// ── StepHeader ────────────────────────────────────────────────────────────────

interface StepHeaderProps {
  title: string;
  subtitle: string;
  onClose: () => void;
  onBack?: () => void;
}

function StepHeader({ title, subtitle, onClose, onBack }: StepHeaderProps) {
  return (
    <View style={styles.stepHeader}>
      <View style={styles.stepHeaderLeft}>
        {onBack && (
          <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
            <Text style={styles.backBtnText}>← Back</Text>
          </Pressable>
        )}
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepSubtitle}>{subtitle}</Text>
      </View>
      <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
        <X size={18} color={color.ink} />
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  step: {
    flex: 1,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  stepHeaderLeft: {
    flex: 1,
    gap: 2,
  },
  stepTitle: {
    ...t.heading,
    color: color.ink,
  },
  stepSubtitle: {
    ...t.small,
    color: color.mute,
  },
  closeBtn: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  backBtn: {
    marginBottom: 2,
  },
  backBtnText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
  },
  stepBody: {
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    gap: space.md,
  },
  stepDescription: {
    ...t.body,
    color: color.mute,
    lineHeight: 20,
  },

  // Media picker button (empty state)
  mediaPickerBtn: {
    borderWidth: 1.5,
    borderColor: color.haze,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    paddingVertical: space.xl,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: space.sm,
    backgroundColor: color.paperRaised,
  },
  mediaPickerBtnIcons: {
    flexDirection: 'row' as const,
    gap: space.sm,
  },
  mediaPickerBtnText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600' as const,
  },

  // Media preview
  mediaPreviewWrap: {
    position: 'relative',
  },
  mediaPreview: {
    width: '100%',
    height: 240,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  mediaRemoveBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: avatar.s28, height: avatar.s28,
    borderRadius: avatar.s28 / 2,
    backgroundColor: 'rgba(17,17,15,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(17,17,15,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  durationText: {
    fontFamily: 'Courier',
    fontSize: 11,
    color: '#fff',
    fontWeight: '700',
  },
  hint: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
  },

  // Form fields
  field: {
    gap: 6,
  },
  label: {
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '700',
    color: color.mute,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  required: {
    color: color.signal,
  },
  input: {
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  multiline: {
    minHeight: 80,
    paddingTop: 10,
  },
  inputError: {
    borderColor: color.signal,
  },
  fieldError: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
  },

  // Place picker button
  placeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    backgroundColor: color.paperRaised,
    paddingHorizontal: space.md,
    paddingVertical: 12,
  },
  placeBtnActive: {
    borderColor: '#10B981',
  },
  placeBtnText: {
    flex: 1,
    ...t.body,
    color: color.ink,
  },
  placeBtnPlaceholder: {
    color: color.faint,
  },

  // Chips
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  chipText: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
    fontSize: 12,
  },
  chipTextActive: {
    color: '#fff',
  },

  // Confirmation checkbox
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  checkboxRowError: {
    borderColor: color.signal,
    backgroundColor: '#FEF2F2',
  },
  checkboxText: {
    ...t.body,
    color: color.ink,
    flex: 1,
    lineHeight: 20,
  },
  checkboxTextError: {
    color: color.signal,
  },

  // Optional section divider
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginVertical: space.sm,
  },
  optionalSection: {
    ...t.small,
    color: color.mute,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  optionalBadge: {
    ...t.small,
    color: color.faint,
    fontWeight: '400',
    textTransform: 'none',
    letterSpacing: 0,
  },

  // Error box
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    padding: space.md,
  },
  errorText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
  },

  // Footer
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  primaryBtn: {
    backgroundColor: '#10B981',
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  primaryBtnText: {
    ...t.bodyStrong,
    color: '#fff',
  },

  // Centered state (processing / done / disabled)
  centeredState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xxl,
    gap: space.md,
  },
  centeredTitle: {
    ...t.heading,
    color: color.ink,
    textAlign: 'center',
  },
  centeredBody: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 22,
  },
  closeTextBtn: {
    marginTop: space.sm,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
  },
  closeTextBtnLabel: {
    ...t.bodyStrong,
    color: color.signal,
  },
});
