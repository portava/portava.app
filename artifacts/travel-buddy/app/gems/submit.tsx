/**
 * Gem submission screen
 * Route: /gems/submit
 *
 * Multi-step wizard: Location → Details → Privacy → Review & Submit
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { submitGem, type GemCategory, type GemSensitivity } from '../../src/services/hiddenGems';
import { GpsLocationCapture } from '../../src/components/location/GpsLocationCapture';
import type { Place } from '../../src/lib/location/placeTypes';
import { canNext as wizardCanNext, buildSubmitPayload } from '../../src/lib/gems/submitMachine';
import { GemLocationPreview } from '../../src/components/gems/GemLocationPreview';

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

const STEPS = ['Location', 'Details', 'Privacy', 'Review'];

// ── Step components ────────────────────────────────────────────────────────────

function LocationStep({ form, update }: { form: FormState; update: (k: keyof FormState, v: any) => void }) {
  const handleCapture = useCallback((place: Place | null) => {
    update('gpsLat', place?.lat ?? undefined);
    update('gpsLng', place?.lng ?? undefined);
    update('gpsLabel', place?.displayName ?? undefined);
  }, [update]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
      <Text style={styles.stepHeading}>Where is it?</Text>
      <Text style={styles.stepSub}>Tell us where the gem is located</Text>

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
    </ScrollView>
  );
}

function DetailsStep({ form, update }: { form: FormState; update: (k: keyof FormState, v: any) => void }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
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
    </ScrollView>
  );
}

function PrivacyStep({ form, update }: { form: FormState; update: (k: keyof FormState, v: any) => void }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
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
    </ScrollView>
  );
}

function ReviewStep({ form }: { form: FormState }) {
  const hasCoords = form.gpsLat != null && form.gpsLng != null;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.stepContent}>
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
    </ScrollView>
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
        {step === 2 && <PrivacyStep form={form} update={update} />}
        {step === 3 && <ReviewStep form={form} />}
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
    width: 28, height: 28, borderRadius: 14,
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

  privacyOption: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 14, borderRadius: 14, borderWidth: 1, borderColor: '#1E2D45',
    backgroundColor: '#13213A', marginBottom: 10,
  },
  privacyOptionActive: { borderColor: '#4C8BF5', backgroundColor: '#0D1F3A' },
  privacyOptionCheck: {
    width: 20, height: 20, borderRadius: 10,
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
  btnDisabled: { opacity: 0.5 },
  nextBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
