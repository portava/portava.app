/**
 * Per-context Circle settings screen.
 *
 * Route params: contextType ('trip' | 'event'), contextId (UUID), contextLabel (string)
 *
 * Reached by:
 *   router.push({ pathname: '/circle-context-settings', params: { contextType, contextId, contextLabel } })
 *
 * Allows the user to set a per-trip or per-event visibility override and
 * pause/resume sharing for that specific context.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, Switch, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, PauseCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, icon } from '../src/theme/tokens';
import {
  getCircleContextSettings,
  patchCircleContextSettings,
  pauseCircleContext,
  resumeCircleContext,
  type CircleContextSettings,
  type VisibilityMode,
} from '../src/services/circle';
import { useSession } from '../src/context/SessionContext';

const VISIBILITY_OPTIONS: Array<{ value: VisibilityMode | 'off'; label: string; sub: string }> = [
  {
    value: 'off',
    label: 'Off for this context',
    sub: 'You will not appear in this trip or event\'s circle',
  },
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

type EffectiveMode = VisibilityMode | 'off' | 'default';

export default function CircleContextSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { contextType, contextId, contextLabel } = useLocalSearchParams<{
    contextType: string;
    contextId: string;
    contextLabel?: string;
  }>();
  const { isAuthed, configured } = useSession();
  const live = configured && isAuthed;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [settings, setSettings] = useState<CircleContextSettings | null>(null);

  const isValidContext = contextType === 'trip' || contextType === 'event';

  const load = useCallback(async () => {
    if (!live || !isValidContext || !contextId) { setLoading(false); return; }
    setLoading(true);
    setLoadError(false);
    const res = await getCircleContextSettings(
      contextType as 'trip' | 'event',
      contextId,
    );
    setLoading(false);
    if (res.ok) {
      setSettings(res.data);
    } else {
      setLoadError(true);
    }
  }, [live, isValidContext, contextType, contextId]);

  useEffect(() => { load(); }, [load]);

  function effectiveMode(): EffectiveMode {
    if (!settings) return 'default';
    if (!settings.enabled) return 'off';
    return settings.visibilityModeOverride ?? 'default';
  }

  async function handleModeSelect(value: VisibilityMode | 'off') {
    if (!settings || !isValidContext || !contextId) return;
    if (value === 'off') {
      await applyPatch({ enabled: false, visibilityModeOverride: null });
    } else {
      await applyPatch({ enabled: true, visibilityModeOverride: value });
    }
  }

  async function handleResetToDefault() {
    if (!isValidContext || !contextId) return;
    await applyPatch({ enabled: true, visibilityModeOverride: null });
  }

  async function handlePauseToggle() {
    if (!settings || !isValidContext || !contextId) return;
    setSaving(true);
    const res = settings.paused
      ? await resumeCircleContext(contextType as 'trip' | 'event', contextId)
      : await pauseCircleContext(contextType as 'trip' | 'event', contextId);
    setSaving(false);
    if (res.ok) {
      setSettings((prev) => prev ? { ...prev, paused: res.data.paused } : prev);
    } else {
      Alert.alert('Error', 'Could not update pause. Try again.');
    }
  }

  async function applyPatch(patch: Parameters<typeof patchCircleContextSettings>[2]) {
    if (!isValidContext || !contextId) return;
    setSaving(true);
    const res = await patchCircleContextSettings(
      contextType as 'trip' | 'event',
      contextId,
      patch,
    );
    setSaving(false);
    if (res.ok) {
      setSettings(res.data);
    } else if (res.status === 403 && res.error === 'not_supported') {
      // Backend doesn't support precise mode in this version — see the
      // disabled option UI; this alert stays as a backstop only.
      Alert.alert('Not available', 'Precise live mode is not available in this version.');
    } else {
      Alert.alert('Error', 'Could not save. Please try again.');
    }
  }

  const current = effectiveMode();
  const title = contextLabel || (contextType === 'trip' ? 'Trip' : 'Event');

  const pageHeader = (
    <View style={s.header}>
      <Pressable
        onPress={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            // Reached directly (e.g. deep link) with no stack to pop —
            // fall back to the trip/event's Circle view instead of a no-op.
            router.replace({
              pathname: '/circle-presence',
              params: { contextType, contextId, contextLabel },
            } as any);
          }
        }}
        style={s.backBtn}
      >
        <ArrowLeft size={22} color={color.ink} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={s.headerTitle}>Circle sharing</Text>
        <Text style={s.headerSub} numberOfLines={1}>{title}</Text>
      </View>
      {saving && <ActivityIndicator size="small" color={color.deep} />}
    </View>
  );

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {loading ? (
        <View style={{ flex: 1 }}>
          {pageHeader}
          <View style={s.center}>
            <ActivityIndicator color={color.deep} />
          </View>
        </View>
      ) : loadError || !settings ? (
        <View style={{ flex: 1 }}>
          {pageHeader}
          <View style={s.center}>
            <Text style={s.errorText}>
              {live ? 'Failed to load settings.' : 'Sign in to manage Circle settings.'}
            </Text>
            {live && loadError && (
              <Pressable style={s.retryBtn} onPress={load}>
                <Text style={s.retryText}>Try again</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}>
          {pageHeader}

          {settings.paused && (
            <View style={s.pauseBanner}>
              <PauseCircle size={16} color={color.warn} />
              <Text style={s.pauseBannerText}>
                Sharing is paused for this {contextType}.
                {settings.pausedUntil
                  ? ` Until ${new Date(settings.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                  : ''}
              </Text>
            </View>
          )}

          <View style={s.section}>
            <Text style={s.sectionLabel}>SHARING LEVEL</Text>
            <Text style={s.sectionSub}>
              Override your global default for this {contextType} only.
              {current === 'default' ? ' Currently using your global default.' : ''}
            </Text>

            {current === 'default' && (
              <View style={s.defaultNotice}>
                <Text style={s.defaultNoticeText}>Using global default — no override set</Text>
              </View>
            )}

            {VISIBILITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[s.radioRow, current === opt.value && s.radioRowActive]}
                onPress={() => handleModeSelect(opt.value as VisibilityMode | 'off')}
                disabled={saving}
              >
                <View style={[s.radio, current === opt.value && s.radioChecked]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.radioLabel}>{opt.label}</Text>
                  <Text style={s.radioSub}>{opt.sub}</Text>
                </View>
              </Pressable>
            ))}

            {current !== 'default' && (
              <Pressable style={s.resetLink} onPress={handleResetToDefault} disabled={saving}>
                <Text style={s.resetLinkText}>Reset to global default</Text>
              </Pressable>
            )}
          </View>

          <View style={s.section}>
            <Text style={s.sectionLabel}>PAUSE SHARING</Text>
            <View style={s.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.toggleLabel}>
                  {settings.paused ? 'Resume sharing' : 'Pause sharing'}
                </Text>
                <Text style={s.toggleSub}>
                  {settings.paused
                    ? 'Tap to become visible again in this circle'
                    : 'Temporarily hide yourself from this circle without turning it off'}
                </Text>
              </View>
              <Switch
                value={settings.paused}
                onValueChange={handlePauseToggle}
                trackColor={{ true: color.warn }}
                thumbColor={color.onInk}
                disabled={saving}
              />
            </View>
          </View>

          <View style={s.footerNote}>
            <Text style={s.footerText}>
              This override applies to this {contextType} only.
              Your global default is used for all other circles.
              Your exact GPS coordinates are never shared.
            </Text>
          </View>
        </ScrollView>
      )}
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
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  headerSub: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
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
  pauseBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: '#FEF3E2',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: '#F5D89A',
  },
  pauseBannerText: {
    ...t.small,
    color: color.warn,
    flex: 1,
    lineHeight: 17,
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
  defaultNotice: {
    backgroundColor: '#EAF2F4',
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  defaultNoticeText: {
    ...t.small,
    color: color.deep,
    fontWeight: '600',
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
    width: icon.s18, height: icon.s18,
    borderRadius: icon.s18 / 2,
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
  resetLink: {
    alignSelf: 'flex-start',
    paddingVertical: space.xs,
  },
  resetLinkText: {
    ...t.small,
    color: color.deep,
    fontWeight: '600',
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
    fontSize: 14,
  },
  toggleSub: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
    lineHeight: 17,
  },
  footerNote: {
    marginHorizontal: space.xl,
    marginTop: space.xl,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  footerText: {
    ...t.small,
    color: color.faint,
    lineHeight: 17,
    textAlign: 'center',
  },
});
