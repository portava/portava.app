import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { fetchTrustSettings, updateTrustSetting, type TrustSettingKey } from '../../src/services/trustAdmin';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';

interface SettingSection {
  title: string;
  keys: TrustSettingKey[];
  description?: string;
}

const SECTIONS: SettingSection[] = [
  {
    title: 'Category Weights',
    description: 'Contribution of each category to the overall score (should sum to 1.0)',
    keys: [
      'weight_plan_attendance', 'weight_host_quality', 'weight_communication',
      'weight_respect_safety', 'weight_location_honesty', 'weight_content_quality',
      'weight_community_value', 'weight_guide_accuracy', 'weight_passport_auth',
    ],
  },
  {
    title: 'Decay & Score Levels',
    description: 'Controls how fast old events lose weight and what scores map to each public level',
    keys: [
      'decay_half_life_days',
      'level_building_trust', 'level_reliable', 'level_trusted',
      'level_highly_trusted', 'level_city_trusted',
    ],
  },
  {
    title: 'Daily & Weekly Caps',
    description: 'Max events counted per day/week per action type',
    keys: [
      'daily_cap_plan_attend', 'daily_cap_guide_verify', 'daily_cap_gem_save',
      'weekly_cap_plan_attend', 'weekly_cap_guide_verify', 'weekly_cap_gem_save',
    ],
  },
  {
    title: 'Gaming Detection',
    description: 'Thresholds for flagging suspicious behaviour patterns',
    keys: [
      'gaming_checkin_cluster_limit',
      'gaming_mutual_rate_threshold',
      'gaming_rapid_jump_points',
    ],
  },
];

const KEY_LABELS: Record<TrustSettingKey, string> = {
  weight_plan_attendance:    'Plan Attendance',
  weight_host_quality:       'Host Quality',
  weight_communication:      'Communication',
  weight_respect_safety:     'Respect & Safety',
  weight_location_honesty:   'Location Honesty',
  weight_content_quality:    'Content Quality',
  weight_community_value:    'Community Value',
  weight_guide_accuracy:     'Guide Accuracy',
  weight_passport_auth:      'Passport Auth',
  decay_half_life_days:      'Half-Life (days)',
  level_building_trust:      'Building Trust ≥',
  level_reliable:            'Reliable ≥',
  level_trusted:             'Trusted ≥',
  level_highly_trusted:      'Highly Trusted ≥',
  level_city_trusted:        'City Trusted ≥',
  daily_cap_plan_attend:     'Daily: Plan Attend',
  daily_cap_guide_verify:    'Daily: Guide Verify',
  daily_cap_gem_save:        'Daily: Gem Save',
  weekly_cap_plan_attend:    'Weekly: Plan Attend',
  weekly_cap_guide_verify:   'Weekly: Guide Verify',
  weekly_cap_gem_save:       'Weekly: Gem Save',
  gaming_checkin_cluster_limit:  'Cluster Limit',
  gaming_mutual_rate_threshold:  'Mutual Rate Threshold',
  gaming_rapid_jump_points:      'Rapid Jump Points',
};

function SettingRow({
  settingKey,
  value,
  saving,
  onSave,
}: {
  settingKey: TrustSettingKey;
  value: number;
  saving: boolean;
  onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const label = KEY_LABELS[settingKey];
  const dirty = draft !== String(value);

  return (
    <View style={styles.settingRow}>
      <View style={styles.settingLeft}>
        <Text style={styles.settingKey}>{label}</Text>
        <Text style={styles.settingRawKey}>{settingKey}</Text>
      </View>
      <View style={styles.settingRight}>
        <TextInput
          style={[styles.input, dirty && styles.inputDirty]}
          value={draft}
          onChangeText={setDraft}
          keyboardType="decimal-pad"
          selectTextOnFocus
        />
        {dirty && (
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={() => {
              const n = parseFloat(draft);
              if (isNaN(n)) { Alert.alert('Error', 'Please enter a valid number'); return; }
              onSave(n);
            }}
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>{saving ? '…' : 'Save'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

export default function TrustSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();
  const [settings, setSettings]   = useState<Record<string, number>>({});
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [saving, setSaving]       = useState<TrustSettingKey | null>(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (!isAuthed) { router.replace('/(auth)/sign-in' as any); return; }
    setLoading(true);
    fetchTrustSettings()
      .then((d) => setSettings(d.settings))
      .catch((e) => setError(e?.message ?? 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, [isAuthed, sessionLoading]);

  const onSave = async (key: TrustSettingKey, value: number) => {
    setSaving(key);
    try {
      const result = await updateTrustSetting(key, value);
      setSettings((prev) => ({ ...prev, ...result.settings }));
      Alert.alert('Saved', `${KEY_LABELS[key]} updated to ${value}`);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not save setting');
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered} testID="trust-settings-error" accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={{ paddingTop: insets.top }}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color="#111827" />
          </Pressable>
          <Text style={styles.title}>Trust Settings</Text>
          <Text style={styles.subtitle}>Engine-wide configuration. Changes take effect on the next score recalculation.</Text>
        </View>

        {SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            {section.description && (
              <Text style={styles.sectionDesc}>{section.description}</Text>
            )}
            {section.keys.map((k) => (
              <SettingRow
                key={k}
                settingKey={k}
                value={settings[k] ?? 0}
                saving={saving === k}
                onSave={(v) => onSave(k, v)}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </KeyboardSafeScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  header:    { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 4 },
  backBtn:   { padding: 4, marginBottom: 6 },
  title:     { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle:  { fontSize: 13, color: '#6B7280', marginTop: 4, lineHeight: 18 },

  section:      { marginTop: 20, backgroundColor: '#fff', borderRadius: 12, marginHorizontal: 16, overflow: 'hidden' },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#374151', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 2 },
  sectionDesc:  { fontSize: 12, color: '#9CA3AF', paddingHorizontal: 16, paddingBottom: 8 },

  settingRow:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  settingLeft: { flex: 1 },
  settingKey:  { fontSize: 14, color: '#111827', fontWeight: '500' },
  settingRawKey: { fontSize: 10, color: '#D1D5DB', marginTop: 1 },

  settingRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  input:      { width: 80, borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, fontSize: 14, textAlign: 'right', color: '#111827', backgroundColor: '#F9FAFB' },
  inputDirty: { borderColor: '#F59E0B', backgroundColor: '#FFFBEB' },

  saveBtn:         { backgroundColor: '#3B82F6', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  saveBtnDisabled: { backgroundColor: '#93C5FD' },
  saveBtnText:     { color: '#fff', fontSize: 12, fontWeight: '700' },

  centered:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: '#EF4444', textAlign: 'center' },
});
