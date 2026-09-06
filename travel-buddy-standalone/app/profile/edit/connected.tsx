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
import { Check, TriangleAlert, X } from 'lucide-react-native';
import { supabase } from '../../../src/lib/supabase';
import { adminGet } from '../../../src/services/adminApi';
import {
  applyDriftLoadResult,
  driftCount,
  type SchemaDriftReport,
} from '../../../src/screens/admin/schemaDrift.machine';
import {
  SettingsScreen, SettingsSection, SettingsRow, SettingsDivider, ToggleRow,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t, icon, dot} from '../../../src/theme/tokens';
import { updateTelegraphChatSettings, getTelegraphChatSettings } from '../../../src/services/telegraphChat';
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

// ── Schema drift warning (cached check, fetched once per screen visit) ────────

/** Fetch the cached drift report (no ?refresh — never triggers a live probe). */
async function fetchCachedDriftReport(): Promise<SchemaDriftReport | null> {
  const res = await adminGet<unknown>('/api/admin/health/schema-drift');
  if (!res.ok) return null;
  const { report } = applyDriftLoadResult({ ok: true, data: res.data });
  return report;
}

export default function ConnectedFeaturesScreen() {
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const { preferredLanguage, updateLanguage } = useLanguagePreference();

  const [isAdmin, setIsAdmin] = useState(false);
  const [driftReport, setDriftReport] = useState<SchemaDriftReport | null>(null);

  // Telegraph toggles — hydrated from the server so displayed state matches
  // what's actually saved (previously they always rendered ON).
  const [telegraphDM, setTelegraphDM] = useState(true);
  const [telegraphTrip, setTelegraphTrip] = useState(true);
  const [telegraphCircle, setTelegraphCircle] = useState(true);
  const [telegraphBusy, setTelegraphBusy] = useState<string | null>(null);
  useEffect(() => {
    getTelegraphChatSettings().then((s) => {
      if (!s) return;
      if (typeof s.show_telegraph_dm === 'boolean') setTelegraphDM(s.show_telegraph_dm);
      if (typeof s.show_telegraph_trip === 'boolean') setTelegraphTrip(s.show_telegraph_trip);
      if (typeof s.show_telegraph_circle === 'boolean') setTelegraphCircle(s.show_telegraph_circle);
    }).catch(() => {});
  }, []);

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

  // Once we know the viewer is an admin, fetch the CACHED drift status once
  // per screen visit so the Admin section can warn proactively.
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    fetchCachedDriftReport().then((report) => {
      if (alive) setDriftReport(report);
    });
    return () => { alive = false; };
  }, [isAdmin]);

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
            title="AI Visuals"
            subtitle="Visual generation dashboard & moderation"
            onPress={() => router.push('/admin/visuals' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Feature Flags"
            onPress={() => router.push('/admin/feature-flags' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Schema Drift"
            subtitle={
              driftReport?.status === 'drift'
                ? `Drift detected — ${driftCount(driftReport)} missing object${driftCount(driftReport) === 1 ? '' : 's'}`
                : 'Database health vs. migrations'
            }
            onPress={() => router.push('/admin/schema-drift' as any)}
            right={
              driftReport?.status === 'drift' ? (
                <View style={styles.driftBadge} testID="schema-drift-warning">
                  <TriangleAlert size={14} color={PP.paper} />
                  <Text style={styles.driftBadgeText}>{driftCount(driftReport)}</Text>
                </View>
              ) : undefined
            }
          />
          <SettingsDivider />
          <SettingsRow
            title="@Portava Posts"
            subtitle="Create and schedule curated travel content"
            onPress={() => router.push('/admin/portava-posts' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Place Mismatch Reports"
            subtitle="Review and action wrong-place reports"
            onPress={() => router.push('/admin/place-mismatch-reports' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Stamp Studio"
            subtitle="Stamp catalog, queue, and reconciler"
            onPress={() => router.push('/admin/stamps' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Content Reports"
            subtitle="User-submitted content report queue"
            onPress={() => router.push('/admin/content-reports' as any)}
          />
          <SettingsDivider />
          {/* §24 / Table-32 intelligence observability. Four read-only
              dashboards over the one internal report endpoint. */}
          <SettingsRow
            title="Intel Truth Health"
            subtitle="Claim coverage, conflict rate, source diversity"
            onPress={() => router.push('/admin/intel-truth-health' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Intel Calibration"
            subtitle="Density gate and calibration instrumentation"
            onPress={() => router.push('/admin/intel-calibration' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Intel Decision"
            subtitle="Arrival, entry, outcomes and regret feedback"
            onPress={() => router.push('/admin/intel-decision' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Intel Economy"
            subtitle="QIU shadow ledger and payout boundary"
            onPress={() => router.push('/admin/intel-economy' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Trust Reviews"
            onPress={() => router.push('/admin/trust-reviews' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Trust Settings"
            onPress={() => router.push('/admin/trust-settings' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Gaming Flags"
            onPress={() => router.push('/admin/gaming-flags' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Hashtags"
            onPress={() => router.push('/admin/hashtags' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Media Moderation"
            onPress={() => router.push('/admin/media' as any)}
          />
          <SettingsDivider />
          <SettingsRow
            title="Place Images"
            onPress={() => router.push('/admin/place-images' as any)}
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
    width: icon.s22, height: icon.s22, borderRadius: icon.s22 / 2, borderWidth: 2, borderColor: PP.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: PP.inkLight },
  radioDot: { width: dot.s10, height: dot.s10, borderRadius: dot.s10 / 2, backgroundColor: PP.inkLight },
  radioLabel: { ...t.body, color: PP.ink, fontWeight: '600' },
  radioDesc: { ...t.small, color: PP.inkMuted, fontSize: 12, marginTop: 1, lineHeight: 16 },

  driftBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#C05621', borderRadius: radius.pill ?? 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  driftBadgeText: { ...t.small, color: PP.paper, fontWeight: '700', fontSize: 12 },

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
