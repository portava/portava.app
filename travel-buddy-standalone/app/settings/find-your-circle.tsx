/**
 * Find Your Circle — global settings screen.
 *
 * Accessible from Settings > Find Your Circle.
 * Controls global on/off toggle, default visibility mode, pause all sharing,
 * and entry point to "Who can see me?".
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, Switch, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, Users, PauseCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getCircleSettings,
  patchCircleSettings,
  type CircleSettings,
  type VisibilityMode,
} from '../../src/services/circle';
import { FindYourCircleConsentSheet } from '../../src/components/FindYourCircleConsentSheet';
import { useSession } from '../../src/context/SessionContext';

const VISIBILITY_OPTIONS: Array<{ value: VisibilityMode; label: string; sub: string }> = [
  {
    value: 'status_only',
    label: 'Status only',
    sub: 'Co-travelers see your status (e.g. Active, Arrived) — no location',
  },
  {
    value: 'approximate_area',
    label: 'Approximate area',
    sub: 'Co-travelers see a neighbourhood or district label you set',
  },
  {
    value: 'venue_checkin',
    label: 'Venue check-in',
    sub: 'Co-travelers see your venue name when you actively check in',
  },
];

export default function FindYourCircleSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const live = configured && isAuthed;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [settings, setSettings] = useState<CircleSettings | null>(null);
  const [consentSheetVisible, setConsentSheetVisible] = useState(false);
  const [pendingEnable, setPendingEnable] = useState(false);

  const load = useCallback(async () => {
    if (!live) { setLoading(false); return; }
    setLoading(true);
    setLoadError(false);
    const res = await getCircleSettings();
    setLoading(false);
    if (res.ok) {
      setSettings(res.data);
    } else {
      setLoadError(true);
    }
  }, [live]);

  useEffect(() => { load(); }, [load]);

  async function handleGlobalToggle(value: boolean) {
    if (!settings) return;
    if (value) {
      if (!settings.consentedAt) {
        setPendingEnable(true);
        setConsentSheetVisible(true);
        return;
      }
      await applyPatch({ globalEnabled: true });
    } else {
      await applyPatch({ globalEnabled: false });
    }
  }

  async function handleConsentAccept(consentVersion: string) {
    setConsentSheetVisible(false);
    setPendingEnable(false);
    await applyPatch({ globalEnabled: true, consentVersion });
  }

  function handleConsentDismiss() {
    setConsentSheetVisible(false);
    setPendingEnable(false);
  }

  async function handleVisibilityMode(mode: VisibilityMode) {
    if (!settings) return;
    await applyPatch({ visibilityMode: mode });
  }

  async function applyPatch(patch: Parameters<typeof patchCircleSettings>[0]) {
    setSaving(true);
    const res = await patchCircleSettings(patch);
    setSaving(false);
    if (res.ok) {
      setSettings(res.data);
    } else if (res.status === 409) {
      load();
    } else {
      Alert.alert('Error', 'Could not save. Please try again.');
    }
  }

  if (loading) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} style={s.backBtn}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={s.headerTitle}>Find Your Circle</Text>
        </View>
        <View style={s.center}>
          <ActivityIndicator color={color.deep} />
        </View>
      </View>
    );
  }

  if (loadError || !settings) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} style={s.backBtn}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={s.headerTitle}>Find Your Circle</Text>
        </View>
        <View style={s.center}>
          <Text style={s.errorText}>
            {live ? 'Failed to load settings.' : 'Sign in to manage Find Your Circle.'}
          </Text>
          {live && loadError && (
            <Pressable style={s.retryBtn} onPress={load}>
              <Text style={s.retryText}>Try again</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  const isOff = !settings.globalEnabled;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Find Your Circle</Text>
        {saving && <ActivityIndicator size="small" color={color.deep} style={{ marginLeft: 'auto' }} />}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}>

        <View style={s.section}>
          <View style={s.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleLabel}>Find Your Circle</Text>
              <Text style={s.toggleSub}>
                {settings.globalEnabled
                  ? 'Sharing is on — co-travelers in your trips and events can see you'
                  : 'Off — no one can see your status or location in any circle'}
              </Text>
            </View>
            <Switch
              value={settings.globalEnabled}
              onValueChange={handleGlobalToggle}
              trackColor={{ true: color.deep }}
              thumbColor={color.onInk}
              disabled={saving || pendingEnable}
            />
          </View>
        </View>

        {settings.globalEnabled && (
          <>
            <View style={s.section}>
              <Text style={s.sectionLabel}>DEFAULT SHARING LEVEL</Text>
              <Text style={s.sectionSub}>
                Applied to all trips and events unless you set a per-trip or per-event override.
              </Text>
              {VISIBILITY_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[s.radioRow, settings.visibilityMode === opt.value && s.radioRowActive]}
                  onPress={() => handleVisibilityMode(opt.value)}
                  disabled={saving}
                >
                  <View style={[s.radio, settings.visibilityMode === opt.value && s.radioChecked]} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.radioLabel}>{opt.label}</Text>
                    <Text style={s.radioSub}>{opt.sub}</Text>
                  </View>
                </Pressable>
              ))}
            </View>

            <View style={s.section}>
              <Text style={s.sectionLabel}>SHARING CONTROLS</Text>
              <Pressable
                style={s.navRow}
                onPress={() => router.push('/settings/who-can-see-me' as any)}
              >
                <Users size={18} color={color.deep} />
                <View style={{ flex: 1 }}>
                  <Text style={s.navRowLabel}>Who can see me?</Text>
                  <Text style={s.navRowSub}>See who in each trip and event can view your status</Text>
                </View>
                <ChevronRight size={16} color={color.faint} />
              </Pressable>
            </View>
          </>
        )}

        <View style={s.section}>
          <Text style={s.sectionLabel}>PER-TRIP & PER-EVENT</Text>
          <Text style={s.sectionSub}>
            You can override sharing settings individually from each trip or event screen.
            Use the Circle icon or settings gear inside a trip or event to customize.
          </Text>
        </View>

        <View style={s.footerNote}>
          <View style={s.footerIcon}>
            <PauseCircle size={18} color={color.faint} />
          </View>
          <Text style={s.footerText}>
            Your Circle only includes people already in the same trip or event as you.
            Followers and other users cannot see your status.
            Your exact GPS coordinates are never shared.
          </Text>
        </View>

      </ScrollView>

      <FindYourCircleConsentSheet
        visible={consentSheetVisible}
        consentVersion={settings.currentConsentVersion}
        onAccept={handleConsentAccept}
        onDismiss={handleConsentDismiss}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  backBtn: {
    padding: space.xs,
    marginLeft: -space.xs,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.xl,
  },
  errorText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  section: {
    marginTop: space.xl,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: color.faint,
  },
  sectionSub: {
    ...t.small,
    color: color.mute,
    lineHeight: 17,
    marginBottom: space.xs,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  toggleLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  toggleSub: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
    lineHeight: 17,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  radioRowActive: {
    borderColor: color.deep,
    backgroundColor: '#EAF2F4',
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: color.haze,
    marginTop: 2,
    flexShrink: 0,
  },
  radioChecked: {
    borderColor: color.deep,
    backgroundColor: color.deep,
  },
  radioLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  radioSub: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
    lineHeight: 17,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  navRowLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  navRowSub: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
  },
  footerNote: {
    flexDirection: 'row',
    gap: space.sm,
    marginHorizontal: space.xl,
    marginTop: space.xl,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  footerIcon: {
    marginTop: 1,
    flexShrink: 0,
  },
  footerText: {
    ...t.small,
    color: color.faint,
    lineHeight: 17,
    flex: 1,
  },
});
