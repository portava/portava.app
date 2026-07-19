/**
 * Calling — Edit Profile & Settings hub sub-page (spec §22).
 *
 * Who can call me / Rent a Buddy call access / video calls / incoming call
 * notifications. Preferences persist server-side (GET/PUT /api/calls/
 * preferences) and the server enforces them on every call attempt —
 * immediate-save semantics like the Notifications screen.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Check } from 'lucide-react-native';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SettingsDivider, ToggleRow,
} from '../../../src/components/settings/SettingsUI';
import {
  getCallPreferences, updateCallPreferences,
  type CallPreferences, type WhoCanCall,
} from '../../../src/services/callPreferences';

const WHO_OPTIONS: { value: WhoCanCall; label: string; description: string }[] = [
  {
    value: 'people_i_message',
    label: 'People I message with',
    description: 'Anyone you have an active Telegraph conversation with',
  },
  {
    value: 'rab_contacts',
    label: 'Rent a Buddy contacts',
    description: 'Only people connected to you through a booking',
  },
  {
    value: 'nobody',
    label: 'Nobody',
    description: 'No one can call you',
  },
];

export default function CallingSettingsScreen() {
  const [prefs, setPrefs] = useState<CallPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCallPreferences().then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setPrefs(res.data);
      else setLoadError(res.error ?? 'Could not load calling settings.');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function apply(patch: Partial<CallPreferences>) {
    if (!prefs) return;
    const prev = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic — revert on failure
    const res = await updateCallPreferences(patch);
    if (!res.ok) {
      setPrefs(prev);
      Alert.alert('Could not save', res.error ?? 'Please try again.');
    } else if (res.data) {
      setPrefs(res.data);
    }
  }

  return (
    <SettingsScreen title="Calling" subtitle="Who can call you and how">
      {loading ? (
        <View style={s.center}><ActivityIndicator color={PP.ink} /></View>
      ) : loadError || !prefs ? (
        <View style={s.center}><Text style={s.errText}>{loadError ?? 'Could not load calling settings.'}</Text></View>
      ) : (
        <>
          <SettingsSection title="Who can call me">
            {WHO_OPTIONS.map((opt, i) => (
              <React.Fragment key={opt.value}>
                {i > 0 && <SettingsDivider />}
                <Pressable
                  style={s.option}
                  onPress={() => { void apply({ whoCanCall: opt.value }); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: prefs.whoCanCall === opt.value }}
                  accessibilityLabel={opt.label}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.optionLabel}>{opt.label}</Text>
                    <Text style={s.optionDesc}>{opt.description}</Text>
                  </View>
                  {prefs.whoCanCall === opt.value && <Check size={18} color={PP.ink} />}
                </Pressable>
              </React.Fragment>
            ))}
          </SettingsSection>

          <SettingsSection title="Call types">
            <ToggleRow
              title="Allow calls related to Rent a Buddy bookings"
              subtitle="Coordination calls for your active bookings"
              value={prefs.allowRentABuddyCalls}
              onValueChange={(v) => { void apply({ allowRentABuddyCalls: v }); }}
            />
            <SettingsDivider />
            <ToggleRow
              title="Allow video calls"
              subtitle="When off, people can only reach you by voice"
              value={prefs.allowVideoCalls}
              onValueChange={(v) => { void apply({ allowVideoCalls: v }); }}
            />
          </SettingsSection>

          <SettingsSection title="Notifications">
            <ToggleRow
              title="Incoming call notifications"
              subtitle="Alert me when someone calls"
              value={prefs.incomingCallNotifications}
              onValueChange={(v) => { void apply({ incomingCallNotifications: v }); }}
            />
          </SettingsSection>

          <View style={s.note}>
            <Text style={s.noteText}>
              While the app is open, incoming calls ring in-app. When the app is
              in the background, you'll get a push notification instead — tap it
              to answer. Calls can't wake the phone like the built-in dialer.
            </Text>
          </View>
        </>
      )}
    </SettingsScreen>
  );
}

const s = StyleSheet.create({
  center: { paddingVertical: 60, alignItems: 'center' },
  errText: { ...t.body, color: PP.inkMuted, textAlign: 'center', paddingHorizontal: space.xl },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: 12, paddingHorizontal: space.md,
  },
  optionLabel: { ...t.bodyStrong, color: PP.ink },
  optionDesc: { ...t.small, color: PP.inkMuted, marginTop: 2 },
  note: {
    marginTop: space.lg, marginHorizontal: space.md,
    padding: space.md, borderRadius: radius.md,
    backgroundColor: PP.paperShadow + '55',
  },
  noteText: { ...t.small, color: PP.inkMuted, lineHeight: 18 },
});
