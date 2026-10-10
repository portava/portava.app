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
import { PROFILE_INTEREST_OPTIONS } from '../../../src/lib/profile/interestOptions.ts';
import { SmartInput } from '../../../src/platform/input-assistance/components/SmartInput.tsx';
import { SOCIAL_FIELD_IDS, registerSocialFields } from '../../../src/platform/input-assistance/social/socialFields.ts';
import { interestKeyForLabel } from '../../../src/platform/input-assistance/data/interests.ts';
import type { InputSuggestion } from '../../../src/platform/input-assistance/types/inputSuggestion.ts';

// The "find an interest" field (lead ruling PR-D2-10): an `interest` field whose
// list is the profile's own keys, answered from the shipped list with no request
// (PR-D2-5) and by the server otherwise.
registerSocialFields();

/** The profile's interest vocabulary (moved, unchanged, to src/lib/profile/interestOptions.ts). */
const INTEREST_OPTIONS = PROFILE_INTEREST_OPTIONS.map((o) => ({ key: o.key, label: o.label }));

/** The profile accepts at most 20 interests (routes/profile.ts). */
const MAX_INTERESTS = 20;

/** Add a picked interest KEY once, within the profile's cap; only a key the profile offers. */
export function withInterest(current: string[], key: string | null): string[] {
  if (!key || !PROFILE_INTEREST_OPTIONS.some((o) => o.key === key)) return current;
  if (current.includes(key) || current.length >= MAX_INTERESTS) return current;
  return [...current, key];
}

interface FormState {
  interests: string[];
}

export default function InterestsScreen() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({ interests: [] });
  const [interestQuery, setInterestQuery] = useState('');
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
          <SmartInput
            fieldId={SOCIAL_FIELD_IDS.profileInterests}
            context="interest"
            value={interestQuery}
            onChangeText={setInterestQuery}
            onSelectSuggestion={(s: InputSuggestion) => {
              const key = interestKeyForLabel(s.label);
              setForm((f) => ({ ...f, interests: withInterest(f.interests, key) }));
              setInterestQuery('');
              return false; // handled: the pick selects its chip
            }}
            label="Find an interest"
            placeholder="Find an interest…"
            testID="interest-find-input"
          />
        </View>
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
