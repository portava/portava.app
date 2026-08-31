/**
 * Privacy & Visibility — Edit Profile & Settings hub sub-page.
 *
 * Absorbs app/settings/privacy.tsx (immediate-save toggles/radios via
 * applyPrivacyChange + updatePrivacySettings, optimistic w/ rollback) and the
 * "passport" visibility-preferences block from PassportSettingsSheet.tsx
 * (batched SaveBar: Public Passport via updateMyProfile + PATCH
 * /api/me/passport/visibility-preferences).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import {
  getPrivacySettings,
  updatePrivacySettings,
  getMyProfile,
  updateMyProfile,
  type PrivacySettings,
} from '../../../src/services/profile';
import { applyPrivacyChange } from '../../../src/services/privacySettingsLogic';
import { useSession } from '../../../src/context/SessionContext';
import { _clearSnapshot } from '../../../src/hooks/snapshotCacheUtils';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t, icon } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider, ToggleRow,
  SaveBar, ChipGrid, useUnsavedGuard, type SaveState,
} from '../../../src/components/settings/SettingsUI';
import { ContributorViewOptInToggle } from '../../../src/features/media/components/ContributorViewOptInToggle';

const VIS_OPTIONS = [
  { key: 'public', label: 'Public' },
  { key: 'circle_only', label: 'Circle only' },
  { key: 'trip_crew', label: 'Trip crew' },
  { key: 'private', label: 'Private' },
];

export default function PrivacyVisibilityScreen() {
  const { isAuthed, configured, userId } = useSession();
  const live = configured && isAuthed;

  // ── Immediate-save privacy settings (from settings/privacy.tsx) ──
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const saveLock = useRef(false);

  const loadSettings = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getPrivacySettings()
      .then((res) => {
        if (res.ok && res.data) {
          setPrivacy(res.data);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!live) { setLoading(false); return; }
    loadSettings();
  }, [live, loadSettings]);

  const handleChange = useCallback(
    <K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]) => {
      if (saveLock.current) return;
      saveLock.current = true;
      void applyPrivacyChange(privacy, key, value, {
        setPrivacy,
        setSaving,
        onError: (msg) => Alert.alert('Error', msg),
      }, updatePrivacySettings).finally(() => {
        saveLock.current = false;
      });
    },
    [privacy],
  );

  // ── Batched passport visibility-preferences block ──
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const [passportPublic, setPassportPublic] = useState(true);
  const [defaultStampVis, setDefaultStampVis] = useState<string>('public');
  const [defaultMemoryVis, setDefaultMemoryVis] = useState<string>('private');
  const [showCityMap, setShowCityMap] = useState(true);
  const [showPlanStamps, setShowPlanStamps] = useState(true);
  const [passportLoading, setPassportLoading] = useState(true);
  const [passportDirty, setPassportDirty] = useState(false);
  const [passportSave, setPassportSave] = useState<SaveState>('idle');
  const [passportError, setPassportError] = useState<string | null>(null);
  // baseline snapshot for dirty comparison
  const baseline = useRef({
    passportPublic: true, defaultStampVis: 'public', defaultMemoryVis: 'private',
    showCityMap: true, showPlanStamps: true,
  });

  const loadPassport = useCallback(async () => {
    setPassportLoading(true);
    try {
      const profRes = await getMyProfile();
      let pPublic = true;
      if (profRes.ok && profRes.data) {
        pPublic = profRes.data.passportVisibility !== 'private';
      }
      let stampVis = 'public', memoryVis = 'private', cityMap = true, planStamps = true;
      // Verbatim fetch code from PassportSettingsSheet.tsx
      const { supabase } = await import('../../../src/lib/supabase');
      const { data: refreshed } = await supabase.auth.refreshSession();
      const token = refreshed?.session?.access_token
        ?? (await supabase.auth.getSession()).data.session?.access_token;
      if (token) {
        const res = await fetch(`${apiBase}/api/me/passport/visibility-preferences`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          stampVis = json.defaultStampVisibility ?? 'public';
          memoryVis = json.defaultMemoryVisibility ?? 'private';
          cityMap = json.showCityMap ?? true;
          planStamps = json.showPlanStamps ?? true;
        }
      }
      setPassportPublic(pPublic);
      setDefaultStampVis(stampVis);
      setDefaultMemoryVis(memoryVis);
      setShowCityMap(cityMap);
      setShowPlanStamps(planStamps);
      baseline.current = { passportPublic: pPublic, defaultStampVis: stampVis, defaultMemoryVis: memoryVis, showCityMap: cityMap, showPlanStamps: planStamps };
      setPassportDirty(false);
    } catch {
      // silent — leave defaults
    } finally {
      setPassportLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    if (!live) { setPassportLoading(false); return; }
    loadPassport();
  }, [live, loadPassport]);

  // recompute dirty whenever a passport field changes
  const markPassport = useCallback((next: Partial<typeof baseline.current>) => {
    const b = baseline.current;
    const merged = {
      passportPublic, defaultStampVis, defaultMemoryVis, showCityMap, showPlanStamps,
      ...next,
    };
    const dirty =
      merged.passportPublic !== b.passportPublic ||
      merged.defaultStampVis !== b.defaultStampVis ||
      merged.defaultMemoryVis !== b.defaultMemoryVis ||
      merged.showCityMap !== b.showCityMap ||
      merged.showPlanStamps !== b.showPlanStamps;
    setPassportDirty(dirty);
    if (passportSave !== 'idle') setPassportSave('idle');
  }, [passportPublic, defaultStampVis, defaultMemoryVis, showCityMap, showPlanStamps, passportSave]);

  const savePassport = useCallback(async () => {
    setPassportSave('saving');
    setPassportError(null);
    try {
      // Public Passport → passportVisibility via updateMyProfile
      const profRes = await updateMyProfile({
        passportVisibility: passportPublic ? 'public' : 'private',
      });
      if (!profRes.ok) {
        setPassportSave('error');
        setPassportError(profRes.message ?? 'Save failed');
        return;
      }
      // Visibility prefs → PATCH (verbatim from PassportSettingsSheet.tsx)
      const { supabase } = await import('../../../src/lib/supabase');
      const { data: refreshed } = await supabase.auth.refreshSession();
      const token = refreshed?.session?.access_token
        ?? (await supabase.auth.getSession()).data.session?.access_token;
      if (token) {
        await fetch(`${apiBase}/api/me/passport/visibility-preferences`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            defaultStampVisibility: defaultStampVis,
            defaultMemoryVisibility: defaultMemoryVis,
            showCityMap,
            showPlanStamps,
          }),
        });
      }
      baseline.current = { passportPublic, defaultStampVis, defaultMemoryVis, showCityMap, showPlanStamps };
      setPassportDirty(false);
      setPassportSave('saved');
      setTimeout(() => setPassportSave('idle'), 1500);
      // Invalidate the stale-while-revalidate passport snapshot so the next
      // open re-fetches from the server with the updated privacy settings.
      if (userId) _clearSnapshot(AsyncStorage, 'passport-v2', userId);
    } catch (e) {
      setPassportSave('error');
      setPassportError(e instanceof Error ? e.message : 'Save failed');
    }
  }, [apiBase, passportPublic, defaultStampVis, defaultMemoryVis, showCityMap, showPlanStamps]);

  useUnsavedGuard(passportDirty);

  if (loading || passportLoading) {
    return (
      <SettingsScreen title="Privacy & Visibility">
        <View style={st.center}>
          <ActivityIndicator color={PP.inkLight} />
        </View>
      </SettingsScreen>
    );
  }

  if (!live) {
    return (
      <SettingsScreen title="Privacy & Visibility">
        <SettingsSection>
          <SettingsRow title="Sign in to manage privacy settings." chevron={false} />
        </SettingsSection>
      </SettingsScreen>
    );
  }

  if (!privacy) {
    return (
      <SettingsScreen title="Privacy & Visibility">
        <SettingsSection subtitle={loadError ? 'Failed to load settings.' : undefined}>
          <SettingsRow
            title="Try again"
            onPress={loadSettings}
            chevron={false}
          />
        </SettingsSection>
      </SettingsScreen>
    );
  }

  const profileVisOptions = [
    { value: 'public' as const, label: 'Public', sub: 'Anyone can view your profile' },
    { value: 'followers_only' as const, label: 'Followers only', sub: 'Only followers can view' },
    { value: 'private' as const, label: 'Private', sub: 'Only you can view' },
  ];

  const messageOptions = [
    { value: 'everyone' as const, label: 'Everyone' },
    { value: 'friends' as const, label: 'Friends only' },
    { value: 'followers' as const, label: 'Followers only' },
    { value: 'nobody' as const, label: 'Nobody' },
  ];

  const visibilityToggles: Array<{ key: keyof PrivacySettings; label: string; sub: string }> = [
    { key: 'show_profile_picture_publicly', label: 'Show profile photo to everyone', sub: 'When off, only followers and friends can see your profile photo' },
    { key: 'show_real_name', label: 'Show my real name', sub: 'Show your name to other travelers instead of just your @handle' },
    { key: 'show_stamps', label: 'Show stamps', sub: 'Others can see your collected stamps' },
    { key: 'show_current_city', label: 'Show current city', sub: 'Display your current city on your profile' },
    { key: 'show_upcoming_trips', label: 'Show upcoming trips', sub: 'Others can see your travel plans' },
    { key: 'show_friends', label: 'Show friends list', sub: 'Others can see who you are friends with' },
  ];

  const interactionToggles: Array<{ key: keyof PrivacySettings; label: string; sub: string }> = [
    { key: 'allow_friend_requests', label: 'Allow friend requests', sub: 'People can send you friend requests' },
    { key: 'allow_follow', label: 'Allow follows', sub: 'People can follow you' },
    { key: 'allow_tagging', label: 'Allow tagging', sub: 'Others can @mention you in posts' },
    { key: 'allow_profile_discovery', label: 'Discoverable', sub: 'Appear in search and suggestions' },
  ];

  return (
    <SettingsScreen
      title="Privacy & Visibility"
      right={saving ? <ActivityIndicator size="small" color={PP.inkLight} /> : undefined}
    >
      {/* Profile visibility */}
      <SettingsSection
        title="Who can see your profile"
        subtitle="Controls who can open and view your full profile."
      >
        {profileVisOptions.map((opt, idx) => {
          const checked = privacy.profile_visibility === opt.value;
          return (
            <React.Fragment key={opt.value}>
              {idx > 0 && <SettingsDivider />}
              <SettingsRow
                title={opt.label}
                subtitle={opt.sub}
                onPress={() => handleChange('profile_visibility', opt.value)}
                accessibilityRole="radio"
                accessibilityLabel={`${opt.label}: ${opt.sub}`}
                accessibilityState={{ checked }}
                right={
                  <View style={[st.radio, checked && st.radioChecked]} />
                }
              />
            </React.Fragment>
          );
        })}
      </SettingsSection>

      {/* Visibility toggles */}
      <SettingsSection
        title="Visibility"
        subtitle="Choose which parts of your profile other travelers can see."
      >
        {visibilityToggles.map((toggle, idx) => (
          <React.Fragment key={String(toggle.key)}>
            {idx > 0 && <SettingsDivider />}
            <ToggleRow
              title={toggle.label}
              subtitle={toggle.sub}
              value={privacy[toggle.key] as boolean}
              onValueChange={(v) => handleChange(toggle.key, v as any)}
            />
          </React.Fragment>
        ))}
      </SettingsSection>

      {/* Interaction permissions */}
      <SettingsSection
        title="Interactions"
        subtitle="Decide how other people can connect with you."
      >
        {interactionToggles.map((toggle, idx) => (
          <React.Fragment key={String(toggle.key)}>
            {idx > 0 && <SettingsDivider />}
            <ToggleRow
              title={toggle.label}
              subtitle={toggle.sub}
              value={privacy[toggle.key] as boolean}
              onValueChange={(v) => handleChange(toggle.key, v as any)}
            />
          </React.Fragment>
        ))}
      </SettingsSection>

      {/* Who can message you */}
      <SettingsSection
        title="Who can message you"
        subtitle="Limit who's able to start a Telegraph conversation with you."
      >
        {messageOptions.map((opt, idx) => {
          const checked = privacy.allow_messages_from === opt.value;
          return (
            <React.Fragment key={opt.value}>
              {idx > 0 && <SettingsDivider />}
              <SettingsRow
                title={opt.label}
                onPress={() => handleChange('allow_messages_from', opt.value)}
                accessibilityRole="radio"
                accessibilityLabel={opt.label}
                accessibilityState={{ checked }}
                right={
                  <View style={[st.radio, checked && st.radioChecked]} />
                }
              />
            </React.Fragment>
          );
        })}
      </SettingsSection>

      {/* Lists */}
      <SettingsSection
        title="Lists"
        subtitle="Curate a smaller circle for content you only want a few people to see."
      >
        <SettingsRow
          title="Close Friends"
          onPress={() => router.push('/close-friends' as any)}
        />
      </SettingsSection>

      {/* Passport visibility preferences (batched) */}
      <SettingsSection
        title="Passport"
        subtitle="Control how your Passport, stamps, and memories appear to others. Saved together with the button below."
      >
        <ToggleRow
          title="Public Passport"
          subtitle="Anyone with your profile link can view your Passport"
          value={passportPublic}
          onValueChange={(v) => { setPassportPublic(v); markPassport({ passportPublic: v }); }}
        />
        {!passportPublic && (
          <>
            <SettingsDivider />
            <View style={st.infoBox}>
              <Text style={st.infoText}>🔒 Your Passport is private. Only you can see it.</Text>
            </View>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Default stamp visibility"
        subtitle="Stamps you earn default to this visibility (city stamps are always public)."
      >
        <View style={st.chipWrap}>
          <ChipGrid
            options={VIS_OPTIONS}
            selected={[defaultStampVis]}
            onToggle={(key) => { setDefaultStampVis(key); markPassport({ defaultStampVis: key }); }}
            mode="radio"
          />
        </View>
      </SettingsSection>

      <SettingsSection
        title="Default memory visibility"
        subtitle="Memories you add manually default to this visibility."
      >
        <View style={st.chipWrap}>
          <ChipGrid
            options={VIS_OPTIONS}
            selected={[defaultMemoryVis]}
            onToggle={(key) => { setDefaultMemoryVis(key); markPassport({ defaultMemoryVis: key }); }}
            mode="radio"
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Passport display">
        <ToggleRow
          title="Show City Map"
          subtitle="Display a world map of cities you've visited"
          value={showCityMap}
          onValueChange={(v) => { setShowCityMap(v); markPassport({ showCityMap: v }); }}
        />
        <SettingsDivider />
        <ToggleRow
          title="Show Plan Stamps"
          subtitle="Show stamps earned from trip check-ins on your Passport"
          value={showPlanStamps}
          onValueChange={(v) => { setShowPlanStamps(v); markPassport({ showPlanStamps: v }); }}
        />
      </SettingsSection>

      <SaveBar
        state={passportSave}
        error={passportError}
        disabled={!passportDirty}
        onPress={savePassport}
        label="Save passport settings"
      />

      <Text style={st.footerNote}>
        Your exact GPS coordinates are never shared publicly. All public surfaces show only city, neighborhood, or approximate distance.
      </Text>

      {/* Media v2 Phase 10 (§19): opt in/out of being asked to contribute a live
          view. ADDITIVE + flag-gated (media_request_a_view_enabled) — renders
          nothing until the capability is enabled. Off by default, revocable. */}
      <ContributorViewOptInToggle />
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  center: { paddingVertical: space.xxl, alignItems: 'center', justifyContent: 'center' },
  radio: {
    width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2,
    borderWidth: 2, borderColor: PP.border,
  },
  radioChecked: { borderColor: PP.inkLight, backgroundColor: PP.inkLight },
  chipWrap: { padding: space.lg },
  infoBox: {
    backgroundColor: PP.paperDeep,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  infoText: { ...t.small, color: PP.inkMuted },
  footerNote: {
    ...t.small,
    color: PP.inkMuted,
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
    marginTop: space.md,
  },
});
