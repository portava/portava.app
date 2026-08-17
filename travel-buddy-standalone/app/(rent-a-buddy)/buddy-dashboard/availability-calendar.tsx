import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Switch, Alert, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Zap, ZapOff, Save } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState } from '../../../src/components/primitives';
import {
  getAvailabilitySettings, updateAvailabilitySettings,
  setAvailableNow, clearAvailableNow,
  getMyBuddyProfile,
  type FullAvailabilitySettings, bookingErrorCopy
} from '../../../src/services/rentABuddy';

const DURATION_OPTIONS = [30, 60, 120, 180];

function ToggleRow({ label, sub, value, onValueChange }: {
  label: string; sub?: string; value: boolean; onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={tog.wrap}>
      <View style={{ flex: 1 }}>
        <Text style={tog.label}>{label}</Text>
        {sub ? <Text style={tog.sub}>{sub}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ false: color.haze, true: color.deep }} />
    </View>
  );
}

export default function AvailabilityCalendar() {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<FullAvailabilitySettings>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isAvailableNow, setIsAvailableNow] = useState(false);
  const [availableNowDuration, setAvailableNowDuration] = useState(60);
  const [togglingNow, setTogglingNow] = useState(false);

  useEffect(() => {
    async function load() {
      const [settRes, profileRes] = await Promise.all([
        getAvailabilitySettings(),
        getMyBuddyProfile(),
      ]);
      setLoading(false);
      if (!settRes.ok) { setError(settRes.error); return; }
      setSettings(settRes.data.settings ?? {});
      if (profileRes.ok) {
        setIsAvailableNow(profileRes.data.profile?.availableNow ?? false);
      }
    }
    load();
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    const res = await updateAvailabilitySettings(settings);
    setSaving(false);
    if (!res.ok) { Alert.alert('Error', bookingErrorCopy(res.error)); return; }
    Alert.alert('Saved', 'Availability settings updated.');
  }, [settings]);

  const toggleAvailableNow = useCallback(async () => {
    setTogglingNow(true);
    if (isAvailableNow) {
      const res = await clearAvailableNow();
      if (res.ok) setIsAvailableNow(false);
      else Alert.alert('Error', bookingErrorCopy(res.error));
    } else {
      const res = await setAvailableNow(availableNowDuration);
      if (res.ok) setIsAvailableNow(true);
      else Alert.alert('Error', bookingErrorCopy(res.error));
    }
    setTogglingNow(false);
  }, [isAvailableNow, availableNowDuration]);

  const patch = useCallback(<K extends keyof FullAvailabilitySettings>(key: K, val: FullAvailabilitySettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: val }));
  }, []);

  if (loading) return <TravelLoadingState label="Loading availability…" />;
  if (error) return <TravelErrorState title="Failed to load" sub={error} />;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Availability</Text>
        <Pressable style={s.saveBtn} onPress={save} disabled={saving}>
          <Save size={18} color={color.deep} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + space.xxxl }]} showsVerticalScrollIndicator={false}>
        <View style={s.card}>
          <View style={s.availableNowRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.availableNowLabel}>
                {isAvailableNow ? '🟢 Available Now is ON' : '⚫ Available Now is OFF'}
              </Text>
              <Text style={s.availableNowSub}>
                {isAvailableNow
                  ? 'Travelers in your city can see you as available right now'
                  : 'Turn on to show up in the Available Now section'}
              </Text>
            </View>
            <Pressable
              style={[s.nowBtn, isAvailableNow && s.nowBtnActive]}
              onPress={toggleAvailableNow}
              disabled={togglingNow}
            >
              {isAvailableNow
                ? <ZapOff size={16} color={color.signal} />
                : <Zap size={16} color={color.success} />}
              <Text style={[s.nowBtnLabel, { color: isAvailableNow ? color.signal : color.success }]}>
                {isAvailableNow ? 'Turn Off' : 'Turn On'}
              </Text>
            </Pressable>
          </View>

          {!isAvailableNow ? (
            <>
              <Text style={s.sectionLabel}>Duration when turning on</Text>
              <View style={s.row}>
                {DURATION_OPTIONS.map((d) => (
                  <Pressable
                    key={d}
                    style={[s.durBtn, availableNowDuration === d && s.durBtnSel]}
                    onPress={() => setAvailableNowDuration(d)}
                  >
                    <Text style={[s.durLabel, availableNowDuration === d && s.durLabelSel]}>
                      {d < 60 ? `${d}m` : `${d / 60}h`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Buffer & Limits</Text>
          <Text style={s.label}>Min. notice (hours)</Text>
          <TextInput
            style={s.input}
            keyboardType="number-pad"
            value={settings.minNoticeHours != null ? String(settings.minNoticeHours) : ''}
            onChangeText={(v) => patch('minNoticeHours', v ? Number(v) : undefined)}
            placeholder="e.g. 2"
            placeholderTextColor={color.mute}
          />
          <Text style={s.label}>Buffer between bookings (minutes)</Text>
          <TextInput
            style={s.input}
            keyboardType="number-pad"
            value={settings.bufferMinutes != null ? String(settings.bufferMinutes) : ''}
            onChangeText={(v) => patch('bufferMinutes', v ? Number(v) : undefined)}
            placeholder="e.g. 30"
            placeholderTextColor={color.mute}
          />
          <Text style={s.label}>Max bookings per day</Text>
          <TextInput
            style={s.input}
            keyboardType="number-pad"
            value={settings.maxBookingsPerDay != null ? String(settings.maxBookingsPerDay) : ''}
            onChangeText={(v) => patch('maxBookingsPerDay', v ? Number(v) : undefined)}
            placeholder="e.g. 3"
            placeholderTextColor={color.mute}
          />
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Service Availability</Text>
          <ToggleRow
            label="Nightlife"
            sub="Available for nightlife bookings"
            value={settings.nightlifeAvailable ?? false}
            onValueChange={(v) => patch('nightlifeAvailable', v)}
          />
          <ToggleRow
            label="Arrival support"
            sub="Available to meet travelers at airports / stations"
            value={settings.arrivalAvailable ?? false}
            onValueChange={(v) => patch('arrivalAvailable', v)}
          />
          <ToggleRow
            label="Group experiences"
            sub="Available for groups of 3+"
            value={settings.groupAvailable ?? false}
            onValueChange={(v) => patch('groupAvailable', v)}
          />
          <ToggleRow
            label="Custom requests"
            sub="Open to unique traveler requests"
            value={settings.customAvailable ?? false}
            onValueChange={(v) => patch('customAvailable', v)}
          />
        </View>

        <Pressable
          style={[s.saveBottomBtn, saving && s.saveBottomBtnDisabled]}
          onPress={save}
          disabled={saving}
        >
          <Save size={16} color="#fff" />
          <Text style={s.saveBottomBtnLabel}>{saving ? 'Saving…' : 'Save Settings'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink, flex: 1 },
  saveBtn: { padding: space.sm },
  content: { padding: space.lg, gap: space.lg },
  card: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md },
  cardTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  availableNowRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  availableNowLabel: { ...t.body, color: color.ink, fontWeight: '700' },
  availableNowSub: { ...t.small, color: color.mute, marginTop: 2 },
  nowBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1.5, borderColor: `${color.success}40` },
  nowBtnActive: { borderColor: `${color.signal}40` },
  nowBtnLabel: { ...t.small, fontWeight: '700' },
  sectionLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space.sm },
  durBtn: { flex: 1, paddingVertical: space.md, alignItems: 'center', borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze },
  durBtnSel: { borderColor: color.deep, backgroundColor: `${color.deep}12` },
  durLabel: { ...t.small, color: color.ink },
  durLabelSel: { color: color.deep, fontWeight: '700' },
  label: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.sm },
  input: { ...t.body, color: color.ink, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze },
  saveBottomBtn: { backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, marginTop: space.sm },
  saveBottomBtnDisabled: { opacity: 0.4 },
  saveBottomBtnLabel: { ...t.body, color: '#fff', fontWeight: '700' },
});

const tog = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.sm },
  label: { ...t.body, color: color.ink, fontWeight: '600' },
  sub: { ...t.small, color: color.mute },
});
