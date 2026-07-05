/**
 * Compass Settings Screen
 *
 * Data-use toggles for the Compass AI engine. Controls which signals
 * Compass is allowed to use when personalising recommendations.
 *
 * Accessible from: ForYouTab → Compass Picks header gear icon.
 *                  Settings → Compass Preferences → Compass Settings
 *
 * Each toggle optimistically updates and rolls back on error.
 */
import React, { useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Switch,
  ActivityIndicator, Alert, SafeAreaView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, MapPin, Compass, BriefcaseBusiness, Bookmark, Clock,
  Users, Bell, RotateCcw, Building2,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { useCompassSettings } from '../src/hooks/compass/useCompassSettings';
import { postCompassAnalyticsEvent, type CompassSettings } from '../src/services/compass';

// ── Setting row definition ────────────────────────────────────────────────────

interface SettingDef {
  key:         keyof CompassSettings;
  label:       string;
  description: string;
  Icon:        React.ComponentType<{ size: number; color: string }>;
}

const SETTINGS: SettingDef[] = [
  {
    key:         'use_location',
    label:       'Use current location',
    description: 'Compass uses your GPS to surface nearby picks.',
    Icon:        MapPin,
  },
  {
    key:         'use_chosen_city',
    label:       'Use chosen city',
    description: 'Compass ranks picks based on the city you have selected.',
    Icon:        Building2,
  },
  {
    key:         'use_trip_data',
    label:       'Use trip data',
    description: 'Your upcoming and past trips inform which picks are relevant.',
    Icon:        Compass,
  },
  {
    key:         'use_saved_items',
    label:       'Use saved items',
    description: 'Saved places and events help Compass understand your taste.',
    Icon:        Bookmark,
  },
  {
    key:         'use_history',
    label:       'Use event & trip history',
    description: 'Places and events you have visited are excluded from picks.',
    Icon:        Clock,
  },
  {
    key:         'show_buddy_recommendations',
    label:       'Show buddy recommendations',
    description: 'Compass may suggest travel buddies that match your profile.',
    Icon:        Users,
  },
  {
    key:         'show_people_recommendations',
    label:       'Show people recommendations',
    description: 'Compass may suggest travellers to follow.',
    Icon:        Users,
  },
  {
    key:         'allow_smart_notifications',
    label:       'Smart notifications',
    description: 'Compass can send a nudge when a time-sensitive pick appears.',
    Icon:        Bell,
  },
];

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CompassSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { settings, loading, saving, updateSetting, resetPersonalisation } =
    useCompassSettings();

  const handleToggle = useCallback(
    async (key: keyof CompassSettings, value: boolean) => {
      await updateSetting(key, value);
      postCompassAnalyticsEvent({
        event_name: 'compass_settings_changed',
        metadata:   { setting: key, value },
      });
    },
    [updateSetting],
  );

  async function handleReset() {
    Alert.alert(
      'Reset personalisation',
      'This clears your Compass feedback history and resets category weights. Preferences like location and trip data settings are kept. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            const r = await resetPersonalisation();
            if (r.ok) {
              Alert.alert('Done', 'Compass personalisation has been reset.');
            } else {
              Alert.alert('Error', 'Could not reset. Try again later.');
            }
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={[s.safe, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          style={s.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Back"
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Compass Settings</Text>
        {saving && <ActivityIndicator size="small" color={color.signal} style={s.spinner} />}
      </View>

      <ScrollView
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.sectionLabel}>Data use</Text>
        <Text style={s.sectionDesc}>
          Choose which signals Compass can use to personalise your recommendations.
          All signals are processed on our servers — nothing is sold to third parties.
        </Text>

        <View style={s.card}>
          {loading ? (
            <View style={s.loadingRow}>
              <ActivityIndicator size="small" color={color.signal} />
              <Text style={s.loadingText}>Loading settings…</Text>
            </View>
          ) : (
            SETTINGS.map(({ key, label, description, Icon }, i) => (
              <View
                key={key}
                style={[s.row, i < SETTINGS.length - 1 && s.rowBorder]}
              >
                <View style={s.rowIcon}>
                  <Icon size={16} color={color.signal} />
                </View>
                <View style={s.rowText}>
                  <Text style={s.rowLabel}>{label}</Text>
                  <Text style={s.rowDesc}>{description}</Text>
                </View>
                <Switch
                  value={(settings?.[key] as boolean | undefined) ?? true}
                  onValueChange={(v) => handleToggle(key, v)}
                  trackColor={{ false: color.haze, true: color.signal + 'AA' }}
                  thumbColor={color.paper}
                  disabled={saving}
                />
              </View>
            ))
          )}
        </View>

        <Text style={s.sectionLabel}>Personalisation data</Text>

        <View style={s.card}>
          <Pressable style={s.resetRow} onPress={handleReset}>
            <View style={s.rowIcon}>
              <RotateCcw size={16} color={color.warn} />
            </View>
            <View style={s.rowText}>
              <Text style={[s.rowLabel, { color: color.warn }]}>Reset personalisation</Text>
              <Text style={s.rowDesc}>
                Clears your Compass feedback history and category weights.
                Does not affect location or data-use settings above.
              </Text>
            </View>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    ...t.bodyStrong,
    color: color.ink,
    flex: 1,
    fontSize: 16,
  },
  spinner: {
    marginLeft: space.sm,
  },
  content: {
    paddingTop: space.xl,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  sectionLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: space.xs,
    marginTop: space.lg,
  },
  sectionDesc: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: space.sm,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.lg,
  },
  loadingText: {
    ...t.body,
    color: color.mute,
    fontSize: 13,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 14,
    paddingHorizontal: space.md,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  rowIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: color.signal + '10',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
  },
  rowDesc: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 14,
  },
  resetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
  },
});
