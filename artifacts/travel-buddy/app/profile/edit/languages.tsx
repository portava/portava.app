/**
 * Languages — view and edit spokenLanguages.
 * A focused screen for the Languages entry in the Travel Identity menu,
 * reusing the chip pattern from identity.tsx.
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

const SPOKEN_LANGUAGE_OPTIONS = [
  'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian',
  'Dutch', 'Swedish', 'Polish', 'Russian', 'Turkish', 'Arabic',
  'Hindi', 'Japanese', 'Korean', 'Mandarin', 'Thai', 'Vietnamese',
  'Indonesian', 'Filipino',
];

const LANGUAGE_CHIP_OPTIONS = SPOKEN_LANGUAGE_OPTIONS.map((l) => ({ key: l, label: l }));

interface FormState {
  spokenLanguages: string[];
}

export default function LanguagesScreen() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({ spokenLanguages: [] });
  const [originalForm, setOriginalForm] = useState<FormState | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveLockRef = useRef(false);
  const savedThenBack = useSavedThenBack(setSaveState);

  const isDirty = originalForm !== null &&
    form.spokenLanguages.join(',') !== originalForm.spokenLanguages.join(',');
  useUnsavedGuard(isDirty);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p: OwnProfile = res.data;
        const initial: FormState = { spokenLanguages: p.spokenLanguages ?? [] };
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
      const res = await updateMyProfile({ spokenLanguages: form.spokenLanguages });
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
      <SettingsScreen title="Languages">
        <View style={st.loadingWrap}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Languages">
      <SettingsSection title="Languages I Speak" subtitle="Select all that apply">
        <View style={st.field}>
          <ChipGrid
            options={LANGUAGE_CHIP_OPTIONS}
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

      <SaveBar state={saveState} onPress={handleSave} disabled={!isDirty} error={saveError} />
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  loadingWrap: { paddingVertical: space.xxxl, alignItems: 'center' },
  field: { padding: space.md },
});
