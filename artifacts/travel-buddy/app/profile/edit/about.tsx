/**
 * About Me — Interests + Travel Style chips.
 * Option lists (SOCIAL_INTEREST_OPTIONS, TRAVEL_STYLE_OPTIONS) and the
 * diff-against-original updateMyProfile patch are copied verbatim from the
 * legacy edit-profile monolith.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { getMyProfile, updateMyProfile } from '../../../src/services/profile';
import type { OwnProfile } from '../../../src/types/models';
import { PP } from '../../../src/theme/passportTokens';
import { space } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SaveBar, useUnsavedGuard, useSavedThenBack,
  ChipGrid, type SaveState,
} from '../../../src/components/settings/SettingsUI';

const TRAVEL_STYLE_OPTIONS = [
  'Adventure', 'Culture', 'Luxury', 'Backpacking', 'Slow travel',
  'Road trips', 'City breaks', 'Beach & sun', 'Photography',
  'Food & drink', 'Wildlife', 'Hiking',
];

const SOCIAL_INTEREST_OPTIONS = [
  'Food', 'Photography', 'Nightlife', 'Wellness', 'Shopping',
  'Nature', 'History', 'Architecture', 'Music', 'Art', 'Sport', 'Reading',
];

const INTEREST_CHIP_OPTIONS = SOCIAL_INTEREST_OPTIONS.map((i) => ({ key: i, label: i }));
const TRAVEL_STYLE_CHIP_OPTIONS = TRAVEL_STYLE_OPTIONS.map((s) => ({ key: s, label: s }));

interface FormState {
  interests: string[];
  travelStyles: string[];
}

export default function AboutScreen() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({ interests: [], travelStyles: [] });
  const [originalForm, setOriginalForm] = useState<FormState | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveLockRef = useRef(false);
  const savedThenBack = useSavedThenBack(setSaveState);

  const isDirty = originalForm !== null && (
    form.interests.join(',') !== originalForm.interests.join(',') ||
    form.travelStyles.join(',') !== originalForm.travelStyles.join(',')
  );
  useUnsavedGuard(isDirty);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p: OwnProfile = res.data;
        const initial: FormState = {
          interests: p.interests ?? [],
          travelStyles: p.travelStyles ?? [],
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

  const handleSave = async () => {
    if (saveLockRef.current || !isDirty) return;
    saveLockRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    try {
      const patch: Parameters<typeof updateMyProfile>[0] = {};
      if (form.travelStyles.join(',') !== (originalForm?.travelStyles ?? []).join(',')) {
        patch.travelStyles = form.travelStyles;
      }
      if (form.interests.join(',') !== (originalForm?.interests ?? []).join(',')) {
        patch.interests = form.interests;
      }

      if (Object.keys(patch).length === 0) {
        setSaveState('idle');
        saveLockRef.current = false;
        return;
      }

      const res = await updateMyProfile(patch);
      if (!res.ok) {
        setSaveError(res.message ?? 'Failed to save profile');
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
      <SettingsScreen title="About Me">
        <View style={st.loadingWrap}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="About Me">
      <SettingsSection title="Interests" subtitle="What you love to do while traveling">
        <View style={st.field}>
          <ChipGrid
            options={INTEREST_CHIP_OPTIONS}
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

      <SettingsSection title="Travel Style" subtitle="How you like to travel">
        <View style={st.field}>
          <ChipGrid
            options={TRAVEL_STYLE_CHIP_OPTIONS}
            selected={form.travelStyles}
            onToggle={(key) => setForm((f) => ({
              ...f,
              travelStyles: f.travelStyles.includes(key)
                ? f.travelStyles.filter((s) => s !== key)
                : [...f.travelStyles, key],
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
