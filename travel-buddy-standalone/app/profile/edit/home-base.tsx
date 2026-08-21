/**
 * Home Base — view and edit homeCity / homeCountry / currentCity.
 * Uses the same patterns as identity.tsx (GPS fill, ManualCityPicker, save flow).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable, Alert, Linking, StyleSheet } from 'react-native';
import { getMyProfile, updateMyProfile } from '../../../src/services/profile';
import { resolveProfileSaveOutcome } from '../../../src/services/profileSaveFlow';
import { getCurrentGps, reverseGeocodeToPlace } from '../../../src/services/location';
import { runIdentityGpsFill } from '../../../src/services/identityGpsFill';
import { ManualCityPicker } from '../../../src/components/ManualCityPicker';
import type { OwnProfile } from '../../../src/types/models';
import {
  buildProfileLocationPatch,
  normalizeProfileCitySelection,
  profileLocationFieldsFrom,
  type ProfileLocationFields,
} from '../../../src/lib/location/profileLocationFields';
import { PP } from '../../../src/theme/passportTokens';
import { space } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SaveBar, useUnsavedGuard, useSavedThenBack,
  FieldLabel, FieldHint, TextField, type SaveState,
} from '../../../src/components/settings/SettingsUI';

export default function HomeBaseScreen() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProfileLocationFields>({ homeCity: '', homeCountry: '', currentCity: '' });
  const [originalForm, setOriginalForm] = useState<ProfileLocationFields | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveLockRef = useRef(false);
  const savedThenBack = useSavedThenBack(setSaveState);

  const [showHomePicker, setShowHomePicker] = useState(false);
  const [showCurrentPicker, setShowCurrentPicker] = useState(false);
  const [gpsLoadingHome, setGpsLoadingHome] = useState(false);
  const [gpsLoadingCurrent, setGpsLoadingCurrent] = useState(false);

  const isDirty = originalForm !== null && (
    form.homeCity !== originalForm.homeCity ||
    form.homeCountry !== originalForm.homeCountry ||
    form.currentCity !== originalForm.currentCity
  );
  const isSaving = saveState === 'saving';
  useUnsavedGuard(isDirty);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p: OwnProfile = res.data;
        const initial = profileLocationFieldsFrom(p);
        setForm(initial);
        setOriginalForm(initial);
      }
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const fillHomeFromGps = useCallback(async () => {
    await runIdentityGpsFill({
      getCurrentGps,
      reverseGeocode: reverseGeocodeToPlace,
      onPermissionDenied: () =>
        Alert.alert(
          'Location permission is off',
          'Enable it in settings or choose a city from the list.',
          [
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
            { text: 'Choose from list', onPress: () => setShowHomePicker(true) },
            { text: 'Cancel', style: 'cancel' },
          ],
        ),
      onGpsOrGeocodeFailed: () =>
        Alert.alert(
          'Could not detect your location',
          'There was a problem getting your location. You can choose a city from the list instead.',
          [
            { text: 'Choose from list', onPress: () => setShowHomePicker(true) },
            { text: 'Cancel', style: 'cancel' },
          ],
        ),
      onSuccess: (city, country) => {
        if (saveLockRef.current) return;
        setForm((f) => ({
          ...f,
          homeCity: city ?? f.homeCity,
          homeCountry: country ?? f.homeCountry,
        }));
      },
      setLoading: setGpsLoadingHome,
    });
  }, []);

  const fillCurrentFromGps = useCallback(async () => {
    await runIdentityGpsFill({
      getCurrentGps,
      reverseGeocode: reverseGeocodeToPlace,
      onPermissionDenied: () =>
        Alert.alert(
          'Location permission is off',
          'Enable it in settings or choose a city from the list.',
          [
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
            { text: 'Choose from list', onPress: () => setShowCurrentPicker(true) },
            { text: 'Cancel', style: 'cancel' },
          ],
        ),
      onGpsOrGeocodeFailed: () =>
        Alert.alert(
          'Could not detect your location',
          'There was a problem getting your location. You can choose a city from the list instead.',
          [
            { text: 'Choose from list', onPress: () => setShowCurrentPicker(true) },
            { text: 'Cancel', style: 'cancel' },
          ],
        ),
      onSuccess: (city, _country) => {
        if (saveLockRef.current) return;
        setForm((f) => ({
          ...f,
          currentCity: city ?? f.currentCity,
        }));
      },
      setLoading: setGpsLoadingCurrent,
    });
  }, []);

  const handleSave = async () => {
    if (saveLockRef.current || !isDirty) return;
    saveLockRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    try {
      const patch = buildProfileLocationPatch(
        form,
        originalForm ?? { homeCity: '', homeCountry: '', currentCity: '' },
      );

      if (Object.keys(patch).length === 0) {
        setSaveState('idle');
        saveLockRef.current = false;
        return;
      }

      const res = await updateMyProfile(patch);
      const outcome = resolveProfileSaveOutcome(res);
      if (outcome.kind === 'error') {
        setSaveError(outcome.message);
        setSaveState('error');
        saveLockRef.current = false;
        return;
      }

      const savedProfile = res.data;
      const savedForm = savedProfile
        ? profileLocationFieldsFrom(savedProfile)
        : profileLocationFieldsFrom({
          homeCity: patch.homeCity === undefined ? form.homeCity : patch.homeCity,
          homeCountry: patch.homeCountry === undefined ? form.homeCountry : patch.homeCountry,
          currentCity: patch.currentCity === undefined ? form.currentCity : patch.currentCity,
        });
      setForm(savedForm);
      setOriginalForm(savedForm);
      savedThenBack();
    } finally {
      saveLockRef.current = false;
    }
  };

  if (loading) {
    return (
      <SettingsScreen title="Home Base">
        <View style={st.loadingWrap}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Home Base">
      <SettingsSection title="Location" subtitle="Where you're from and where you are now">
        <View style={st.field}>
          <FieldLabel>Home City</FieldLabel>
          <Pressable
            style={st.locationDisplay}
            onPress={() => setShowHomePicker(true)}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel="Select home city"
          >
            <Text style={form.homeCity ? st.locationText : st.locationPlaceholder}>
              {form.homeCity || 'Tap to select — or use GPS below'}
            </Text>
          </Pressable>
          <View style={st.locationActions}>
            <Pressable style={st.locationBtn} onPress={fillHomeFromGps} disabled={gpsLoadingHome || isSaving}>
              {gpsLoadingHome
                ? <ActivityIndicator size="small" color={PP.ink} />
                : <Text style={st.locationBtnText}>⊕ Use my current location</Text>}
            </Pressable>
            <Pressable style={st.locationBtn} onPress={() => setShowHomePicker(true)} disabled={isSaving}>
              <Text style={st.locationBtnText}>≡ Choose from list</Text>
            </Pressable>
            {(form.homeCity || form.homeCountry) ? (
              <Pressable
                style={st.locationBtn}
                onPress={() => setForm((f) => ({ ...f, homeCity: '', homeCountry: '' }))}
                disabled={isSaving}
                accessibilityRole="button"
                accessibilityLabel="Clear home city"
              >
                <Text style={st.locationBtnText}>Clear home base</Text>
              </Pressable>
            ) : null}
          </View>
          <FieldHint>Shown on your public passport as your home.</FieldHint>
        </View>

        <View style={st.field}>
          <FieldLabel>Home Country</FieldLabel>
          <View style={st.locationDisplay}>
            <Text style={form.homeCountry ? st.locationText : st.locationPlaceholder}>
              {form.homeCountry || 'Auto-filled from city selection above'}
            </Text>
          </View>
          <FieldHint>Set automatically when you pick a home city.</FieldHint>
        </View>

        <View style={st.field}>
          <FieldLabel>Current City</FieldLabel>
          <TextField
            value={form.currentCity}
            onChangeText={(text) => setForm((f) => ({ ...f, currentCity: text }))}
            editable={!isSaving}
            placeholder="Where are you right now?"
            maxLength={100}
            autoCapitalize="words"
            returnKeyType="done"
          />
          <View style={st.locationActions}>
            <Pressable style={st.locationBtn} onPress={fillCurrentFromGps} disabled={gpsLoadingCurrent || isSaving}>
              {gpsLoadingCurrent
                ? <ActivityIndicator size="small" color={PP.ink} />
                : <Text style={st.locationBtnText}>⊕ Use my current location</Text>}
            </Pressable>
            <Pressable style={st.locationBtn} onPress={() => setShowCurrentPicker(true)} disabled={isSaving}>
              <Text style={st.locationBtnText}>≡ Choose from list</Text>
            </Pressable>
          </View>
          <FieldHint>Shown on your profile when enabled in privacy settings.</FieldHint>
        </View>
      </SettingsSection>

      <SaveBar state={saveState} onPress={handleSave} disabled={!isDirty} error={saveError} />

      <ManualCityPicker
        visible={showHomePicker && !isSaving}
        onClose={() => setShowHomePicker(false)}
        onSelect={(place) => {
          if (saveLockRef.current) return;
          const selected = normalizeProfileCitySelection(place);
          setForm((f) => ({
            ...f,
            homeCity: selected.city,
            homeCountry: selected.country,
          }));
          setShowHomePicker(false);
        }}
      />
      <ManualCityPicker
        visible={showCurrentPicker && !isSaving}
        onClose={() => setShowCurrentPicker(false)}
        onSelect={(place) => {
          if (saveLockRef.current) return;
          const selected = normalizeProfileCitySelection(place);
          setForm((f) => ({ ...f, currentCity: selected.city }));
          setShowCurrentPicker(false);
        }}
      />
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  loadingWrap: { paddingVertical: space.xxxl, alignItems: 'center' },
  field: { padding: space.md, gap: space.xs },
  locationDisplay: {
    backgroundColor: '#FFFDF7',
    borderWidth: 1, borderColor: PP.border, borderRadius: 8,
    paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 44, justifyContent: 'center',
  },
  locationText: { fontSize: 15, color: PP.ink },
  locationPlaceholder: { fontSize: 15, color: PP.inkMuted + '99' },
  locationActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  locationBtn: {
    paddingHorizontal: space.md, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: PP.border, backgroundColor: '#FFFDF7', minHeight: 36, justifyContent: 'center',
  },
  locationBtnText: { fontSize: 13, color: PP.ink, fontWeight: '600' },
});
