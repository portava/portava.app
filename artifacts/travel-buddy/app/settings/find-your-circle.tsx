/**
 * Find Your Circle — global settings screen.
 *
 * Accessible from Settings > Find Your Circle.
 * Controls global on/off toggle, per-type sharing defaults (trip & event),
 * global pause, and "Who can see me?" entry.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, Switch, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, Users, PauseCircle, PlayCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getCircleSettings,
  patchCircleSettings,
  pauseAllCircleSharing,
  type CircleSettings,
  type ContextSharingDefault,
} from '../../src/services/circle';
import { FindYourCircleConsentSheet } from '../../src/components/FindYourCircleConsentSheet';
import { useSession } from '../../src/context/SessionContext';

const CONTEXT_OPTIONS: Array<{ value: ContextSharingDefault; label: string; sub: string }> = [
  {
    value: 'off',
    label: 'Off',
    sub: 'You will not appear in circles for this type',
  },
  {
    value: 'status_only',
    label: 'Status only',
    sub: 'Co-travelers see your status (e.g. Active) — no location',
  },
  {
    value: 'approximate_area',
    label: 'Approximate area',
    sub: 'Co-travelers see a neighbourhood label you set',
  },
  {
    value: 'venue_checkin',
    label: 'Venue check-in',
    sub: 'Co-travelers see your venue name when you check in',
  },
];

function DefaultPicker({
  label,
  sub,
  value,
  onChange,
  disabled,
}: {
  label: string;
  sub: string;
  value: ContextSharingDefault;
  onChange: (v: ContextSharingDefault) => void;
  disabled: boolean;
}) {
  return (
    <View style={s.pickerBlock}>
      <Text style={s.pickerLabel}>{label}</Text>
      <Text style={s.pickerSub}>{sub}</Text>
      {CONTEXT_OPTIONS.map((opt) => (
        <Pressable
          key={opt.value}
          style={[s.radioRow, value === opt.value && s.radioRowActive]}
          onPress={() => onChange(opt.value)}
          disabled={disabled}
        >
          <View style={[s.radio, value === opt.value && s.radioChecked]} />
          <View style={{ flex: 1 }}>
            <Text style={s.radioLabel}>{opt.label}</Text>
            <Text style={s.radioSub}>{opt.sub}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

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

  async function handlePauseToggle(value: boolean) {
    if (!settings) return;
    if (value) {
      setSaving(true);
      const res = await pauseAllCircleSharing();
      setSaving(false);
      if (res.ok) {
        setSettings(res.data);
      } else {
        Alert.alert('Error', 'Could not pause sharing. Try again.');
      }
    } else {
      await applyPatch({ isPaused: false });
    }
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
        <View style={s.center}><ActivityIndicator color={color.deep} /></View>
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

        {/* Global toggle */}
        <View style={s.section}>
          <View style={s.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleLabel}>Find Your Circle</Text>
              <Text style={s.toggleSub}>
                {settings.globalEnabled
                  ? (settings.isPaused
                    ? 'Paused — no one can see you right now'
                    : 'On — co-travelers in your trips and events can see you')
                  : 'Off — no one can see your status in any circle'}
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
            {/* Pause banner */}
            {settings.isPaused && (
              <View style={s.pauseBanner}>
                <PauseCircle size={16} color={color.warn} />
                <Text style={s.pauseBannerText}>
                  All sharing paused. No co-traveler can see you right now.
                </Text>
              </View>
            )}

            {/* Pause sharing toggle */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>SHARING PAUSE</Text>
              <View style={s.toggleRow}>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  {settings.isPaused
                    ? <PlayCircle size={18} color={color.warn} />
                    : <PauseCircle size={18} color={color.mute} />}
                  <View style={{ flex: 1 }}>
                    <Text style={s.toggleLabel}>
                      {settings.isPaused ? 'Resume sharing' : 'Pause all sharing'}
                    </Text>
                    <Text style={s.toggleSub}>
                      {settings.isPaused
                        ? 'Become visible again in all your circles'
                        : 'Instantly hide yourself from all circles'}
                    </Text>
                  </View>
                </View>
                <Switch
                  value={settings.isPaused}
                  onValueChange={handlePauseToggle}
                  trackColor={{ true: color.warn }}
                  thumbColor={color.onInk}
                  disabled={saving}
                />
              </View>
            </View>

            {/* Trip sharing default */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>TRIP SHARING DEFAULT</Text>
              <DefaultPicker
                label="Trip circles"
                sub="Default level of detail shared in trip circles. Can be overridden per trip."
                value={settings.tripSharingDefault}
                onChange={(v) => applyPatch({ tripSharingDefault: v })}
                disabled={saving}
              />
            </View>

            {/* Event sharing default */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>EVENT SHARING DEFAULT</Text>
              <DefaultPicker
                label="Event circles"
                sub="Default level of detail shared in event circles. Can be overridden per event."
                value={settings.eventSharingDefault}
                onChange={(v) => applyPatch({ eventSharingDefault: v })}
                disabled={saving}
              />
            </View>

            {/* Who can see me */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>VISIBILITY</Text>
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

        {/* Per-trip/event note */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>PER-TRIP & PER-EVENT</Text>
          <Text style={s.sectionSub}>
            You can override sharing settings for individual trips and events.
            Use the Circle icon or settings gear inside a trip or event.
          </Text>
        </View>

        {/* Privacy note */}
        <View style={s.footerNote}>
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
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.md,
  },
  backBtn: { padding: space.xs, marginLeft: -space.xs },
  headerTitle: { ...t.heading, color: color.ink, fontSize: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  errorText: { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn: { paddingHorizontal: space.xl, paddingVertical: space.sm, backgroundColor: color.deep, borderRadius: radius.md },
  retryText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  section: { marginTop: space.xl, paddingHorizontal: space.lg, gap: space.sm },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: color.faint },
  sectionSub: { ...t.small, color: color.mute, lineHeight: 17 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md,
  },
  toggleLabel: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 17 },
  pauseBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#FEF3E2', paddingHorizontal: space.lg,
    paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: '#F5D89A',
    marginTop: space.md,
  },
  pauseBannerText: { ...t.small, color: color.warn, flex: 1, lineHeight: 17 },
  pickerBlock: { gap: space.sm },
  pickerLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  pickerSub: { ...t.small, color: color.mute, lineHeight: 17, marginBottom: space.xs },
  radioRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, padding: space.md,
  },
  radioRowActive: { borderColor: color.deep, backgroundColor: '#EAF2F4' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: color.haze, marginTop: 2, flexShrink: 0 },
  radioChecked: { borderColor: color.deep, backgroundColor: color.deep },
  radioLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  radioSub: { ...t.small, color: color.mute, marginTop: 1, lineHeight: 17 },
  navRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  navRowLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  navRowSub: { ...t.small, color: color.mute, marginTop: 1 },
  footerNote: {
    marginHorizontal: space.xl, marginTop: space.xl,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  footerText: { ...t.small, color: color.faint, lineHeight: 17, textAlign: 'center' },
});
