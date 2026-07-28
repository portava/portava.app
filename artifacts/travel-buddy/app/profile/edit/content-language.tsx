/**
 * Content Language — lets users choose which language they prefer to see
 * content in. When set, the feed translation pipeline shows "See translation"
 * toggles on posts whose detected language differs from this preference.
 *
 * Uses the existing LanguagePreferenceContext (preferred_language on the
 * profile row) — the same field that message translation also reads.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, Pressable, FlatList, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { Check, Globe } from 'lucide-react-native';
import {
  SettingsScreen, SettingsSection, SettingsDivider,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space, type as t } from '../../../src/theme/tokens';
import { useLanguagePreference } from '../../../src/context/LanguagePreferenceContext';

/** All ISO 639-1 codes from SUPPORTED_LANGUAGE_CODES in api-server/src/routes/profile.ts */
const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
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
  { code: 'zh-TW', label: 'Chinese (Traditional)' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'tl', label: 'Filipino' },
];

function languageLabel(code: string | null): string {
  if (!code) return 'Not set';
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;
}

type RowItem = { code: string | null; label: string };

const LIST_DATA: RowItem[] = [
  { code: null, label: 'Use device language' },
  ...LANGUAGE_OPTIONS,
];

export default function ContentLanguageScreen() {
  const { preferredLanguage, loading, updateLanguage } = useLanguagePreference();
  const [busy, setBusy] = useState(false);

  const handleSelect = useCallback(async (code: string | null) => {
    if (code === (preferredLanguage ?? null)) return;
    setBusy(true);
    const res = await updateLanguage(code);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('Error', res.message ?? 'Could not update language preference. Try again.');
    }
  }, [preferredLanguage, updateLanguage]);

  const currentLabel = loading ? 'Loading…' : languageLabel(preferredLanguage ?? null);

  return (
    <SettingsScreen
      title="Content Language"
      subtitle="Choose the language for feed translations"
    >
      <SettingsSection
        title="Display language"
        subtitle={
          'When content is detected in a different language than your preference, ' +
          'a "See translation" toggle will appear. Affects posts, gems, events, and other feed content.'
        }
      >
        <View style={styles.currentRow}>
          <Globe size={16} color={PP.inkMuted} />
          <Text style={styles.currentLabel}>
            Current:{' '}
            <Text style={styles.currentValue}>{currentLabel}</Text>
          </Text>
          {(loading || busy) && <ActivityIndicator size="small" color={PP.inkMuted} />}
        </View>
      </SettingsSection>

      <SettingsSection title="Select language">
        <FlatList
          data={LIST_DATA}
          keyExtractor={(item) => item.code ?? '__none__'}
          scrollEnabled={false}
          renderItem={({ item, index }) => {
            const selected = (preferredLanguage ?? null) === item.code;
            return (
              <View>
                {index > 0 && <SettingsDivider />}
                <Pressable
                  style={({ pressed }) => [styles.langRow, pressed && { opacity: 0.7 }]}
                  onPress={() => handleSelect(item.code)}
                  disabled={busy || loading}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={item.label}
                  testID={`lang-option-${item.code ?? 'none'}`}
                >
                  <Text style={[styles.langLabel, selected && styles.langLabelSelected]}>
                    {item.label}
                  </Text>
                  {selected ? (
                    <Check size={18} color={PP.inkLight} />
                  ) : null}
                </Pressable>
              </View>
            );
          }}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  currentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 48,
  },
  currentLabel: { ...t.small, color: PP.inkMuted, flex: 1 },
  currentValue: { ...t.small, color: PP.ink, fontWeight: '700' },

  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 52,
  },
  langLabel: { ...t.body, color: PP.ink },
  langLabelSelected: { fontWeight: '700', color: PP.inkLight },
});
