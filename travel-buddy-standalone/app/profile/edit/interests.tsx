/**
 * Interests — view and edit travel interests.
 * A focused screen for the Interests entry in the Travel Identity menu,
 * exposing the full available interest set (matching about.tsx + passport labels).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { getMyProfile, updateMyProfile } from '../../../src/services/profile';
import { resolveProfileSaveOutcome } from '../../../src/services/profileSaveFlow';
import type { OwnProfile } from '../../../src/types/models';
import { PP } from '../../../src/theme/passportTokens';
import { space } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SaveBar, useUnsavedGuard, useSavedThenBack,
  ChipGrid, type SaveState,
} from '../../../src/components/settings/SettingsUI';

/**
 * Full interest set — superset of both about.tsx's SOCIAL_INTEREST_OPTIONS and
 * PassportAboutSection's INTEREST_LABEL map, so nothing is hidden here.
 */
const INTEREST_OPTIONS = [
  { key: 'food',          label: 'Food' },
  { key: 'photography',   label: 'Photography' },
  { key: 'nightlife',     label: 'Nightlife' },
  { key: 'wellness',      label: 'Wellness' },
  { key: 'shopping',      label: 'Shopping' },
  { key: 'nature',        label: 'Nature' },
  { key: 'history',       label: 'History' },
  { key: 'architecture',  label: 'Architecture' },
  { key: 'music',         label: 'Music' },
  { key: 'art',           label: 'Art' },
  { key: 'sport',         label: 'Sport' },
  { key: 'reading',       label: 'Reading' },
  { key: 'beach',         label: 'Beach' },
  { key: 'luxury',        label: 'Luxury' },
  { key: 'culture',       label: 'Culture' },
  { key: 'adventure',     label: 'Adventure' },
  { key: 'backpacking',   label: 'Backpacking' },
  { key: 'business',      label: 'Business' },
  { key: 'dating',        label: 'Social' },
  { key: 'events',        label: 'Events' },
];

interface FormState {
  interests: string[];
}

export default function InterestsScreen() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({ interests: [] });
  const [originalForm, setOriginalForm] = useState<FormState | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveLockRef = useRef(false);
  const savedThenBack = useSavedThenBack(setSaveState);

  const isDirty = originalForm !== null &&
    form.interests.join(',') !== originalForm.interests.join(',');
  useUnsavedGuard(isDirty);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p: OwnProfile = res.data;
        const initial: FormState = { interests: p.interests ?? [] };
        setForm(initial);
        setOriginalForm(initial);
      }
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const handleSave = async () => {
    if (saveLockRef.current || !isDirty) return;
    saveLockRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    try {
      const res = await updateMyProfile({ interests: form.interests });
      const outcome = resolveProfileSaveOutcome(res);
      if (outcome.kind === 'error') {
        setSaveError(outcome.message);
        setSaveState('error');
        saveLockRef.current = false;
        return;
      }
      setOriginalForm(form);
      savedThenBack();
    } finally {
      saveLockRef.current = false;
    }
  };

  if (loading) {
    return (
      <SettingsScreen title="Interests">
        <View style={st.loadingWrap}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Interests">
      <SettingsSection title="Travel Interests" subtitle="What you love to do while traveling">
        <View style={st.field}>
          <ChipGrid
            options={INTEREST_OPTIONS}
            selected={form.interests}
            onToggle={(key) => setForm((f) => ({
              ...f,
              interests: f.interests.includes(key)
                ? f.interests.filter((i) => i !== key)
                : [...f.interests, key],
            }))}
          />
        </View>
      </SettingsSection>

      <SaveBar state={saveState} onPress={handleSave} disabled={!isDirty} error={saveError} />
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  loadingWrap: { paddingVertical: space.xxxl, alignItems: 'center' },
  field: { padding: space.md },
});
