/**
 * Connected Features — Telegraph smart-suggestion toggles, Rent a Buddy,
 * admin rows, Tag Permissions, and Preferred Translation Language.
 *
 * Toggles + radio + language save IMMEDIATELY on change with inline feedback
 * (no page-level form). This differs from the legacy monolith, which batched
 * tagPermission + language on a Save button — see report note. Telegraph and
 * account/AI wiring is preserved verbatim from app/settings/index.tsx.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, FlatList, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { Check, X } from 'lucide-react-native';
import { supabase } from '../../../src/lib/supabase';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider, ToggleRow,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import { updateTelegraphChatSettings } from '../../../src/services/telegraphChat';
import {
  getTagPermission, updateTagPermission,
  type TagPermission, TAG_PERMISSION_OPTIONS,
} from '../../../src/services/tagging';
import { useLanguagePreference } from '../../../src/context/LanguagePreferenceContext';
import { useRentABuddyFlag } from '../../../src/hooks/useRentABuddyFlag';

// Language options + label — copied verbatim from the legacy monolith.
const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'tl', label: 'Filipino' },
];

function languageLabel(code: string | null): string {
  if (!code) return 'Same as message settings';
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;
}

export default function ConnectedFeaturesScreen() {
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const { preferredLanguage, updateLanguage } = useLanguagePreference();

  const [isAdmin, setIsAdmin] = useState(false);

  // Telegraph toggles — initialize to true, matching settings/index (no getter).
  const [telegraphDM, setTelegraphDM] = useState(true);
  const [telegraphTrip, setTelegraphTrip] = useState(true);
  const [telegraphCircle, setTelegraphCircle] = useState(true);
  const [telegraphBusy, setTelegraphBusy] = useState<string | null>(null);

  // Tag permission
  const [tagPermission, setTagPermission] = useState<TagPermission>('anyone');
  const [tagLoading, setTagLoading] = useState(true);
  const [tagBusy, setTagBusy] = useState(false);

  // Language picker modal
  const [langPickerVisible, setLangPickerVisible] = useState(false);
  const [langBusy, setLangBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const userId = data.session?.user?.id;
      if (!userId) return;
      supabase.from('profiles').select('role').eq('id', userId).maybeSingle().then(({ data: p }) => {
        if ((p as any)?.role === 'admin') setIsAdmin(true);
      });
    });
  }, []);

  useEffect(() => {
    let alive = true;
    getTagPermission().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) setTagPermission(res.data.tagPermission);
      setTagLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // Telegraph toggle — save immediately, revert on failure (preserves legacy wiring).
  const handleTelegraphToggle = useCallback(async (
    key: 'show_telegraph_dm' | 'show_telegraph_trip' | 'show_telegraph_circle',
    value: boolean,
  ) => {
    const setters: Record<typeof key, React.Dispatch<React.SetStateAction<boolean>>> = {
      show_telegraph_dm: setTelegraphDM,
      show_telegraph_trip: setTelegraphTrip,
      show_telegraph_circle: setTelegraphCircle,
    };
    const setter = setters[key];
    setter(value);
    setTelegraphBusy(key);
    const ok = await updateTelegraphChatSettings({ [key]: value }).catch(() => false);
    setTelegraphBusy(null);
    if (!ok) {
      setter(!value);
      Alert.alert('Error', 'Could not update Telegraph setting. Try again.');
    }
  }, []);

  const handleTagPermission = useCallback(async (next: TagPermission) => {
    if (next === tagPermission) return;
    const prev = tagPermission;
    setTagPermission(next);
    setTagBusy(true);
    const res = await updateTagPermission(next);
    setTagBusy(false);
    if (!res.ok) {
      setTagPermission(prev);
      Alert.alert('Error', res.error ?? 'Could not update tag permission. Try again.');
    }
  }, [tagPermission]);

  const handleSelectLanguage = useCallback(async (code: string | null) => {
    setLangPickerVisible(false);
    if (code === (preferredLanguage ?? null)) return;
    setLangBusy(true);
    const res = await updateLanguage(code);
    setLangBusy(false);
    if (!res.ok) {
      Alert.alert('Error', res.message ?? 'Could not update translation language. Try again.');
    }
  }, [preferredLanguage, updateLanguage]);

  return (
    <SettingsScreen title="Connected Features" subtitle="Telegraph, tags & translation">
      {/* Telegraph smart-suggestion toggles */}
      <SettingsSection
        title="Telegraph"
        subtitle="Smart suggestions appear above the composer when Telegraph detects travel planning in your chats."
      >
        <ToggleRow
          title="Direct messages"
          subtitle="Show suggestions in 1-on-1 chats"
          value={telegraphDM}
          disabled={telegraphBusy === 'show_telegraph_dm'}
          onValueChange={(v) => handleTelegraphToggle('show_telegraph_dm', v)}
        />
        <SettingsDivider />
        <ToggleRow
          title="Trip chats"
          subtitle="Show suggestions in trip group chats"
          value={telegraphTrip}
          disabled={telegraphBusy === 'show_telegraph_trip'}
          onValueChange={(v) => handleTelegraphToggle('show_telegraph_trip', v)}
        />
        <SettingsDivider />
        <ToggleRow
          title="Circle chats"
          subtitle="Show suggestions in circle group chats"
          value={telegraphCircle}
          disabled={telegraphBusy === 'show_telegraph_circle'}
          onValueChange={(v) => handleTelegraphToggle('show_telegraph_circle', v)}
        />
      </SettingsSection>

      {/* Rent a Buddy — only when flag enabled */}
      {rentBuddyEnabled && (
        <SettingsSection title="Rent a Buddy">
          <SettingsRow
            title="Rent a Buddy"
            subtitle="Manage your buddy profile and readiness"
            onPress={() => router.push('/(rent-a-buddy)/become' as any)}
          />
        </SettingsSection>
      )}

      {/* Admin — gated exactly as settings/index does */}
      {isAdmin && (
        <SettingsSection title="Admin">
          <SettingsRow
            title="Feature Flags"
            onPress={() => router.push('/admin/feature-flags' as any)}
          />
          {rentBuddyEnabled && (
            <>
              <SettingsDivider />
              <SettingsRow
                title="Rent a Buddy Admin"
                onPress={() => router.push('/(rent-a-buddy)/admin' as any)}
              />
            </>
          )}
        </SettingsSection>
      )}

      {/* Tag Permissions */}
      <SettingsSection
        title="Tag Permissions"
        subtitle="Choose who can @mention you in posts and messages."
      >
        {tagLoading ? (
          <View style={styles.loadRow}><ActivityIndicator color={PP.ink} /></View>
        ) : (
          TAG_PERMISSION_OPTIONS.map((opt, i) => (
            <View key={opt.key}>
              {i > 0 && <SettingsDivider />}
              <Pressable
                style={({ pressed }) => [styles.radioRow, pressed && { opacity: 0.7 }]}
                onPress={() => handleTagPermission(opt.key)}
                disabled={tagBusy}
                accessibilityRole="radio"
                accessibilityState={{ selected: tagPermission === opt.key }}
              >
                <View style={[styles.radio, tagPermission === opt.key && styles.radioOn]}>
                  {tagPermission === opt.key && <View style={styles.radioDot} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioLabel}>{opt.label}</Text>
                  <Text style={styles.radioDesc}>{opt.desc}</Text>
                </View>
                {tagBusy && tagPermission === opt.key ? (
                  <ActivityIndicator size="small" color={PP.inkMuted} />
                ) : null}
              </Pressable>
            </View>
          ))
        )}
      </SettingsSection>

      {/* Preferred Translation Language */}
      <SettingsSection
        title="Translation Language"
        subtitle="Incoming messages will be translated into your chosen language."
      >
        <SettingsRow
          title="Preferred language"
          subtitle={languageLabel(preferredLanguage ?? null)}
          onPress={() => setLangPickerVisible(true)}
          right={langBusy ? <ActivityIndicator size="small" color={PP.inkMuted} /> : undefined}
        />
      </SettingsSection>

      <Modal
        visible={langPickerVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLangPickerVisible(false)}
      >
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Translation language</Text>
            <Pressable onPress={() => setLangPickerVisible(false)} hitSlop={8}>
              <X size={22} color={PP.ink} />
            </Pressable>
          </View>
          <FlatList
            data={[{ code: null as string | null, label: 'Same as message settings' }, ...LANGUAGE_OPTIONS]}
            keyExtractor={(item) => item.code ?? 'default'}
            renderItem={({ item }) => {
              const selected = (preferredLanguage ?? null) === item.code;
              return (
                <Pressable
                  style={({ pressed }) => [styles.langRow, pressed && { opacity: 0.7 }]}
                  onPress={() => handleSelectLanguage(item.code)}
                >
                  <Text style={styles.langLabel}>{item.label}</Text>
                  {selected && <Check size={18} color={PP.inkLight} />}
                </Pressable>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.langSep} />}
          />
        </View>
      </Modal>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  loadRow: { padding: space.lg, alignItems: 'center' },
  radioRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 52,
  },
  radio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: PP.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: PP.inkLight },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: PP.inkLight },
  radioLabel: { ...t.body, color: PP.ink, fontWeight: '600' },
  radioDesc: { ...t.small, color: PP.inkMuted, fontSize: 12, marginTop: 1, lineHeight: 16 },

  modalRoot: { flex: 1, backgroundColor: PP.paper },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: space.lg, borderBottomWidth: 1, borderBottomColor: PP.borderLight,
  },
  modalTitle: { ...t.heading, color: PP.ink },
  langRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 48,
  },
  langLabel: { ...t.body, color: PP.ink },
  langSep: { height: StyleSheet.hairlineWidth, backgroundColor: PP.borderLight, marginLeft: space.lg },
});
