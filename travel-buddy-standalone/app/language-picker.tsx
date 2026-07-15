import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { color, space, type as t, radius } from '../src/theme/tokens';
import { useLanguagePreference } from '../src/context/LanguagePreferenceContext';

export const SUPPORTED_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en',    name: 'English' },
  { code: 'es',    name: 'Spanish' },
  { code: 'fr',    name: 'French' },
  { code: 'de',    name: 'German' },
  { code: 'ja',    name: 'Japanese' },
  { code: 'ko',    name: 'Korean' },
  { code: 'zh',    name: 'Chinese (Simplified)' },
  { code: 'pt',    name: 'Portuguese' },
  { code: 'it',    name: 'Italian' },
  { code: 'ru',    name: 'Russian' },
  { code: 'ar',    name: 'Arabic' },
  { code: 'th',    name: 'Thai' },
  { code: 'vi',    name: 'Vietnamese' },
  { code: 'id',    name: 'Indonesian' },
  { code: 'tl',    name: 'Filipino' },
  { code: 'sv',    name: 'Swedish' },
  { code: 'nl',    name: 'Dutch' },
  { code: 'pl',    name: 'Polish' },
  { code: 'tr',    name: 'Turkish' },
  { code: 'hi',    name: 'Hindi' },
];

export default function LanguagePicker() {
  const params = useLocalSearchParams<{ current?: string; via?: string }>();
  const { preferredLanguage: ctxLanguage, updateLanguage } = useLanguagePreference();
  const [selected, setSelected] = useState<string | null>(params.current || ctxLanguage || null);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const filtered = query.trim()
    ? SUPPORTED_LANGUAGES.filter(
        (l) =>
          l.name.toLowerCase().includes(query.toLowerCase()) ||
          l.code.toLowerCase().includes(query.toLowerCase()),
      )
    : SUPPORTED_LANGUAGES;

  const handleSelect = useCallback(
    async (code: string) => {
      const next = selected === code ? null : code;
      setSelected(next);
      setSaving(true);
      const result = await updateLanguage(next);
      setSaving(false);
      if (!result.ok) {
        Alert.alert('Error', result.message ?? 'Failed to save language preference. Please try again.');
        setSelected(selected);
        return;
      }
      router.back();
    },
    [selected, updateLanguage],
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader
        title="Translation Language"
        back
        right={saving ? <ActivityIndicator size="small" color={color.signal} /> : undefined}
      />

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search languages…"
          placeholderTextColor={color.faint}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <Text style={styles.hint}>
        Incoming messages will be translated into your chosen language. Tap to select, tap again to clear.
      </Text>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.code}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 40 }}
        renderItem={({ item }) => {
          const active = selected === item.code;
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              onPress={() => handleSelect(item.code)}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.langName, active && styles.langNameActive]}>{item.name}</Text>
                <Text style={styles.langCode}>{item.code}</Text>
              </View>
              {active && <Check size={18} color={color.deep} strokeWidth={2.5} />}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No languages match "{query}"</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  search: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...t.body,
    color: color.ink,
    fontSize: 14,
  },
  hint: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  langName: { ...t.body, color: color.ink, fontSize: 15 },
  langNameActive: { color: color.deep, fontWeight: '700' },
  langCode: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { ...t.body, color: color.mute },
});
