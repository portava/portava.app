/**
 * Gem submission screen
 * Route: /gems/submit
 *
 * Multi-step wizard: Location → Details → Photo → Privacy → Review & Submit
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert, Switch, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { submitGem, type GemCategory, type GemSensitivity } from '../../src/services/hiddenGems';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { GpsLocationCapture } from '../../src/components/location/GpsLocationCapture';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { resolvePickedPlace } from '../../src/lib/location/applyPickedPlace';
import type { Place } from '../../src/lib/location/placeTypes';
import { canNext as wizardCanNext, buildSubmitPayload } from '../../src/lib/gems/submitMachine';
import { GemLocationPreview } from '../../src/components/gems/GemLocationPreview';
import { uploadMedia } from '../../src/services/media';
import { avatar, icon } from '../../src/theme/tokens';
// Global Input Intelligence — Phase 5 (Creation). Inline, NON-BLOCKING duplicate
// detection (§20/§55) + §23 validation on the gem name. Degrades to nothing when
// the (parallel-PR) endpoint is absent; never blocks or changes submit.
import { useCreationAssistance } from '../../src/hooks/useCreationAssistance.ts';
import {
  CreationAssist,
  CREATION_FIELD_IDS,
  type DuplicateCandidate,
} from '../../src/platform/input-assistance';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  category: GemCategory | '';
  city: string;
  country: string;
  neighborhood: string;
  description: string;
  gpsLat: number | undefined;
  gpsLng: number | undefined;
  gpsLabel: string | undefined;
  vibeTags: string;
  priceRange: string;
  safetyNotes: string;
  bestTimeToGo: string;
  layoverSafe: boolean;
  minimumLayoverMinutes: string;
  sensitivityLevel: GemSensitivity;
  imageUrl: string | undefined;
}

const INITIAL: FormState = {
  name: '',
  category: '',
  city: '',
  country: '',
  neighborhood: '',
  description: '',
  gpsLat: undefined,
  gpsLng: undefined,
  gpsLabel: undefined,
  vibeTags: '',
  priceRange: '',
  safetyNotes: '',
  bestTimeToGo: '',
  layoverSafe: false,
  minimumLayoverMinutes: '',
  sensitivityLevel: 'public',
  imageUrl: undefined,
};

const CATEGORIES: Array<{ key: GemCategory; label: string; icon: string }> = [
  { key: 'food',         label: 'Food',        icon: 'restaurant-outline' },
  { key: 'drink',        label: 'Drink',       icon: 'wine-outline' },
  { key: 'nature',       label: 'Nature',      icon: 'leaf-outline' },
  { key: 'culture',      label: 'Culture',     icon: 'library-outline' },
  { key: 'adventure',    label: 'Adventure',   icon: 'compass-outline' },
  { key: 'nightlife',    label: 'Nightlife',   icon: 'moon-outline' },
  { key: 'wellness',     label: 'Wellness',    icon: 'heart-outline' },
  { key: 'local_secret', label: 'Local Secret',icon: 'key-outline' },
  { key: 'market',       label: 'Market',      icon: 'storefront-outline' },
  { key: 'viewpoint',    label: 'Viewpoint',   icon: 'eye-outline' },
  { key: 'transport',    label: 'Transport',   icon: 'bus-outline' },
  { key: 'other',        label: 'Other',       icon: 'apps-outline' },
];

const SENSITIVITY_OPTIONS: Array<{ key: GemSensitivity; label: string; desc: string; icon: string }> = [
  { key: 'public',               label: 'Public',              desc: 'Exact location visible to everyone',          icon: 'globe-outline' },
  { key: 'approximate',          label: 'Approximate',         desc: 'Neighbourhood area only — exact hidden',      icon: 'navigate-circle-outline' },
  { key: 'reveal_after_save',    label: 'Save to Reveal',      desc: 'Location revealed only after someone saves',  icon: 'bookmark-outline' },
  { key: 'reveal_after_acceptance', label: 'Trip Members Only', desc: 'Exact location for accepted trip members only', icon: 'people-outline' },
  { key: 'protected',            label: 'Protected',           desc: 'Location never shared — name + city only',   icon: 'lock-closed-outline' },
];

const PRICE_OPTIONS = ['free', '$', '$$', '$$$', '$$$$'];

const STEPS = ['Location', 'Details', 'Photo', 'Privacy', 'Review'];

// ── Step components ────────────────────────────────────────────────────────────

function LocationStep({ form, update }: { form: FormState; update: (k: keyof FormState, v: any) => void }) {
  const [placePickerOpen, setPlacePickerOpen] = useState(false);

  const handleCapture = useCallback((place: Place | null) => {
    update('gpsLat', place?.lat ?? undefined);
    update('gpsLng', place?.lng ?? undefined);
    update('gpsLabel', place?.displayName ?? undefined);
  }, [update]);

  /**
   * Picking a canonical place fills city / country / neighbourhood.
   *
   * All three were free text with no autocomplete, persisted verbatim by
   * buildSubmitPayload, so the same town arrived at the server under as many
   * spellings as people typed. City is a REQUIRED field here, which makes it
   * the one most worth resolving.
   *
   * Preferred, not required: a gem in a village no global index carries must
   * still be submittable, so typed text is never rejected — and never
   * overwritten behind the user's back either. That second half is the defect
   * EventComposerSheet.tsx:604 and app/events/create/index.tsx:927 both carry a
   * "QA round 2, bug 6" comment about; resolvePickedPlace draws the line once
   * for every composer.
   *
   * Coordinates ride along when the place has them — submitGem already accepts
   * latitude/longitude, and a resolved place is a better source for them than
   * a typed city name the server would have to geocode.
   */
  const handlePlacePicked = useCallback((place: Place) => {
    setPlacePickerOpen(false);
    const { fill, conflict, coords, hasConflict } = resolvePickedPlace(place, {
      city: form.city, country: form.country, neighborhood: form.neighborhood,
    });
    if (fill.city) update('city', fill.city);
    if (fill.country) update('country', fill.country);
    if (fill.neighborhood) update('neighborhood', fill.neighborhood);
    if (coords && form.gpsLat == null && form.gpsLng == null) {
      update('gpsLat', coords.lat);
      update('gpsLng', coords.lng);
      update('gpsLabel', place.displayName);
    }
    if (!hasConflict) return;
    Alert.alert(
      'Replace what you typed?',
      `${place.displayName} is linked. Replace the location details you entered with its own?`,
      [
        { text: 'Keep mine', style: 'cancel' },
        {
          text: 'Use this place',
          onPress: () => {
            if (conflict.city) update('city', conflict.city);
            if (conflict.country) update('country', conflict.country);
            if (conflict.neighborhood) update('neighborhood', conflict.neighborhood);
          },
        },
      ],
    );
  }, [form.city, form.country, form.neighborhood, form.gpsLat, form.gpsLng, update]);

  return (
    <KeyboardSafeView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
      <Text style={styles.stepHeading}>Where is it?</Text>
      <Text style={styles.stepSub}>Tell us where the gem is located</Text>

      <TouchableOpacity
        testID="gem-pick-place"
        style={styles.pickPlaceBtn}
        onPress={() => setPlacePickerOpen(true)}
      >
        <Ionicons name="search" size={14} color="#2F6F8F" />
        <Text style={styles.pickPlaceText}>Search for a place</Text>
      </TouchableOpacity>

      <Field label="City *">
        <TextInput
          style={styles.input}
          value={form.city}
          onChangeText={(v) => update('city', v)}
          placeholder="e.g. Tokyo"
          placeholderTextColor="#8A9BB5"
        />
      </Field>

      <Field label="Country">
        <TextInput
          style={styles.input}
          value={form.country}
          onChangeText={(v) => update('country', v)}
          placeholder="e.g. Japan"
          placeholderTextColor="#8A9BB5"
        />
      </Field>

      <Field label="Neighbourhood">
        <TextInput
          style={styles.input}
          value={form.neighborhood}
          onChangeText={(v) => update('neighborhood', v)}
          placeholder="e.g. Shimokitazawa"
          placeholderTextColor="#8A9BB5"
        />
      </Field>

      <Field label="GPS Location (optional — helps with GPS verification)">
        <GpsLocationCapture
          onCapture={handleCapture}
          initialLabel={form.gpsLabel}
        />
      </Field>

      {/* Mounted only while open: the picker reads safe-area insets and starts
          its own location work on mount, and neither is worth paying for while
          it is invisible. It also keeps this modal renderable without a
          SafeAreaProvider, which is how its existing tests render it. */}
      {placePickerOpen && (
      <GlobalPlacePicker
        visible={placePickerOpen}
        title="Where is this gem?"
        placeholder="City, area or venue…"
        allowGPS
        usedFor="gem_location"
        onSelect={handlePlacePicked}
        onClose={() => setPlacePickerOpen(false)}
      />
      )}
    </KeyboardSafeView>
  );
}

function DetailsStep({ form, update }: { form: FormState; update: (k: keyof FormState, v: any) => void }) {
  const router = useRouter();

  // §20/§55 — as the gem is named, surface likely-existing Gems/Places so the
  // user can confirm the intended entity instead of minting a duplicate, plus any
  // §23 validation. NON-BLOCKING: advisory + dismissible; submit is unchanged.
  const assist = useCreationAssistance({
    context: 'hidden_gem_name',
    fieldId: CREATION_FIELD_IDS.gemName,
    text: form.name,
    sessionContext: { surface: 'gem_create' },
  });

  const handlePickExisting = useCallback(
    (c: DuplicateCandidate) => {
      // §55 "user confirms intended entity": route to the existing record so they
      // can verify it. The half-filled form is theirs to return to — never blocks.
      if (c.route) router.push(c.route as any);
    },
    [router],
  );

  return (
    <KeyboardSafeView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
      <Text style={styles.stepHeading}>Tell us about it</Text>
      <Text style={styles.stepSub}>The more detail, the more helpful it is for others</Text>

      <Field label="Name *">
        <TextInput
          style={styles.input}
          value={form.name}
          onChangeText={(v) => update('name', v)}
          placeholder="What locals call it"
          placeholderTextColor="#8A9BB5"
          maxLength={200}
        />
      </Field>

      <CreationAssist
        duplicates={assist.duplicates}
        validation={assist.validation}
        onPickExisting={handlePickExisting}
      />

      <Field label="Category *">
        <View style={styles.categoryGrid}>
          {CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={[styles.catBtn, form.category === c.key && styles.catBtnActive]}
              onPress={() => update('category', c.key)}
            >
              <Ionicons name={c.icon as any} size={18} color={form.category === c.key ? '#fff' : '#8A9BB5'} />
              <Text style={[styles.catBtnText, form.category === c.key && styles.catBtnTextActive]}>
                {c.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Field>

      <Field label="Description">
        <TextInput
          style={[styles.input, styles.textArea]}
          value={form.description}
          onChangeText={(v) => update('description', v)}
          placeholder="What makes this place special?"
          placeholderTextColor="#8A9BB5"
          multiline
          maxLength={2000}
        />
      </Field>

      <Field label="Best Time to Go">
        <TextInput
          style={styles.input}
          value={form.bestTimeToGo}
          onChangeText={(v) => update('bestTimeToGo', v)}
          placeholder="e.g. Sunday mornings, sunset"
          placeholderTextColor="#8A9BB5"
          maxLength={300}
        />
      </Field>

      <Field label="Safety Notes">
        <TextInput
          style={[styles.input, styles.textArea]}
          value={form.safetyNotes}
          onChangeText={(v) => update('safetyNotes', v)}
          placeholder="Any safety tips, warnings, or local advice?"
          placeholderTextColor="#8A9BB5"
          multiline
          maxLength={1000}
        />
      </Field>

      <Field label="Vibe Tags (comma-separated)">
        <TextInput
          style={styles.input}
          value={form.vibeTags}
          onChangeText={(v) => update('vibeTags', v)}
          placeholder="e.g. chill, instagram, hidden, locals-only"
          placeholderTextColor="#8A9BB5"
        />
      </Field>

      <Field label="Price Range">
        <View style={styles.priceRow}>
          {PRICE_OPTIONS.map((p) => (
            <TouchableOpacity
              key={p}
              style={[styles.priceBtn, form.priceRange === p && styles.priceBtnActive]}
              onPress={() => update('priceRange', form.priceRange === p ? '' : p)}
            >
              <Text style={[styles.priceBtnText, form.priceRange === p && styles.priceBtnTextActive]}>{p}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Field>

      <Field label="Layover-Friendly">
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Good for airport layovers</Text>
            {form.layoverSafe && (
              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                value={form.minimumLayoverMinutes}
                onChangeText={(v) => update('minimumLayoverMinutes', v)}
                placeholder="Min layover time (minutes)"
                placeholderTextColor="#8A9BB5"
                keyboardType="numeric"
              />
            )}
          </View>
          <Switch
            value={form.layoverSafe}
            onValueChange={(v) => update('layoverSafe', v)}
            trackColor={{ false: '#1E2D45', true: '#4C8BF5' }}
            thumbColor={form.layoverSafe ? '#fff' : '#8A9BB5'}
          />
        </View>
      </Field>
    </KeyboardSafeView>
  );
}

function PhotoStep({
  form,
  update,
}: {
  form: FormState;
  update: (k: keyof FormState, v: any) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { pickMedia } = useMediaPicker();

  const pickAndUpload = useCallback(async () => {
    setUploadError(null);
    const assets = await pickMedia({ title: 'Add gem photo', mediaTypes: ['images'], quality: 0.85 });
    if (!assets || !assets[0]) return;

    const asset = assets[0];

    setUploading(true);
    try {
      const uploaded = await uploadMedia({
        uri: asset.uri,
        mimeType: asset.mimeType ?? 'image/jpeg',
        fileName: asset.fileName ?? undefined,
        fileSize: asset.fileSize ?? undefined,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        type: 'image',
      });

      if (!uploaded.ok || !uploaded.url) {
        setUploadError(uploaded.message ?? 'Upload failed. Please try again.');
      } else {
        update('imageUrl', uploaded.url);
      }
    } catch (e: any) {
      setUploadError(e.message ?? 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }, [update]);

  const removePhoto = useCallback(() => {
    update('imageUrl', undefined);
    setUploadError(null);
  }, [update]);

  return (
    <KeyboardSafeView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
      <Text style={styles.stepHeading}>Add a photo</Text>
      <Text style={styles.stepSub}>
        A representative photo helps others recognise this gem. Optional — you can skip this step.
      </Text>

      {form.imageUrl ? (
        <View style={styles.photoPreviewWrapper}>
          <Image source={{ uri: form.imageUrl }} style={styles.photoPreview} resizeMode="cover" />
          <TouchableOpacity style={styles.photoRemoveBtn} onPress={removePhoto}>
            <Ionicons name="close-circle" size={28} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.photoPickerBtn}
          onPress={pickAndUpload}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator color="#4C8BF5" />
          ) : (
            <>
              <Ionicons name="camera-outline" size={36} color="#4C8BF5" />
              <Text style={styles.photoPickerText}>Choose a photo</Text>
              <Text style={styles.photoPickerSub}>JPEG or PNG, up to 10 MB</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {uploadError && (
        <View style={styles.photoError}>
          <Ionicons name="alert-circle-outline" size={16} color="#FF6B6B" />
          <Text style={styles.photoErrorText}>{uploadError}</Text>
        </View>
      )}

      {form.imageUrl && (
        <TouchableOpacity style={styles.photoReplaceBtn} onPress={pickAndUpload} disabled={uploading}>
          <Text style={styles.photoReplaceBtnText}>Replace photo</Text>
        </TouchableOpacity>
      )}
    </KeyboardSafeView>
  );
}

function PrivacyStep({ form, update }: { form: FormState; update: (k: keyof FormState, v: any) => void }) {
  return (
    <KeyboardSafeView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
      <Text style={styles.stepHeading}>Who can see the location?</Text>
      <Text style={styles.stepSub}>
        You can control exactly how much location detail is shared with others
      </Text>

      {SENSITIVITY_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.key}
          style={[styles.privacyOption, form.sensitivityLevel === opt.key && styles.privacyOptionActive]}
          onPress={() => update('sensitivityLevel', opt.key)}
        >
          <View style={[styles.privacyOptionCheck, form.sensitivityLevel === opt.key && styles.privacyOptionCheckActive]}>
            {form.sensitivityLevel === opt.key && <Ionicons name="checkmark" size={14} color="#fff" />}
          </View>
          <Ionicons name={opt.icon as any} size={22} color={form.sensitivityLevel === opt.key ? '#4C8BF5' : '#8A9BB5'} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.privacyOptionLabel, form.sensitivityLevel === opt.key && styles.activeText]}>
              {opt.label}
            </Text>
            <Text style={styles.privacyOptionDesc}>{opt.desc}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </KeyboardSafeView>
  );
}

function ReviewStep({ form }: { form: FormState }) {
  const hasCoords = form.gpsLat != null && form.gpsLng != null;

  return (
    <KeyboardSafeView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
      <Text style={styles.stepHeading}>Review your gem</Text>
      <Text style={styles.stepSub}>Double-check everything before submitting</Text>

      {hasCoords && (
        <View style={styles.mapPreviewSection}>
          <Text style={styles.mapPreviewLabel}>Pinned location</Text>
          <GemLocationPreview lat={form.gpsLat as number} lng={form.gpsLng as number} />
          {form.gpsLabel && (
            <Text style={styles.mapPreviewLocationText}>
              <Ionicons name="location-outline" size={13} color="#8A9BB5" />
              {' '}{form.gpsLabel}
            </Text>
          )}
        </View>
      )}

      {form.imageUrl && (
        <View style={styles.reviewPhotoSection}>
          <Text style={styles.mapPreviewLabel}>Photo</Text>
          <Image source={{ uri: form.imageUrl }} style={styles.reviewPhoto} resizeMode="cover" />
        </View>
      )}

      <View style={styles.reviewCard}>
        <ReviewRow label="Name"        value={form.name} />
        <ReviewRow label="Category"    value={form.category} />
        <ReviewRow label="City"        value={[form.neighborhood, form.city, form.country].filter(Boolean).join(', ')} />
        {!hasCoords && form.gpsLabel && <ReviewRow label="Location detected" value={form.gpsLabel} />}
        {form.description    && <ReviewRow label="Description"  value={form.description} />}
        {form.bestTimeToGo   && <ReviewRow label="Best Time"    value={form.bestTimeToGo} />}
        {form.safetyNotes    && <ReviewRow label="Safety Notes" value={form.safetyNotes} />}
        {form.priceRange     && <ReviewRow label="Price Range"  value={form.priceRange} />}
        {form.vibeTags       && <ReviewRow label="Vibe Tags"    value={form.vibeTags} />}
        {form.layoverSafe    && <ReviewRow label="Layover Safe" value={`Yes — ${form.minimumLayoverMinutes || '?'} min min`} />}
        <ReviewRow label="Privacy"     value={form.sensitivityLevel} />
      </View>

      <View style={styles.submissionNote}>
        <Ionicons name="information-circle-outline" size={18} color="#4C8BF5" />
        <Text style={styles.submissionNoteText}>
          Your gem will be submitted for review. Once approved it'll appear for the community.
        </Text>
      </View>
    </KeyboardSafeView>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewLabel}>{label}</Text>
      <Text style={styles.reviewValue} numberOfLines={3}>{value}</Text>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SubmitGemScreen() {
  const router = useRouter();
  const [step, setStep]       = useState(0);
  const [form, setForm]       = useState<FormState>(INITIAL);
  const [submitting, setSub]  = useState(false);

  const update = useCallback((key: keyof FormState, value: any) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const canNext = useCallback(() => wizardCanNext(step, form), [step, form]);

  const handleNext = useCallback(() => {
    if (step < STEPS.length - 1) { setStep((s) => s + 1); return; }
    // Submit
    void (async () => {
      const payload = buildSubmitPayload(form);
      if (!payload) {
        Alert.alert('Required', 'Name, category, and city are required.'); return;
      }
      setSub(true);
      try {
        await submitGem(payload);

        Alert.alert(
          'Gem Submitted!',
          'Thanks for sharing! Your gem will appear once it is reviewed by the community.',
          [{ text: 'Back to Gems', onPress: () => router.replace('/gems') }],
        );
      } catch (e: any) {
        Alert.alert('Error', e.message ?? 'Failed to submit gem. Please try again.');
      } finally {
        setSub(false);
      }
    })();
  }, [step, form, router]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header */}
      <View style={styles.wizardHeader}>
        <TouchableOpacity onPress={() => step > 0 ? setStep((s) => s - 1) : router.back()}>
          <Ionicons name="arrow-back" size={22} color="#E8F0FE" />
        </TouchableOpacity>
        <Text style={styles.wizardTitle}>Submit a Hidden Gem</Text>
        <View style={{ width: 22 }} />
      </View>

      {/* Progress */}
      <View style={styles.progressRow}>
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <View style={[styles.progressDot, i <= step && styles.progressDotActive]}>
              {i < step
                ? <Ionicons name="checkmark" size={12} color="#fff" />
                : <Text style={styles.progressDotText}>{i + 1}</Text>}
            </View>
            {i < STEPS.length - 1 && (
              <View style={[styles.progressLine, i < step && styles.progressLineActive]} />
            )}
          </React.Fragment>
        ))}
      </View>
      <Text style={styles.stepLabel}>{STEPS[step]}</Text>

      {/* Step content */}
      <View style={{ flex: 1 }}>
        {step === 0 && <LocationStep form={form} update={update} />}
        {step === 1 && <DetailsStep form={form} update={update} />}
        {step === 2 && <PhotoStep form={form} update={update} />}
        {step === 3 && <PrivacyStep form={form} update={update} />}
        {step === 4 && <ReviewStep form={form} />}
      </View>

      {/* Footer CTA */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.nextBtn, (!canNext() || submitting) && styles.btnDisabled]}
          onPress={handleNext}
          disabled={!canNext() || submitting}
        >
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.nextBtnText}>
                {step === STEPS.length - 1 ? 'Submit Gem' : 'Next'}
              </Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A1628' },

  wizardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  wizardTitle: { fontSize: 17, fontWeight: '700', color: '#E8F0FE' },

  progressRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 28, marginBottom: 4 },
  progressDot: {
    width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2,
    borderWidth: 2, borderColor: '#2A3D5E',
    alignItems: 'center', justifyContent: 'center',
  },
  progressDotActive: { backgroundColor: '#4C8BF5', borderColor: '#4C8BF5' },
  progressDotText: { color: '#8A9BB5', fontSize: 12, fontWeight: '700' },
  progressLine: { flex: 1, height: 2, backgroundColor: '#1E2D45', marginHorizontal: 4 },
  progressLineActive: { backgroundColor: '#4C8BF5' },
  stepLabel: { textAlign: 'center', color: '#4C8BF5', fontWeight: '600', fontSize: 13, marginBottom: 8 },

  stepContent: { padding: 20, paddingBottom: 40 },
  stepHeading: { fontSize: 22, fontWeight: '800', color: '#E8F0FE', marginBottom: 4 },
  stepSub: { color: '#8A9BB5', fontSize: 14, marginBottom: 24, lineHeight: 20 },

  field: { marginBottom: 20 },
  fieldLabel: { color: '#8A9BB5', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  input: {
    backgroundColor: '#13213A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E2D45',
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#E8F0FE',
    fontSize: 15,
  },
  textArea: { minHeight: 90, textAlignVertical: 'top', paddingTop: 12 },

  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 12, borderWidth: 1, borderColor: '#2A3D5E',
    paddingHorizontal: 12, paddingVertical: 8,
  },
  catBtnActive: { backgroundColor: '#4C8BF5', borderColor: '#4C8BF5' },
  catBtnText: { color: '#8A9BB5', fontSize: 13, fontWeight: '500' },
  catBtnTextActive: { color: '#fff', fontWeight: '700' },

  priceRow: { flexDirection: 'row', gap: 8 },
  priceBtn: {
    borderRadius: 10, borderWidth: 1, borderColor: '#2A3D5E',
    paddingHorizontal: 14, paddingVertical: 8,
  },
  priceBtnActive: { backgroundColor: '#4C8BF5', borderColor: '#4C8BF5' },
  priceBtnText: { color: '#8A9BB5', fontWeight: '600' },
  priceBtnTextActive: { color: '#fff' },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchLabel: { color: '#E8F0FE', fontSize: 15 },

  // Photo step
  photoPickerBtn: {
    borderWidth: 2, borderColor: '#2A3D5E', borderStyle: 'dashed',
    borderRadius: 16, paddingVertical: 48,
    alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#13213A',
  },
  photoPickerText: { color: '#4C8BF5', fontSize: 16, fontWeight: '700' },
  photoPickerSub: { color: '#8A9BB5', fontSize: 13 },
  photoPreviewWrapper: { position: 'relative', borderRadius: 16, overflow: 'hidden', marginBottom: 12 },
  photoPreview: { width: '100%', height: 220, borderRadius: 16 },
  photoRemoveBtn: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
  },
  photoReplaceBtn: { alignItems: 'center', paddingVertical: 10 },
  photoReplaceBtnText: { color: '#4C8BF5', fontWeight: '600', fontSize: 14 },
  photoError: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 12, padding: 12, borderRadius: 10,
    backgroundColor: '#1A1020', borderWidth: 1, borderColor: '#FF6B6B33',
  },
  photoErrorText: { flex: 1, color: '#FF6B6B', fontSize: 13, lineHeight: 18 },

  privacyOption: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 14, borderRadius: 14, borderWidth: 1, borderColor: '#1E2D45',
    backgroundColor: '#13213A', marginBottom: 10,
  },
  privacyOptionActive: { borderColor: '#4C8BF5', backgroundColor: '#0D1F3A' },
  privacyOptionCheck: {
    width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2,
    borderWidth: 2, borderColor: '#2A3D5E',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  privacyOptionCheckActive: { backgroundColor: '#4C8BF5', borderColor: '#4C8BF5' },
  privacyOptionLabel: { color: '#B0C4DE', fontWeight: '700', fontSize: 15, marginBottom: 2 },
  activeText: { color: '#E8F0FE' },
  privacyOptionDesc: { color: '#8A9BB5', fontSize: 13, lineHeight: 18 },

  mapPreviewSection: { marginBottom: 20 },
  mapPreviewLabel: { color: '#8A9BB5', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  mapPreviewLocationText: {
    marginTop: 8, color: '#8A9BB5', fontSize: 13, lineHeight: 18,
  },

  reviewPhotoSection: { marginBottom: 20 },
  reviewPhoto: { width: '100%', height: 160, borderRadius: 12 },

  reviewCard: {
    backgroundColor: '#13213A', borderRadius: 14,
    borderWidth: 1, borderColor: '#1E2D45', padding: 16, marginBottom: 16,
  },
  reviewRow: {
    flexDirection: 'row', paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#1E2D45',
  },
  reviewLabel: { color: '#8A9BB5', fontSize: 13, width: 110 },
  reviewValue: { flex: 1, color: '#E8F0FE', fontSize: 14, lineHeight: 20 },

  submissionNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: '#0D1F3A', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#1E2D45',
  },
  submissionNoteText: { flex: 1, color: '#8A9BB5', fontSize: 13, lineHeight: 19 },

  footer: {
    paddingHorizontal: 20, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: '#1E2D45',
  },
  nextBtn: {
    backgroundColor: '#4C8BF5', borderRadius: 14, paddingVertical: 15, alignItems: 'center',
  },
  pickPlaceBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  pickPlaceText: { fontSize: 13, fontWeight: '600', color: '#2F6F8F' },
  btnDisabled: { opacity: 0.5 },
  nextBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },

});
