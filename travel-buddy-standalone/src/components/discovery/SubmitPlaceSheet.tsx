/**
 * SubmitPlaceSheet — lets authenticated users submit a hidden gem or traveler pick
 * for the current city. Calls POST /api/discovery/community via submitCommunityPlace().
 *
 * Coordinates: the server auto-geocodes the place name + city via Nominatim when
 * no lat/lng are supplied. Users can optionally tap "Set exact location" to use
 * GpsLocationCapture (GPS tap or map picker) to override auto-geocoding.
 * Either way, a place with coordinates becomes a gold star pin on the map after
 * the next pull-to-refresh.
 */
import React, { useState } from 'react';
import {
  View, Text, Modal, Pressable, TextInput, ScrollView, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, MapPin, Star, ChevronDown, ChevronUp } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { submitCommunityPlace } from '../../services/discovery.ts';
import { validateCommunityPlace } from '../../lib/discovery/communityPlaceSubmission.ts';
import { GpsLocationCapture } from '../location/GpsLocationCapture.tsx';
import { KeyboardSafeScrollView } from '../ui/KeyboardSafeView.tsx';
import { useMediaComposer } from '../../hooks/useMediaComposer.ts';
import { MediaPickerButton } from '../ui/MediaPickerButton.tsx';
import { MediaAttachmentTray } from '../ui/MediaAttachmentTray.tsx';

const CATEGORIES = [
  'hidden_gem', 'food', 'nightlife', 'activities',
  'beaches', 'transport', 'events', 'places',
];

const PLACE_TYPES: { key: 'hidden_gem' | 'traveler_pick'; label: string; desc: string }[] = [
  { key: 'hidden_gem',    label: 'Hidden Gem',     desc: 'A secret spot most tourists miss' },
  { key: 'traveler_pick', label: 'Traveler Pick',  desc: "A favourite you'd recommend to anyone" },
];

interface SubmitPlaceSheetProps {
  visible: boolean;
  city: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

export function SubmitPlaceSheet({ visible, city, onClose, onSubmitted }: SubmitPlaceSheetProps) {
  const insets = useSafeAreaInsets();
  const composer = useMediaComposer('communityPlace');
  const [placeType, setPlaceType]       = useState<'hidden_gem' | 'traveler_pick'>('hidden_gem');
  const [name, setName]                 = useState('');
  const [category, setCategory]         = useState('hidden_gem');
  const [neighborhood, setNeighborhood] = useState('');
  const [blurb, setBlurb]               = useState('');
  const [tag, setTag]                   = useState('');
  const [note, setNote]                 = useState('');
  const [rating, setRating]             = useState<number | null>(null);

  const [latText, setLatText]           = useState('');
  const [lngText, setLngText]           = useState('');
  const [showExactLoc, setShowExactLoc] = useState(false);

  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [success, setSuccess]           = useState(false);
  const [pinned, setPinned]             = useState(false);

  const reset = () => {
    setPlaceType('hidden_gem');
    setName('');
    setCategory('hidden_gem');
    setNeighborhood('');
    setBlurb('');
    setTag('');
    setNote('');
    setRating(null);
    setLatText('');
    setLngText('');
    setShowExactLoc(false);
    setError(null);
    setSuccess(false);
    setPinned(false);
    composer.clearAll();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    // Rules live in lib/discovery/communityPlaceSubmission so they can be tested
    // exhaustively — this renderer commits one press-derived update per test
    // file, so five submit attempts would need five component test files.
    const invalid = validateCommunityPlace({ name, city });
    if (invalid) { setError(invalid); return; }

    const latVal = latText.trim() ? parseFloat(latText.trim()) : null;
    const lngVal = lngText.trim() ? parseFloat(lngText.trim()) : null;

    if (latVal !== null && (isNaN(latVal) || latVal < -90 || latVal > 90)) {
      setError('Latitude must be a number between -90 and 90.');
      return;
    }
    if (lngVal !== null && (isNaN(lngVal) || lngVal < -180 || lngVal > 180)) {
      setError('Longitude must be a number between -180 and 180.');
      return;
    }

    setSubmitting(true);
    setError(null);

    // Collect already-uploaded URLs (items that were uploaded in a prior attempt).
    const alreadyUploaded = composer.items
      .filter((i) => i.uploadState === 'done' && i.uploadedUrl)
      .map((i) => i.uploadedUrl!);

    // Upload any remaining idle items and collect new CDN URLs.
    const uploadResults = await composer.uploadAll();
    const newlyUploaded: string[] = [];
    for (const res of uploadResults.values()) {
      if (res?.ok && res.url) newlyUploaded.push(res.url);
    }

    const photos = [...new Set([...alreadyUploaded, ...newlyUploaded])];

    const result = await submitCommunityPlace({
      city:         city.trim(),
      name:         name.trim(),
      place_type:   placeType,
      category:     category || undefined,
      neighborhood: neighborhood.trim() || undefined,
      blurb:        blurb.trim() || undefined,
      tag:          tag.trim() || undefined,
      note:         note.trim() || undefined,
      rating:       rating,
      lat:          latVal,
      lng:          lngVal,
      photos:       photos.length > 0 ? photos : undefined,
    });

    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setPinned(Boolean(result.geocoded) || (latVal !== null && lngVal !== null));
    setSuccess(true);
    onSubmitted?.();
    setTimeout(() => {
      handleClose();
    }, 2200);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardSafeScrollView offset={insets.top}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <MapPin size={18} color={color.signal} />
              <Text style={styles.title}>Share a Place</Text>
            </View>
            <Pressable onPress={handleClose} style={styles.closeBtn} hitSlop={12}>
              <X size={20} color={color.mute} />
            </Pressable>
          </View>

          <Text style={styles.cityLabel}>
            Adding to: <Text style={styles.cityName}>{city}</Text>
          </Text>

          {success ? (
            <View style={styles.successBox}>
              <Text style={styles.successEmoji}>{pinned ? '📍' : '🎉'}</Text>
              <Text style={styles.successTitle}>Thanks for sharing!</Text>
              <Text style={styles.successDesc}>
                {pinned
                  ? 'Your spot is now live and pinned on the map for other travellers to discover.'
                  : 'Your spot is now live for other travellers to discover. It may appear on the map once we locate it.'}
              </Text>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.form} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Place type */}
              <Text style={styles.label}>Type</Text>
              <View style={styles.typeRow}>
                {PLACE_TYPES.map((pt) => {
                  const active = placeType === pt.key;
                  return (
                    <Pressable
                      key={pt.key}
                      style={[styles.typeCard, active && styles.typeCardActive]}
                      onPress={() => setPlaceType(pt.key)}
                    >
                      <Text style={[styles.typeCardTitle, active && styles.typeCardTitleActive]}>
                        {pt.label}
                      </Text>
                      <Text style={styles.typeCardDesc}>{pt.desc}</Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Name */}
              <Text style={styles.label}>Name <Text style={styles.required}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="e.g. Secret rooftop bar"
                placeholderTextColor={color.faint}
                maxLength={120}
              />
              <Text style={styles.geocodeHint}>
                📍 We'll try to locate this on the map automatically.
              </Text>

              {/* Category */}
              <Text style={styles.label}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
                <View style={styles.chipRow}>
                  {CATEGORIES.map((cat) => {
                    const active = category === cat;
                    return (
                      <Pressable
                        key={cat}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => setCategory(cat)}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>
                          {cat.replace('_', ' ')}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              {/* Neighborhood */}
              <Text style={styles.label}>Neighborhood</Text>
              <TextInput
                style={styles.input}
                value={neighborhood}
                onChangeText={setNeighborhood}
                placeholder="e.g. Montmartre"
                placeholderTextColor={color.faint}
                maxLength={80}
              />

              {/* Blurb */}
              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={blurb}
                onChangeText={setBlurb}
                placeholder="What makes this place special?"
                placeholderTextColor={color.faint}
                multiline
                numberOfLines={3}
                maxLength={300}
              />

              {/* Note (personal tip) */}
              <Text style={styles.label}>Personal tip</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={note}
                onChangeText={setNote}
                placeholder="Any insider advice? (e.g. Go at sunset)"
                placeholderTextColor={color.faint}
                multiline
                numberOfLines={2}
                maxLength={200}
              />

              {/* Tag */}
              <Text style={styles.label}>Tag</Text>
              <TextInput
                style={styles.input}
                value={tag}
                onChangeText={setTag}
                placeholder="e.g. romantic, budget-friendly"
                placeholderTextColor={color.faint}
                maxLength={40}
              />

              {/* Rating */}
              <Text style={styles.label}>Your rating</Text>
              <View style={styles.starsRow}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <Pressable
                    key={star}
                    onPress={() => setRating(rating === star ? null : star)}
                    hitSlop={6}
                  >
                    <Star
                      size={28}
                      color={rating != null && star <= rating ? '#F59E0B' : color.haze}
                      fill={rating != null && star <= rating ? '#F59E0B' : 'transparent'}
                    />
                  </Pressable>
                ))}
                {rating != null && (
                  <Text style={styles.ratingValue}>{rating}/5</Text>
                )}
              </View>

              {/* Exact location — optional accordion */}
              <Pressable
                style={styles.exactLocToggle}
                onPress={() => setShowExactLoc((v) => !v)}
                hitSlop={8}
              >
                <MapPin size={14} color={color.mute} />
                <Text style={styles.exactLocToggleText}>
                  {showExactLoc ? 'Hide exact location' : 'Set exact location (optional)'}
                </Text>
                {showExactLoc
                  ? <ChevronUp size={14} color={color.mute} />
                  : <ChevronDown size={14} color={color.mute} />}
              </Pressable>

              {showExactLoc && (
                <View style={styles.exactLocSection}>
                  <GpsLocationCapture
                    onCapture={(result) => {
                      if (result) {
                        setLatText(String(result.lat));
                        setLngText(String(result.lng));
                      } else {
                        setLatText('');
                        setLngText('');
                      }
                    }}
                  />
                </View>
              )}

              {/* Photos (optional — up to 3) */}
              <Text style={styles.label}>Photos <Text style={styles.optional}>(optional)</Text></Text>
              {composer.items.length > 0 && (
                <MediaAttachmentTray composer={composer} />
              )}
              {composer.canAddMore && (
                <View style={styles.photoPickerBtn}>
                  <MediaPickerButton composer={composer} label="Add photo" />
                </View>
              )}

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Submit Place</Text>
                )}
              </Pressable>

              <View style={{ height: space.xxxl }} />
            </ScrollView>
          )}
        </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  closeBtn: {
    padding: space.xs,
  },
  cityLabel: {
    ...t.small,
    color: color.mute,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  cityName: {
    color: color.signal,
    fontWeight: '700',
  },
  form: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.xs,
  },
  label: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: space.md,
    marginBottom: 4,
  },
  required: {
    color: color.signal,
  },
  typeRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  typeCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
  },
  typeCardActive: {
    borderColor: color.signal,
    backgroundColor: color.signal + '10',
  },
  typeCardTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
    marginBottom: 2,
  },
  typeCardTitleActive: {
    color: color.signal,
  },
  typeCardDesc: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 15,
  },
  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    fontSize: 14,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: space.md,
  },
  geocodeHint: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    marginTop: 4,
    lineHeight: 16,
  },
  chipScroll: {
    flexGrow: 0,
  },
  chipRow: {
    flexDirection: 'row',
    gap: space.xs,
    paddingBottom: space.xs,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: {
    borderColor: color.signal,
    backgroundColor: color.signal + '12',
  },
  chipText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  chipTextActive: {
    color: color.signal,
    fontWeight: '700',
  },
  starsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  ratingValue: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    marginLeft: space.xs,
  },
  exactLocToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.lg,
    paddingVertical: space.xs,
  },
  exactLocToggleText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    flex: 1,
  },
  exactLocSection: {
    marginTop: space.sm,
    padding: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.sm,
  },
  exactLocHint: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 16,
  },
  coordRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  coordField: {
    flex: 1,
    gap: 4,
  },
  coordLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  coordInput: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 2,
    ...t.body,
    color: color.ink,
    backgroundColor: color.paper,
    fontSize: 13,
  },
  errorBox: {
    marginTop: space.md,
    padding: space.md,
    backgroundColor: '#FEE2E2',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: {
    ...t.small,
    color: '#DC2626',
    fontSize: 13,
  },
  submitBtn: {
    marginTop: space.lg,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    ...t.bodyStrong,
    color: '#fff',
    fontSize: 15,
  },
  successBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
  },
  successEmoji: {
    fontSize: 48,
  },
  successTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 22,
    textAlign: 'center',
  },
  successDesc: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 21,
  },
  optional: {
    color: color.mute,
    fontWeight: '400',
    textTransform: 'none',
  },
  photoPickerBtn: {
    marginTop: space.xs,
    marginBottom: space.xs,
  },
});

export default SubmitPlaceSheet;
