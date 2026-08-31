import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { Stamp, Chip } from '../../src/components/ui';
import type { Interest, TravelStyle } from '../../src/types/models';
import { color, space, radius, type as t, dot } from '../../src/theme/tokens';
import { getMyProfile } from '../../src/services/profile';
import { runOnboardingFinish } from '../../src/services/onboardingFinish';
import { buildOnboardingPatch } from '../../src/services/profilePatchBuilder';
import { buildOnboardingSaveAlert } from '../../src/services/profileSaveFlow';
import { getCurrentGps, reverseGeocodeToPlace } from '../../src/services/location';
import { runFillHomeFromGps } from '../../src/services/fillHomeFromGps.machine';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { DatePickerField } from '../../src/components/DatePickerField';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';
import { bumpSocialVersion } from '../../src/hooks/useSocialVersion'; // for "Continue anyway" path
import { useUsernameAvailability } from '../../src/hooks/useUsernameAvailability';
import {
  sanitizeUsername,
  USERNAME_MAX_LENGTH,
} from '../../src/platform/input-assistance/social/usernameValidation';

const INTERESTS: Interest[] = ['nightlife','beach','food','luxury','backpacking','culture','adventure','shopping','photography','business','dating','wellness','events'];
const STYLES: TravelStyle[] = ['solo','couple','group','business'];
const TOTAL_STEPS = 5;
const DISPLAY_NAME_MAX = 30;

/** Returns age in full years from a YYYY-MM-DD string, or null if invalid. */
function computeAge(dob: string): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const birth = new Date(dob + 'T00:00:00');
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

export default function Onboarding() {
  const plainInset = usePlainBottomInset();
  const [step, setStep] = useState(0);
  const [checking, setChecking] = useState(true);

  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  // A username the profile already owns — never re-checked for availability.
  const [loadedUsername, setLoadedUsername] = useState('');
  const [homeCity, setHomeCity] = useState('');
  const [homeCountry, setHomeCountry] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [dobError, setDobError] = useState<string | null>(null);
  const [style, setStyle] = useState<TravelStyle>('solo');
  const [picked, setPicked] = useState<Interest[]>([]);
  const [saving, setSaving] = useState(false);
  const [gpsLoadingHome, setGpsLoadingHome] = useState(false);
  const [showHomePicker, setShowHomePicker] = useState(false);

  const toggle = (i: Interest) => setPicked((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i]);

  // Same non-blocking availability + min-length validation the identity screen
  // enforces (§23) — reuses the single shared rule set so a handle accepted here
  // can no longer be rejected on the identity screen. Username is optional: an
  // empty (or already-owned) handle is idle, never invalid.
  const { status: usernameStatus, message: usernameMessage } = useUsernameAvailability(
    handle,
    { skipValue: loadedUsername },
  );
  const usernameBlocking =
    handle.length > 0 &&
    (usernameStatus === 'invalid' || usernameStatus === 'taken' || usernameStatus === 'checking');

  const fillHomeFromGps = useCallback(async () => {
    await runFillHomeFromGps(
      {
        getCurrentGps,
        reverseGeocodeDetailed: reverseGeocodeToPlace,
        onPermissionDenied: () => {
          Alert.alert(
            'Location permission is off',
            'Enable it in settings or choose a city/place from search.',
            [
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
              { text: 'Choose from list', onPress: () => setShowHomePicker(true) },
              { text: 'Cancel', style: 'cancel' },
            ],
          );
        },
        onGpsOrGeocodeFailed: () => {
          Alert.alert(
            'Could not detect location',
            'GPS or reverse-geocoding failed. Choose a city manually instead.',
            [
              { text: 'Choose from list', onPress: () => setShowHomePicker(true) },
              { text: 'Cancel', style: 'cancel' },
            ],
          );
        },
      },
      {
        setHomeCity,
        setHomeCountry,
        setGpsLoading: setGpsLoadingHome,
      },
    );
  }, []);

  useEffect(() => {
    getMyProfile().then((res) => {
      if (res.ok && res.data) {
        const p = res.data;
        if (p.displayName && p.username) {
          router.replace('/(tabs)' as any);
          return;
        }
        if (p.displayName) setDisplayName(p.displayName);
        if (p.username) { setHandle(p.username); setLoadedUsername(p.username); }
        if ((p as any).homeCity) setHomeCity((p as any).homeCity);
        if ((p as any).homeCountry) setHomeCountry((p as any).homeCountry);
        if ((p as any).travelStyle) setStyle((p as any).travelStyle as TravelStyle);
        if ((p as any).interests?.length) setPicked((p as any).interests as Interest[]);
      }
      setChecking(false);
    }).catch(() => setChecking(false));
  }, []);

  async function handleFinish() {
    const trimmedName = displayName.trim();
    if (trimmedName.length > DISPLAY_NAME_MAX) {
      Alert.alert('Display name too long', `Please shorten your display name to ${DISPLAY_NAME_MAX} characters or fewer.`);
      return;
    }
    setSaving(true);
    const patch = buildOnboardingPatch({ displayName: trimmedName, handle, homeCity, homeCountry, travelStyle: style, interests: picked });
    if (dateOfBirth) (patch as any).dateOfBirth = dateOfBirth;
    await runOnboardingFinish({
      patch,
      onComplete: () => {
        setSaving(false);
        router.replace('/(tabs)' as any);
      },
      onError: (result) => {
        setSaving(false);
        const alert = buildOnboardingSaveAlert(result);
        Alert.alert(
          alert.title,
          alert.message,
          [
            // "Continue anyway" also bumps so mounted hooks pick up @Portava.
            { text: 'Continue anyway', onPress: () => { bumpSocialVersion(); router.replace('/(tabs)' as any); } },
            { text: 'Retry', onPress: handleFinish },
          ],
        );
      },
    });
  }

  function handleNext() {
    // Block advancing past the name/handle step while the (optional) username is
    // too short, taken, or still being checked — matching the identity screen.
    if (step === 0 && usernameBlocking) return;
    // Validate DOB step before advancing
    if (step === 1) {
      if (!dateOfBirth) {
        setDobError('Please enter your date of birth.');
        return;
      }
      const age = computeAge(dateOfBirth);
      if (age === null) {
        setDobError('Please enter a valid date.');
        return;
      }
      if (age < 18) {
        setDobError('You must be at least 18 years old to use this app.');
        return;
      }
      setDobError(null);
    }
    if (step < TOTAL_STEPS - 1) setStep((s) => s + 1);
    else handleFinish();
  }

  function handleBack() {
    if (step > 0) setStep((s) => s - 1);
  }

  if (checking) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  const nextDisabled = saving
    || (step === 0 && !displayName.trim())
    || (step === 0 && usernameBlocking)
    || (step === 1 && !dateOfBirth);
  const isLastStep = step === TOTAL_STEPS - 1;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.progress}>
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <View key={i} style={[styles.dot, i === step && styles.dotActive, i < step && styles.dotDone]} />
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingTop: space.xl, gap: space.xl, paddingBottom: plainInset }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 0 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 1 of 5" tone="signal" />
              <Text style={styles.title}>What should{'\n'}we call you?</Text>
              <Text style={styles.sub}>Your name and handle appear on your passport.</Text>
            </View>
            <View style={{ gap: space.md }}>
              <View>
                <View style={styles.labelRow}>
                  <Text style={styles.label}>Display name *</Text>
                  <Text style={styles.charCount}>{displayName.length}/{DISPLAY_NAME_MAX}</Text>
                </View>
                <TextInput
                  style={styles.input}
                  value={displayName}
                  onChangeText={(text) => setDisplayName(text.slice(0, DISPLAY_NAME_MAX))}
                  placeholder="e.g. Drae Torres"
                  placeholderTextColor={color.faint}
                  autoCapitalize="words"
                  autoFocus
                  maxLength={DISPLAY_NAME_MAX}
                  returnKeyType="next"
                  testID="display-name-input"
                />
                <Text style={styles.hint}>Maximum 30 characters.</Text>
              </View>
              <View>
                <Text style={styles.label}>Username (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={handle}
                  onChangeText={(v) => setHandle(sanitizeUsername(v))}
                  placeholder="@yourhandle"
                  placeholderTextColor={color.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={USERNAME_MAX_LENGTH}
                  returnKeyType="done"
                  testID="onboarding-username-input"
                />
                {usernameStatus === 'checking' ? (
                  <View style={styles.usernameStatusRow}>
                    <ActivityIndicator size="small" color={color.signal} />
                    <Text style={styles.hint}>Checking availability…</Text>
                  </View>
                ) : usernameMessage ? (
                  <Text
                    style={[
                      styles.hint,
                      usernameStatus === 'available' ? styles.hintSuccess : styles.hintError,
                    ]}
                  >
                    {usernameMessage}
                  </Text>
                ) : usernameStatus === 'available' ? (
                  <Text style={[styles.hint, styles.hintSuccess]}>Username available</Text>
                ) : (
                  <Text style={styles.hint}>Letters, numbers, . and _ only. Can be changed later.</Text>
                )}
              </View>
            </View>
          </View>
        )}

        {step === 1 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 2 of 5" tone="signal" />
              <Text style={styles.title}>How old{'\n'}are you?</Text>
              <Text style={styles.sub}>You must be 18 or older to use this app.</Text>
            </View>
            <View style={{ gap: space.md }}>
              <View>
                <Text style={styles.label}>Date of birth *</Text>
                <DatePickerField
                  value={dateOfBirth}
                  onChange={(v) => { setDateOfBirth(v); setDobError(null); }}
                  placeholder="Select your date of birth"
                />
                {dobError
                  ? <Text style={styles.dobErrorText}>{dobError}</Text>
                  : <Text style={styles.hint}>Your date of birth is kept private and never shown publicly.</Text>
                }
              </View>
            </View>
          </View>
        )}

        {step === 2 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 3 of 5" tone="signal" />
              <Text style={styles.title}>Where are{'\n'}you from?</Text>
              <Text style={styles.sub}>Helps us surface relevant places and travelers.</Text>
            </View>
            <View style={{ gap: space.md }}>
              <View>
                <Text style={styles.label}>Home city (optional)</Text>
                <Pressable
                  style={[styles.input, styles.locationDisplay]}
                  onPress={() => setShowHomePicker(true)}
                >
                  <Text style={homeCity ? styles.locationText : styles.locationPlaceholder}>
                    {homeCity || 'Tap to select — or use GPS below'}
                  </Text>
                </Pressable>
                <View style={styles.locationActions}>
                  <Pressable
                    style={styles.locationBtn}
                    onPress={fillHomeFromGps}
                    disabled={gpsLoadingHome}
                  >
                    {gpsLoadingHome
                      ? <ActivityIndicator size="small" color={color.signal} />
                      : <Text style={styles.locationBtnText}>⊕ Use my current location</Text>
                    }
                  </Pressable>
                  <Pressable style={styles.locationBtn} onPress={() => setShowHomePicker(true)}>
                    <Text style={styles.locationBtnText}>≡ Choose from list</Text>
                  </Pressable>
                </View>
                <Text style={styles.hint}>We'll use GPS to detect your location. Your precise location is never shown publicly.</Text>
              </View>
              <View>
                <Text style={styles.label}>Country (optional)</Text>
                <View style={[styles.input, styles.locationDisplay]}>
                  <Text style={homeCountry ? styles.locationText : styles.locationPlaceholder}>
                    {homeCountry || 'Auto-filled from city selection above'}
                  </Text>
                </View>
                <Text style={styles.hint}>Set automatically when you pick a home city.</Text>
              </View>
            </View>
          </View>
        )}

        {step === 3 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 4 of 5" tone="signal" />
              <Text style={styles.title}>How do you{'\n'}travel?</Text>
              <Text style={styles.sub}>We'll connect you with compatible travelers.</Text>
            </View>
            <View style={styles.wrap}>
              {STYLES.map((s) => <Chip key={s} label={s} active={s === style} onPress={() => setStyle(s)} />)}
            </View>
          </View>
        )}

        {step === 4 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 5 of 5" tone="signal" />
              <Text style={styles.title}>What are{'\n'}you into?</Text>
              <Text style={styles.sub}>We'll tune your feed and who you meet.</Text>
            </View>
            <View style={styles.wrap}>
              {INTERESTS.map((i) => <Chip key={i} label={i} active={picked.includes(i)} onPress={() => toggle(i)} />)}
            </View>
          </View>
        )}
      </ScrollView>

      <View style={styles.navRow}>
        {step > 0 ? (
          <Pressable style={styles.backBtn} onPress={handleBack}>
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pressable
          style={[styles.nextBtn, nextDisabled && styles.nextBtnDisabled]}
          onPress={handleNext}
          disabled={nextDisabled}
          testID="onboarding-next-btn"
        >
          {saving
            ? <ActivityIndicator color={color.onInk} />
            : <Text style={styles.nextBtnText}>{isLastStep ? 'Enter Portava' : 'Next →'}</Text>
          }
        </Pressable>
      </View>

      <ManualCityPicker
        visible={showHomePicker}
        onClose={() => setShowHomePicker(false)}
        onSelect={(place) => {
          if (place.city) setHomeCity(place.city);
          if (place.country) setHomeCountry(place.country);
          setShowHomePicker(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  progress: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    paddingTop: space.xxxl,
    paddingBottom: space.md,
  },
  dot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2, backgroundColor: color.haze },
  dotActive: { backgroundColor: color.signal, width: 20 },
  dotDone: { backgroundColor: color.deep },
  title: { ...t.hero, fontSize: 32, lineHeight: 34, color: color.ink, marginTop: space.md },
  sub: { ...t.body, color: color.mute, marginTop: space.sm },
  label: { ...t.small, fontWeight: '600' as const, color: color.deep, marginBottom: 6 },
  input: {
    borderWidth: 1.5,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 11,
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
  },
  hint: { ...t.small, color: color.faint, marginTop: 4 },
  hintSuccess: { color: color.success },
  hintError: { color: color.signal },
  usernameStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  dobErrorText: { ...t.small, color: color.signal, marginTop: 4 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  charCount: { ...t.small, color: color.faint, fontWeight: '600' as const },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  navRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    backgroundColor: color.paper,
  },
  backBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: color.haze,
  },
  backBtnText: { ...t.heading, color: color.deep },
  locationDisplay: { justifyContent: 'center', minHeight: 44 },
  locationText: { ...t.body, color: color.ink },
  locationPlaceholder: { ...t.body, color: color.faint },
  locationActions: { flexDirection: 'row', gap: space.sm, marginTop: 6 },
  locationBtn: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 7,
  },
  locationBtnText: { ...t.small, color: color.deep, fontWeight: '600' },
  nextBtn: {
    flex: 2,
    backgroundColor: color.signal,
    paddingVertical: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  nextBtnDisabled: { opacity: 0.5 },
  nextBtnText: { ...t.heading, color: color.onInk },
});
