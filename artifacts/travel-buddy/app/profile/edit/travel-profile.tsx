/**
 * Travel Profile — meetup/travel style preferences (from the legacy monolith
 * edit screen) plus AI Trip Preferences (absorbed from app/settings/index.tsx,
 * saved via patchPreferences) and Availability tags.
 *
 * One page-level SaveBar. updateMyProfile and patchPreferences are each only
 * called when their own fields changed.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import {
  SettingsScreen, SettingsSection, FieldLabel, ChipGrid, ToggleRow, SaveBar,
  useUnsavedGuard, useSavedThenBack, type SaveState,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space } from '../../../src/theme/tokens';
import { getMyProfile, updateMyProfile } from '../../../src/services/profile';
import { fetchPreferences, patchPreferences } from '../../../src/services/intelligence';
import type { OwnProfile } from '../../../src/types/models';

// ── Option lists — copied verbatim from the legacy monolith ─────────────────

const TRAVEL_PACE_OPTIONS: { key: string; label: string }[] = [
  { key: 'slow', label: 'Slow & relaxed' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'packed', label: 'Action-packed' },
];

const BUDGET_STYLE_OPTIONS: { key: string; label: string }[] = [
  { key: 'budget', label: 'Budget' },
  { key: 'mid-range', label: 'Mid-range' },
  { key: 'luxury', label: 'Luxury' },
  { key: 'flexible', label: 'Flexible' },
];

const COMFORT_LEVEL_OPTIONS: { key: string; label: string }[] = [
  { key: 'chill', label: 'Chill' },
  { key: 'social', label: 'Social' },
  { key: 'adventurous', label: 'Adventurous' },
  { key: 'anything_goes', label: 'Anything goes' },
];

const PLANNING_STYLE_OPTIONS: { key: string; label: string }[] = [
  { key: 'planner', label: 'Planner' },
  { key: 'flexible', label: 'Flexible' },
  { key: 'spontaneous', label: 'Spontaneous' },
];

const LOOKING_FOR_OPTIONS = [
  'friends', 'activities', 'nightlife', 'food', 'culture',
  'sightseeing', 'hidden_gems', 'local_help',
];

const LOOKING_FOR_LABELS: Record<string, string> = {
  friends: 'Friends',
  activities: 'Activities',
  nightlife: 'Nightlife',
  food: 'Food & drink',
  culture: 'Culture',
  sightseeing: 'Sightseeing',
  hidden_gems: 'Hidden gems',
  local_help: 'Local help',
};

const TRAVEL_GROUP_OPTIONS: { key: string; label: string }[] = [
  { key: 'solo', label: 'Solo' },
  { key: 'couple', label: 'Couple' },
  { key: 'small_group', label: 'Small group' },
  { key: 'big_group', label: 'Big group' },
  { key: 'open_to_any', label: 'Open to any' },
];

// Availability tags — from PassportSettingsSheet (availabilityTags field).
const AVAILABILITY_OPTIONS = [
  { key: 'Morning', label: 'Morning' },
  { key: 'Afternoon', label: 'Afternoon' },
  { key: 'Evening', label: 'Evening' },
  { key: 'Late night', label: 'Late night' },
];

// AI Trip Preferences — copied verbatim from app/settings/index.tsx.
const INTERESTS_OPTIONS = ['beach', 'food', 'nightlife', 'adventure', 'culture', 'wellness', 'photography', 'shopping', 'luxury', 'backpacking'];
const FOOD_OPTIONS = ['street food', 'seafood', 'vegetarian', 'vegan', 'local cuisine', 'fine dining', 'coffee'];
const NIGHTLIFE_OPTIONS = ['bars', 'clubs', 'live music', 'rooftop', 'night markets'];
const AI_PACE_OPTIONS: Array<{ value: 'relaxed' | 'balanced' | 'packed'; label: string }> = [
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'packed', label: 'Packed' },
];
const AI_GROUP_OPTIONS: Array<{ value: 'solo' | 'small' | 'group' | 'mixed'; label: string }> = [
  { value: 'solo', label: 'Solo' },
  { value: 'small', label: 'Small group (2–4)' },
  { value: 'group', label: 'Large group (5+)' },
  { value: 'mixed', label: 'Mixed / flexible' },
];
const TIME_OPTIONS = ['morning', 'afternoon', 'evening', 'late_night'];
const TIME_LABELS: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late_night: 'Late night' };

// ── Profile (updateMyProfile) form ──────────────────────────────────────────

interface ProfileForm {
  travelPace: string | null;
  budgetStyle: string | null;
  comfortLevel: string | null;
  planningStyle: string | null;
  lookingFor: string[];
  openToMeet: boolean;
  travelGroupStyle: string[];
  availabilityTags: string[];
}

// ── AI preferences (patchPreferences) form ──────────────────────────────────

interface AIForm {
  pace: 'relaxed' | 'balanced' | 'packed';
  groupStyle: 'solo' | 'small' | 'group' | 'mixed';
  interests: string[];
  foodPreferences: string[];
  nightlifePreferences: string[];
  preferredActivityTimes: string[];
}

export default function TravelProfileScreen() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [originalForm, setOriginalForm] = useState<ProfileForm | null>(null);
  const [ai, setAi] = useState<AIForm | null>(null);
  const [originalAi, setOriginalAi] = useState<AIForm | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const savedThenBack = useSavedThenBack(setSaveState);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getMyProfile(), fetchPreferences()]).then(([pRes, prefRes]) => {
      if (!alive) return;
      if (pRes.ok && pRes.data) {
        const p = pRes.data as OwnProfile;
        const initial: ProfileForm = {
          travelPace: p.travelPace ?? null,
          budgetStyle: p.budgetStyle ?? null,
          comfortLevel: p.comfortLevel ?? null,
          planningStyle: p.planningStyle ?? null,
          lookingFor: p.lookingFor ?? [],
          openToMeet: p.openToMeet ?? false,
          travelGroupStyle: p.travelGroupStyle ?? [],
          availabilityTags: p.availabilityTags ?? [],
        };
        setForm(initial);
        setOriginalForm(initial);
      }
      // AI prefs load — mirrors settings/index loadPrefs()
      const e = prefRes.ok && prefRes.data?.explicit ? prefRes.data.explicit : null;
      const initialAi: AIForm = {
        pace: e?.pace ?? 'balanced',
        groupStyle: e?.groupStyle ?? 'mixed',
        interests: e?.interests ?? [],
        foodPreferences: e?.foodPreferences ?? [],
        nightlifePreferences: e?.nightlifePreferences ?? [],
        preferredActivityTimes: e?.preferredActivityTimes ?? [],
      };
      setAi(initialAi);
      setOriginalAi(initialAi);
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const profileDirty = !!form && !!originalForm && (
    form.travelPace !== originalForm.travelPace ||
    form.budgetStyle !== originalForm.budgetStyle ||
    form.comfortLevel !== originalForm.comfortLevel ||
    form.planningStyle !== originalForm.planningStyle ||
    form.lookingFor.join(',') !== originalForm.lookingFor.join(',') ||
    form.openToMeet !== originalForm.openToMeet ||
    form.travelGroupStyle.join(',') !== originalForm.travelGroupStyle.join(',') ||
    form.availabilityTags.join(',') !== originalForm.availabilityTags.join(',')
  );

  const aiDirty = !!ai && !!originalAi && (
    ai.pace !== originalAi.pace ||
    ai.groupStyle !== originalAi.groupStyle ||
    ai.interests.join(',') !== originalAi.interests.join(',') ||
    ai.foodPreferences.join(',') !== originalAi.foodPreferences.join(',') ||
    ai.nightlifePreferences.join(',') !== originalAi.nightlifePreferences.join(',') ||
    ai.preferredActivityTimes.join(',') !== originalAi.preferredActivityTimes.join(',')
  );

  const dirty = profileDirty || aiDirty;
  useUnsavedGuard(dirty);

  const toggleMulti = (key: keyof ProfileForm) => (v: string) => {
    setForm((f) => {
      if (!f) return f;
      const arr = f[key] as string[];
      const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
      return { ...f, [key]: next };
    });
  };

  const toggleSingle = (key: keyof ProfileForm) => (v: string) => {
    setForm((f) => (f ? { ...f, [key]: f[key] === v ? null : v } : f));
  };

  const toggleAiMulti = (key: keyof AIForm) => (v: string) => {
    setAi((a) => {
      if (!a) return a;
      const arr = a[key] as string[];
      const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
      return { ...a, [key]: next };
    });
  };

  const handleSave = useCallback(async () => {
    if (!form || !ai) return;
    setSaveState('saving');
    setSaveError(null);

    try {
      const tasks: Promise<{ ok: boolean; message?: string }>[] = [];

      if (profileDirty && originalForm) {
        const patch: Parameters<typeof updateMyProfile>[0] = {};
        if (form.travelPace !== originalForm.travelPace) {
          patch.travelPace = form.travelPace as 'slow' | 'balanced' | 'packed' | null;
        }
        if (form.budgetStyle !== originalForm.budgetStyle) {
          patch.budgetStyle = form.budgetStyle as 'budget' | 'mid-range' | 'luxury' | 'flexible' | null;
        }
        if (form.comfortLevel !== originalForm.comfortLevel) {
          patch.comfortLevel = form.comfortLevel ?? undefined;
        }
        if (form.planningStyle !== originalForm.planningStyle) {
          patch.planningStyle = form.planningStyle ?? undefined;
        }
        if (form.lookingFor.join(',') !== originalForm.lookingFor.join(',')) {
          patch.lookingFor = form.lookingFor;
        }
        if (form.openToMeet !== originalForm.openToMeet) {
          patch.openToMeet = form.openToMeet;
        }
        if (form.travelGroupStyle.join(',') !== originalForm.travelGroupStyle.join(',')) {
          patch.travelGroupStyle = form.travelGroupStyle;
        }
        if (form.availabilityTags.join(',') !== originalForm.availabilityTags.join(',')) {
          patch.availabilityTags = form.availabilityTags;
        }
        tasks.push(updateMyProfile(patch).then((r) => ({ ok: r.ok, message: r.message })));
      }

      if (aiDirty && originalAi) {
        const patch: Record<string, any> = {};
        if (ai.pace !== originalAi.pace) patch.pace = ai.pace;
        if (ai.groupStyle !== originalAi.groupStyle) patch.groupStyle = ai.groupStyle;
        if (ai.interests.join(',') !== originalAi.interests.join(',')) patch.interests = ai.interests;
        if (ai.foodPreferences.join(',') !== originalAi.foodPreferences.join(',')) patch.foodPreferences = ai.foodPreferences;
        if (ai.nightlifePreferences.join(',') !== originalAi.nightlifePreferences.join(',')) patch.nightlifePreferences = ai.nightlifePreferences;
        if (ai.preferredActivityTimes.join(',') !== originalAi.preferredActivityTimes.join(',')) patch.preferredActivityTimes = ai.preferredActivityTimes;
        tasks.push(patchPreferences(patch).then((r) => ({ ok: r.ok })));
      }

      const results = await Promise.all(tasks);
      const failed = results.find((r) => !r.ok);
      if (failed) {
        setSaveState('error');
        setSaveError(failed.message ?? 'Failed to save. Try again.');
        return;
      }

      setOriginalForm(form);
      setOriginalAi(ai);
      savedThenBack();
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : 'Failed to save. Try again.');
    }
  }, [form, ai, profileDirty, aiDirty, originalForm, originalAi]);

  if (loading || !form || !ai) {
    return (
      <SettingsScreen title="Travel Profile">
        <View style={styles.loading}><ActivityIndicator color={PP.ink} size="large" /></View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Travel Profile" subtitle="Pace, budget, meetups & AI">
      <SettingsSection title="Travel Style">
        <View style={styles.group}>
          <FieldLabel>Travel Pace</FieldLabel>
          <ChipGrid
            options={TRAVEL_PACE_OPTIONS}
            selected={form.travelPace ? [form.travelPace] : []}
            onToggle={toggleSingle('travelPace')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Budget Style</FieldLabel>
          <ChipGrid
            options={BUDGET_STYLE_OPTIONS}
            selected={form.budgetStyle ? [form.budgetStyle] : []}
            onToggle={toggleSingle('budgetStyle')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Vibe (Comfort Level)</FieldLabel>
          <ChipGrid
            options={COMFORT_LEVEL_OPTIONS}
            selected={form.comfortLevel ? [form.comfortLevel] : []}
            onToggle={toggleSingle('comfortLevel')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Planning Style</FieldLabel>
          <ChipGrid
            options={PLANNING_STYLE_OPTIONS}
            selected={form.planningStyle ? [form.planningStyle] : []}
            onToggle={toggleSingle('planningStyle')}
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Meeting People">
        <View style={styles.group}>
          <FieldLabel>Looking For</FieldLabel>
          <ChipGrid
            options={LOOKING_FOR_OPTIONS.map((k) => ({ key: k, label: LOOKING_FOR_LABELS[k] ?? k }))}
            selected={form.lookingFor}
            onToggle={toggleMulti('lookingFor')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>I travel as</FieldLabel>
          <ChipGrid
            options={TRAVEL_GROUP_OPTIONS}
            selected={form.travelGroupStyle}
            onToggle={toggleMulti('travelGroupStyle')}
          />
        </View>
        <View style={styles.toggleWrap}>
          <ToggleRow
            title="Open to meet"
            subtitle="Show that you're open to meeting other travelers"
            value={form.openToMeet}
            onValueChange={(v) => setForm((f) => (f ? { ...f, openToMeet: v } : f))}
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Availability" subtitle="When you're typically free to meet up.">
        <View style={styles.group}>
          <ChipGrid
            options={AVAILABILITY_OPTIONS}
            selected={form.availabilityTags}
            onToggle={toggleMulti('availabilityTags')}
          />
        </View>
      </SettingsSection>

      <SettingsSection
        title="AI Trip Preferences"
        subtitle="Travel Buddy uses these to tailor its trip suggestions."
      >
        <View style={styles.group}>
          <FieldLabel>Interests</FieldLabel>
          <ChipGrid
            options={INTERESTS_OPTIONS.map((k) => ({ key: k, label: k }))}
            selected={ai.interests}
            onToggle={toggleAiMulti('interests')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Food preferences</FieldLabel>
          <ChipGrid
            options={FOOD_OPTIONS.map((k) => ({ key: k, label: k }))}
            selected={ai.foodPreferences}
            onToggle={toggleAiMulti('foodPreferences')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Nightlife preferences</FieldLabel>
          <ChipGrid
            options={NIGHTLIFE_OPTIONS.map((k) => ({ key: k, label: k }))}
            selected={ai.nightlifePreferences}
            onToggle={toggleAiMulti('nightlifePreferences')}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Travel pace</FieldLabel>
          <ChipGrid
            options={AI_PACE_OPTIONS.map((o) => ({ key: o.value, label: o.label }))}
            selected={[ai.pace]}
            onToggle={(v) => setAi((a) => (a ? { ...a, pace: v as AIForm['pace'] } : a))}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Who do you travel with?</FieldLabel>
          <ChipGrid
            options={AI_GROUP_OPTIONS.map((o) => ({ key: o.value, label: o.label }))}
            selected={[ai.groupStyle]}
            onToggle={(v) => setAi((a) => (a ? { ...a, groupStyle: v as AIForm['groupStyle'] } : a))}
          />
        </View>
        <View style={styles.group}>
          <FieldLabel>Preferred activity times</FieldLabel>
          <ChipGrid
            options={TIME_OPTIONS.map((k) => ({ key: k, label: TIME_LABELS[k] }))}
            selected={ai.preferredActivityTimes}
            onToggle={toggleAiMulti('preferredActivityTimes')}
          />
        </View>
      </SettingsSection>

      <SaveBar
        state={saveState}
        onPress={handleSave}
        disabled={!dirty}
        error={saveError}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: space.xxxl, alignItems: 'center' },
  group: { padding: space.lg, gap: space.sm },
  toggleWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PP.borderLight },
});
