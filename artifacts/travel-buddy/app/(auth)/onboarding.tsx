import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { Stamp, Chip } from '../../src/components/ui';
import type { Interest, TravelStyle } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { updateMyProfile, getMyProfile } from '../../src/services/profile';
import { buildOnboardingPatch } from '../../src/services/profilePatchBuilder';
import { buildOnboardingSaveAlert } from '../../src/services/profileSaveFlow';
import { getCurrentGps, reverseGeocodeToPlace } from '../../src/services/location';
import { runFillHomeFromGps } from '../../src/services/fillHomeFromGps.machine';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';

const INTERESTS: Interest[] = ['nightlife','beach','food','luxury','backpacking','culture','adventure','shopping','photography','business','dating','wellness','events'];
const STYLES: TravelStyle[] = ['solo','couple','group','business'];
const TOTAL_STEPS = 4;
const DISPLAY_NAME_MAX = 30;

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const [checking, setChecking] = useState(true);

  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [homeCity, setHomeCity] = useState('');
  const [homeCountry, setHomeCountry] = useState('');
  const [style, setStyle] = useState<TravelStyle>('solo');
  const [picked, setPicked] = useState<Interest[]>([]);
  const [saving, setSaving] = useState(false);
  const [gpsLoadingHome, setGpsLoadingHome] = useState(false);
  const [showHomePicker, setShowHomePicker] = useState(false);

  const toggle = (i: Interest) => setPicked((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i]);

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
        if (p.username) setHandle(p.username);
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
    const result = await updateMyProfile(patch);
    setSaving(false);
    if (!result.ok && result.errorKind !== 'config_error' && result.errorKind !== 'unauthenticated') {
      const alert = buildOnboardingSaveAlert(result);
      Alert.alert(
        alert.title,
        alert.message,
        [
          { text: 'Continue anyway', onPress: () => router.replace('/(tabs)' as any) },
          { text: 'Retry', onPress: handleFinish },
        ],
      );
      return;
    }
    router.replace('/(tabs)' as any);
  }

  function handleNext() {
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

  const nextDisabled = saving || (step === 0 && !displayName.trim());
  const isLastStep = step === TOTAL_STEPS - 1;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.progress}>
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <View key={i} style={[styles.dot, i === step && styles.dotActive, i < step && styles.dotDone]} />
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingTop: space.xl, gap: space.xl, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 0 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 1 of 4" tone="signal" />
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
                />
                <Text style={styles.hint}>Maximum 40 characters.</Text>
              </View>
              <View>
                <Text style={styles.label}>Username (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={handle}
                  onChangeText={(v) => setHandle(v.replace(/[^a-z0-9_.]/gi, '').toLowerCase())}
                  placeholder="@yourhandle"
                  placeholderTextColor={color.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                />
                <Text style={styles.hint}>Letters, numbers, . and _ only. Can be changed later.</Text>
              </View>
            </View>
          </View>
        )}

        {step === 1 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 2 of 4" tone="signal" />
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

        {step === 2 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 3 of 4" tone="signal" />
              <Text style={styles.title}>How do you{'\n'}travel?</Text>
              <Text style={styles.sub}>We'll connect you with compatible travelers.</Text>
            </View>
            <View style={styles.wrap}>
              {STYLES.map((s) => <Chip key={s} label={s} active={s === style} onPress={() => setStyle(s)} />)}
            </View>
          </View>
        )}

        {step === 3 && (
          <View style={{ gap: space.xl }}>
            <View>
              <Stamp label="step 4 of 4" tone="signal" />
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
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.haze },
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
