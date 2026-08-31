/**
 * Identity — Display name, username, bio, date of birth, home/current location,
 * spoken languages. Logic copied verbatim from the legacy edit-profile monolith:
 * username sanitization + debounced checkUsername, diff-against-original patch,
 * GPS + ManualCityPicker location flows, DOB validation, and the save-error
 * errorKind mapping (rate_limited → cooldown, conflict/invalid_payload+username
 * → taken, DOB errors → inline dobError).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Pressable, Alert, Linking, StyleSheet } from 'react-native';
import { Check, X } from 'lucide-react-native';
import {
  getMyProfile, updateMyProfile, checkUsername,
} from '../../../src/services/profile';
import { classifyIdentitySaveFailure } from '../../../src/services/profileSaveFlow';
import { getCurrentGps, reverseGeocodeToPlace } from '../../../src/services/location';
import { runIdentityGpsFill } from '../../../src/services/identityGpsFill';
import { ManualCityPicker } from '../../../src/components/ManualCityPicker';
import { DatePickerField } from '../../../src/components/DatePickerField';
import type { OwnProfile } from '../../../src/types/models';
import { markProfileStale } from '../../../src/hooks/usePassport';
import { PP } from '../../../src/theme/passportTokens';
import { space } from '../../../src/theme/tokens';
import {
  sanitizeUsername,
  usernameSyntaxError,
  interpretAvailability,
  USERNAME_MAX_LENGTH,
} from '../../../src/platform/input-assistance/social/usernameValidation';
import {
  SettingsScreen, SettingsSection, SaveButton, useUnsavedGuard, useSavedThenBack,
  FieldLabel, FieldHint, TextField, ChipGrid, type SaveState,
} from '../../../src/components/settings/SettingsUI';

const BIO_MAX = 300;

const SPOKEN_LANGUAGE_OPTIONS = [
  'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian',
  'Dutch', 'Swedish', 'Polish', 'Russian', 'Turkish', 'Arabic',
  'Hindi', 'Japanese', 'Korean', 'Mandarin', 'Thai', 'Vietnamese',
  'Indonesian', 'Filipino',
];

const SPOKEN_LANGUAGE_CHIP_OPTIONS = SPOKEN_LANGUAGE_OPTIONS.map((l) => ({ key: l, label: l }));

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'cooldown';

interface FormState {
  displayName: string;
  username: string;
  bio: string;
  dateOfBirth: string | null;
  homeCity: string;
  homeCountry: string;
  currentCity: string;
  spokenLanguages: string[];
}

export default function IdentityScreen() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<OwnProfile | null>(null);

  const [form, setForm] = useState<FormState>({
    displayName: '',
    username: '',
    bio: '',
    dateOfBirth: null,
    homeCity: '',
    homeCountry: '',
    currentCity: '',
    spokenLanguages: [],
  });
  const [originalForm, setOriginalForm] = useState<FormState | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dobError, setDobError] = useState<string | null>(null);

  const [showHomePicker, setShowHomePicker] = useState(false);
  const [showCurrentPicker, setShowCurrentPicker] = useState(false);
  const [gpsLoadingHome, setGpsLoadingHome] = useState(false);
  const [gpsLoadingCurrent, setGpsLoadingCurrent] = useState(false);

  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle');
  const [usernameMessage, setUsernameMessage] = useState<string | null>(null);
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveLockRef = useRef(false);
  const savedThenBack = useSavedThenBack(setSaveState);

  const isDirty = originalForm !== null && (
    form.displayName !== originalForm.displayName ||
    form.username !== originalForm.username ||
    form.bio !== originalForm.bio ||
    form.dateOfBirth !== originalForm.dateOfBirth ||
    form.homeCity !== originalForm.homeCity ||
    form.homeCountry !== originalForm.homeCountry ||
    form.currentCity !== originalForm.currentCity ||
    form.spokenLanguages.join(',') !== originalForm.spokenLanguages.join(',')
  );

  useUnsavedGuard(isDirty);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p = res.data;
        setProfile(p);
        const initial: FormState = {
          displayName: p.displayName ?? p.name ?? '',
          username: p.username ?? '',
          bio: p.bio ?? '',
          dateOfBirth: p.dateOfBirth ?? null,
          homeCity: p.homeCity ?? '',
          homeCountry: p.homeCountry ?? '',
          currentCity: p.currentCity ?? '',
          spokenLanguages: p.spokenLanguages ?? [],
        };
        setForm(initial);
        setOriginalForm(initial);
      }
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
    };
  }, []);

  const handleUsernameChange = useCallback((text: string) => {
    // Shared canonical rules (§23) — the SAME sanitize + min-length +
    // availability interpretation the onboarding username field now reuses, so
    // the two entry points can never diverge.
    const cleaned = sanitizeUsername(text);
    setForm((f) => ({ ...f, username: cleaned }));
    setUsernameStatus('idle');
    setUsernameMessage(null);

    if (usernameTimer.current) clearTimeout(usernameTimer.current);
    if (!cleaned || cleaned === (profile?.username ?? '')) return;

    const syntaxError = usernameSyntaxError(cleaned);
    if (syntaxError) {
      setUsernameStatus('invalid');
      setUsernameMessage(syntaxError);
      return;
    }

    setUsernameStatus('checking');
    usernameTimer.current = setTimeout(async () => {
      const res = await checkUsername(cleaned);
      const interpreted = interpretAvailability(res);
      setUsernameStatus(interpreted.status);
      setUsernameMessage(interpreted.message);
    }, 500);
  }, [profile?.username]);

  const fillHomeFromGps = useCallback(async () => {
    await runIdentityGpsFill({
      getCurrentGps,
      reverseGeocode: reverseGeocodeToPlace,
      onPermissionDenied: () =>
        Alert.alert(
          'Location permission is off',
          'Enable it in settings or choose a city/place from search.',
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
      onSuccess: (city, country) =>
        setForm((f) => ({
          ...f,
          homeCity: city ?? f.homeCity,
          homeCountry: country ?? f.homeCountry,
        })),
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
          'Enable it in settings or choose a city/place from search.',
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
      onSuccess: (city, _country) =>
        setForm((f) => ({
          ...f,
          currentCity: city ?? f.currentCity,
        })),
      setLoading: setGpsLoadingCurrent,
    });
  }, []);

  const canSave = usernameStatus !== 'taken' && usernameStatus !== 'invalid'
    && usernameStatus !== 'checking' && usernameStatus !== 'cooldown';

  const handleSave = useCallback(async () => {
    if (!canSave || saveLockRef.current) return;
    saveLockRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    setDobError(null);
    try {
      const patch: Parameters<typeof updateMyProfile>[0] = {};

      if (form.displayName !== (originalForm?.displayName ?? '')) {
        patch.displayName = form.displayName.trim();
      }
      if (form.username !== (originalForm?.username ?? '') && form.username) {
        patch.username = form.username;
      }
      if (form.bio !== (originalForm?.bio ?? '')) {
        patch.bio = form.bio;
      }
      if (form.homeCity !== (originalForm?.homeCity ?? '')) {
        patch.homeCity = form.homeCity.trim() || undefined;
      }
      if (form.homeCountry !== (originalForm?.homeCountry ?? '')) {
        patch.homeCountry = form.homeCountry.trim() || undefined;
      }
      if (form.currentCity !== (originalForm?.currentCity ?? '')) {
        patch.currentCity = form.currentCity.trim() || undefined;
      }
      if (form.spokenLanguages.join(',') !== (originalForm?.spokenLanguages ?? []).join(',')) {
        patch.spokenLanguages = form.spokenLanguages;
      }

      if (form.dateOfBirth !== (originalForm?.dateOfBirth ?? null)) {
        const dob = form.dateOfBirth;
        if (dob !== null) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            setSaveError('Date of birth must be in YYYY-MM-DD format');
            setSaveState('error');
            saveLockRef.current = false;
            return;
          }
          const d = new Date(dob);
          if (isNaN(d.getTime()) || d >= new Date()) {
            setSaveError('Date of birth must be a valid past date');
            setSaveState('error');
            saveLockRef.current = false;
            return;
          }
        }
        patch.dateOfBirth = dob;
      }

      if (Object.keys(patch).length === 0) {
        setSaveState('idle');
        saveLockRef.current = false;
        return;
      }

      const res = await updateMyProfile(patch);
      if (!res.ok) {
        const failure = classifyIdentitySaveFailure(res);
        if (failure.field === 'username') {
          setUsernameStatus(failure.status);
          setUsernameMessage(failure.message);
        } else if (failure.field === 'dob') {
          setDobError(failure.message);
        } else {
          setSaveError(failure.message);
        }
        setSaveState('error');
        saveLockRef.current = false;
        return;
      }

      setProfile(res.data);
      setOriginalForm(form);
      // QA round 2, bug 8: setProfile above is this screen's OWN useState — it
      // does not touch usePassport(). Tell the passport screen to bypass its
      // 5-minute focus TTL so the header shows the bio we just saved.
      markProfileStale();
      savedThenBack();
    } finally {
      saveLockRef.current = false;
    }
  }, [form, originalForm, canSave]);

  if (loading) {
    return (
      <SettingsScreen title="Identity">
        <View style={st.loadingWrap}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen
      title="Identity"
      right={<SaveButton state={saveState} onPress={handleSave} disabled={!canSave || !isDirty} />}
    >
      {saveError ? <FieldHint tone="error">{saveError}</FieldHint> : null}

      <SettingsSection title="Basics">
        <View style={st.field}>
          <FieldLabel right={<Text style={st.charCount}>{form.displayName.length}/30</Text>}>Display Name</FieldLabel>
          <TextField
            value={form.displayName}
            onChangeText={(text) => setForm((f) => ({ ...f, displayName: text.slice(0, 30) }))}
            placeholder="Your name"
            maxLength={30}
            autoCapitalize="words"
            returnKeyType="next"
          />
          <FieldHint>Maximum 30 characters.</FieldHint>
        </View>

        <View style={st.field}>
          <FieldLabel>Username</FieldLabel>
          <View style={st.usernameRow}>
            <Text style={st.atSign}>@</Text>
            <TextField
              style={st.usernameInput}
              value={form.username}
              onChangeText={handleUsernameChange}
              placeholder="username"
              maxLength={USERNAME_MAX_LENGTH}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
            {usernameStatus === 'checking' && <ActivityIndicator size="small" color={PP.inkMuted} />}
            {usernameStatus === 'available' && <Check size={16} color="#2E7D5B" />}
            {(usernameStatus === 'taken' || usernameStatus === 'invalid' || usernameStatus === 'cooldown') && (
              <X size={16} color={PP.seal} />
            )}
          </View>
          {usernameMessage ? (
            <FieldHint tone={usernameStatus === 'available' ? 'success' : 'error'}>{usernameMessage}</FieldHint>
          ) : null}
          <FieldHint>3-24 chars, letters/numbers/underscores/periods</FieldHint>
        </View>

        <View style={st.field}>
          <FieldLabel right={<Text style={st.charCount}>{form.bio.length}/{BIO_MAX}</Text>}>Bio</FieldLabel>
          <TextField
            style={st.bioInput}
            value={form.bio}
            onChangeText={(text) => setForm((f) => ({ ...f, bio: text.slice(0, BIO_MAX) }))}
            placeholder="Tell travelers about yourself…"
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            maxLength={BIO_MAX}
          />
        </View>

        <View style={st.field}>
          <FieldLabel>Date of Birth</FieldLabel>
          <DatePickerField
            value={form.dateOfBirth ?? ''}
            onChange={(dateStr) => {
              setDobError(null);
              setForm((f) => ({ ...f, dateOfBirth: dateStr || null }));
            }}
            placeholder="Select your date of birth"
          />
          {dobError ? <FieldHint tone="error">{dobError}</FieldHint> : null}
          <FieldHint>Used to enforce age limits on meetups and circles. Not shown publicly.</FieldHint>
        </View>
      </SettingsSection>

      <SettingsSection title="Location">
        <View style={st.field}>
          <FieldLabel>Home City</FieldLabel>
          <Pressable style={st.locationDisplay} onPress={() => setShowHomePicker(true)}>
            <Text style={form.homeCity ? st.locationText : st.locationPlaceholder}>
              {form.homeCity || 'Tap to select — or use GPS below'}
            </Text>
          </Pressable>
          <View style={st.locationActions}>
            <Pressable style={st.locationBtn} onPress={fillHomeFromGps} disabled={gpsLoadingHome}>
              {gpsLoadingHome
                ? <ActivityIndicator size="small" color={PP.ink} />
                : <Text style={st.locationBtnText}>⊕ Use my current location</Text>}
            </Pressable>
            <Pressable style={st.locationBtn} onPress={() => setShowHomePicker(true)}>
              <Text style={st.locationBtnText}>≡ Choose from list</Text>
            </Pressable>
          </View>
          <FieldHint>Your precise location is never shown publicly.</FieldHint>
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
            placeholder="Where are you right now?"
            maxLength={100}
            autoCapitalize="words"
            returnKeyType="next"
          />
          <View style={st.locationActions}>
            <Pressable style={st.locationBtn} onPress={fillCurrentFromGps} disabled={gpsLoadingCurrent}>
              {gpsLoadingCurrent
                ? <ActivityIndicator size="small" color={PP.ink} />
                : <Text style={st.locationBtnText}>⊕ Use my current location</Text>}
            </Pressable>
            <Pressable style={st.locationBtn} onPress={() => setShowCurrentPicker(true)}>
              <Text style={st.locationBtnText}>≡ Choose from list</Text>
            </Pressable>
          </View>
          <FieldHint>Shown on your profile when enabled in privacy settings.</FieldHint>
        </View>
      </SettingsSection>

      <SettingsSection title="Languages" subtitle="Languages I speak">
        <View style={st.field}>
          <ChipGrid
            options={SPOKEN_LANGUAGE_CHIP_OPTIONS}
            selected={form.spokenLanguages}
            onToggle={(key) => setForm((f) => ({
              ...f,
              spokenLanguages: f.spokenLanguages.includes(key)
                ? f.spokenLanguages.filter((l) => l !== key)
                : [...f.spokenLanguages, key],
            }))}
          />
        </View>
      </SettingsSection>

      <ManualCityPicker
        visible={showHomePicker}
        onClose={() => setShowHomePicker(false)}
        onSelect={(place) => {
          setForm((f) => ({ ...f, homeCity: place.city ?? place.name, homeCountry: place.country ?? f.homeCountry }));
          setShowHomePicker(false);
        }}
      />
      <ManualCityPicker
        visible={showCurrentPicker}
        onClose={() => setShowCurrentPicker(false)}
        onSelect={(place) => {
          setForm((f) => ({ ...f, currentCity: place.city ?? place.name }));
          setShowCurrentPicker(false);
        }}
      />
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  loadingWrap: { paddingVertical: space.xxxl, alignItems: 'center' },
  field: { padding: space.md, gap: space.xs },
  charCount: { fontSize: 11, color: PP.inkMuted, fontWeight: '600' },
  usernameRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
  },
  atSign: { fontSize: 16, color: PP.inkMuted, fontWeight: '600' },
  usernameInput: { flex: 1 },
  bioInput: { minHeight: 96, paddingTop: space.md },
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
