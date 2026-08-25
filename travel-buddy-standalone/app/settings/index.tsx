import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Switch, StyleSheet, TextInput, Alert, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Zap, Brain } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { supabase } from '../../src/lib/supabase';
import { color, space, type as t, radius, layout, icon, dot } from '../../src/theme/tokens';
import { updateTelegraphChatSettings, getTelegraphChatSettings } from '../../src/services/telegraphChat';
import { fetchPreferences, patchPreferences, resetLearnedPreferences } from '../../src/services/intelligence';
import { deactivateAccount, requestAccountDeletion, reactivateAccount } from '../../src/services/profile';
import { resolveAccountButton, applyReactivateResult } from '../../src/screens/settings/settings.machine';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { KILL_SWITCH_FLAGS } from '../../src/screens/admin/featureFlags.machine';

export default function Settings() {
  const { signOut, isAuthed, configured } = useSession();
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const [killSwitchCount, setKillSwitchCount] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const userId = data.session?.user?.id;
      if (!userId) return;
      supabase.from('profiles').select('role, account_status').eq('id', userId).maybeSingle().then(({ data: p }) => {
        if ((p as any)?.role === 'admin') setIsAdmin(true);
        setAccountStatus((p as any)?.account_status ?? null);
      });
    });
  }, []);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    async function checkKillSwitches() {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;
        const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
        const res = await fetch(`${apiBase}/api/admin/feature-flags`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const body = await res.json();
        const flags: Array<{ flag: string; enabled: boolean }> = body?.flags ?? [];
        const count = flags.filter((f) => KILL_SWITCH_FLAGS.includes(f.flag) && f.enabled).length;
        if (!cancelled) setKillSwitchCount(count);
      } catch { }
    }
    checkKillSwitches();
    const interval = setInterval(checkKillSwitches, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []));

  const [telegraphDM, setTelegraphDM] = useState(true);
  const [telegraphTrip, setTelegraphTrip] = useState(true);
  const [telegraphCircle, setTelegraphCircle] = useState(true);
  useEffect(() => {
    getTelegraphChatSettings().then((s) => {
      if (!s) return;
      if (typeof s.show_telegraph_dm === 'boolean') setTelegraphDM(s.show_telegraph_dm);
      if (typeof s.show_telegraph_trip === 'boolean') setTelegraphTrip(s.show_telegraph_trip);
      if (typeof s.show_telegraph_circle === 'boolean') setTelegraphCircle(s.show_telegraph_circle);
    }).catch(() => {});
  }, []);

  const [prefLoading, setPrefLoading] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);
  const [pace, setPace] = useState<'relaxed' | 'balanced' | 'packed'>('balanced');
  const [groupStyle, setGroupStyle] = useState<'solo' | 'small' | 'group' | 'mixed'>('mixed');
  const [interests, setInterests] = useState<string[]>([]);
  const [avoidList, setAvoidList] = useState<string[]>([]);
  const [avoidInput, setAvoidInput] = useState('');
  const [foodPreferences, setFoodPreferences] = useState<string[]>([]);
  const [nightlifePreferences, setNightlifePreferences] = useState<string[]>([]);
  const [prefTimes, setPrefTimes] = useState<string[]>([]);

  const live = configured && isAuthed;

  const loadPrefs = useCallback(async () => {
    if (!live) return;
    setPrefLoading(true);
    const res = await fetchPreferences();
    setPrefLoading(false);
    if (res.ok && res.data?.explicit) {
      const e = res.data.explicit;
      setPace(e.pace ?? 'balanced');
      setGroupStyle(e.groupStyle ?? 'mixed');
      setInterests(e.interests ?? []);
      setAvoidList(e.avoidList ?? []);
      setFoodPreferences(e.foodPreferences ?? []);
      setNightlifePreferences(e.nightlifePreferences ?? []);
      setPrefTimes(e.preferredActivityTimes ?? []);
    }
  }, [live]);

  useEffect(() => { loadPrefs(); }, [loadPrefs]);

  async function handleDeactivate() {
    Alert.alert(
      'Deactivate account?',
      'Your profile will be hidden from other users. You can reactivate by signing back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate', style: 'destructive',
          onPress: async () => {
            const res = await deactivateAccount();
            if (res.ok) {
              await signOut();
              router.replace('/(auth)/sign-in');
            } else {
              Alert.alert('Error', res.message ?? 'Could not deactivate. Try again.');
            }
          },
        },
      ],
    );
  }

  async function handleReactivate() {
    Alert.alert(
      'Reactivate account?',
      'Your profile will become visible to other users again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reactivate',
          onPress: async () => {
            const res = await reactivateAccount();
            const directive = applyReactivateResult(res);
            if (directive.type === 'success') {
              setAccountStatus(directive.nextStatus);
              Alert.alert('Account reactivated', 'Your profile is now visible to other users.');
            } else {
              Alert.alert('Error', directive.message);
            }
          },
        },
      ],
    );
  }

  async function handleRequestDeletion() {
    Alert.alert(
      'Request account deletion?',
      'Your account will be permanently deleted within 30 days. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Request deletion', style: 'destructive',
          onPress: async () => {
            const res = await requestAccountDeletion();
            if (res.ok) {
              Alert.alert('Request submitted', 'We will contact you to confirm. Your account will be deleted within 30 days.');
            } else {
              Alert.alert('Error', res.message ?? 'Could not submit request. Try again.');
            }
          },
        },
      ],
    );
  }

  async function savePref(patch: Record<string, any>) {
    if (!live) return;
    setPrefSaving(true);
    await patchPreferences(patch);
    setPrefSaving(false);
  }

  async function handleResetLearned() {
    if (!live) return;
    Alert.alert(
      'Reset learned preferences?',
      'Portava will forget what it learned from your saves and dismissals. Your explicit preferences (interests, pace, avoid list) are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset', style: 'destructive',
          onPress: async () => {
            await resetLearnedPreferences();
            Alert.alert('Done', 'Learned preferences have been reset.');
          },
        },
      ],
    );
  }

  function toggleInterest(item: string) {
    const next = interests.includes(item) ? interests.filter((i) => i !== item) : [...interests, item];
    setInterests(next);
    savePref({ interests: next });
  }

  function toggleFoodPref(item: string) {
    const next = foodPreferences.includes(item) ? foodPreferences.filter((f) => f !== item) : [...foodPreferences, item];
    setFoodPreferences(next);
    savePref({ foodPreferences: next });
  }

  function toggleNightlifePref(item: string) {
    const next = nightlifePreferences.includes(item) ? nightlifePreferences.filter((n) => n !== item) : [...nightlifePreferences, item];
    setNightlifePreferences(next);
    savePref({ nightlifePreferences: next });
  }

  function toggleTime(item: string) {
    const next = prefTimes.includes(item) ? prefTimes.filter((p) => p !== item) : [...prefTimes, item];
    setPrefTimes(next);
    savePref({ preferredActivityTimes: next });
  }

  function addAvoid() {
    const trimmed = avoidInput.trim().toLowerCase();
    if (!trimmed || avoidList.includes(trimmed)) { setAvoidInput(''); return; }
    const next = [...avoidList, trimmed];
    setAvoidList(next);
    setAvoidInput('');
    savePref({ avoidList: next });
  }

  function removeAvoid(item: string) {
    const next = avoidList.filter((a) => a !== item);
    setAvoidList(next);
    savePref({ avoidList: next });
  }

  const { isEnabled } = useFeatureFlags();

  async function onItem(label: string) {
    if (label === 'Log out') {
      await signOut();
      router.replace('/(auth)/sign-in');
    } else if (label === 'Close Friends') {
      router.push('/close-friends' as any);
    } else if (label === 'Blocked accounts') {
      router.push('/blocked-users');
    } else if (label === 'Muted accounts') {
      router.push('/muted-users' as any);
    } else if (label === 'Restricted accounts') {
      router.push('/restricted-users' as any);
    } else if (label === 'Safety & Privacy') {
      router.push('/profile/edit/safety' as any);
    } else if (label === 'Edit profile') {
      router.push('/profile/edit');
    } else if (label === 'Change password') {
      router.push('/profile/change-password' as any);
    } else if (label === 'Notifications') {
      router.push('/profile/edit/notifications' as any);
    } else if (label === 'Location settings') {
      router.push('/profile/edit/location' as any);
    } else if (label === 'Hide current location') {
      router.push('/profile/edit/location' as any);
    } else if (label === 'Nearby visibility') {
      router.push('/profile/edit/location' as any);
    } else if (label === 'Private account' || label === 'Hide upcoming trips' || label === 'Message permissions') {
      router.push('/profile/edit/privacy' as any);
    } else if (label === 'Safe Return history') {
      router.push('/safety-history' as any);
    } else if (label === 'Emergency Contacts') {
      router.push('/profile/edit/emergency-contacts' as any);
    } else if (label === 'Compass Preferences') {
      router.push('/compass-preferences' as any);
    } else if (label === 'Compass Settings') {
      router.push('/compass-settings' as any);
    } else if (label === 'My Appeals') {
      router.push('/appeals' as any);
    } else if (label === 'Reminders') {
      router.push('/reminders' as any);
    } else if (label === 'Live intel prompts') {
      router.push('/settings/intel-prompts' as any);
    }
  }

  async function handleTelegraphToggle(
    key: 'show_telegraph_dm' | 'show_telegraph_trip' | 'show_telegraph_circle',
    value: boolean,
  ) {
    if (key === 'show_telegraph_dm') setTelegraphDM(value);
    if (key === 'show_telegraph_trip') setTelegraphTrip(value);
    if (key === 'show_telegraph_circle') setTelegraphCircle(value);
    await updateTelegraphChatSettings({ [key]: value }).catch(() => {});
  }

  const SAFETY_ITEMS = ['Blocked accounts', 'Muted accounts', 'Restricted accounts', 'Safety & Privacy', 'Safe Return history', 'Emergency Contacts'];
  const ACCOUNT_ITEMS = ['Edit profile', 'Change password', 'Notifications', 'Location settings', 'Reminders', 'Compass Preferences', 'Compass Settings', 'My Appeals',
    // Intelligence Gathering prompt-pause controls — only surfaced when capture is enabled (flag off by default).
    ...(isEnabled('intel_capture_quick_signal') ? ['Live intel prompts'] : [])];

  const INTERESTS_OPTIONS = ['beach', 'food', 'nightlife', 'adventure', 'culture', 'wellness', 'photography', 'shopping', 'luxury', 'backpacking'];
  const FOOD_OPTIONS = ['street food', 'seafood', 'vegetarian', 'vegan', 'local cuisine', 'fine dining', 'coffee'];
  const NIGHTLIFE_OPTIONS = ['bars', 'clubs', 'live music', 'rooftop', 'night markets'];
  const PACE_OPTIONS: Array<{ value: 'relaxed' | 'balanced' | 'packed'; label: string; sub: string }> = [
    { value: 'relaxed', label: 'Relaxed', sub: 'Slow down, soak it in' },
    { value: 'balanced', label: 'Balanced', sub: 'Mix of plans + free time' },
    { value: 'packed', label: 'Packed', sub: 'Make the most of every day' },
  ];
  const GROUP_OPTIONS: Array<{ value: 'solo' | 'small' | 'group' | 'mixed'; label: string }> = [
    { value: 'solo', label: 'Solo' },
    { value: 'small', label: 'Small group (2–4)' },
    { value: 'group', label: 'Large group (5+)' },
    { value: 'mixed', label: 'Mixed / flexible' },
  ];
  const TIME_OPTIONS = ['morning', 'afternoon', 'evening', 'late_night'];
  const TIME_LABELS: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late_night: 'Late night' };

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Settings" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: space.xxxl }}>

        {/* Telegraph suggestions section */}
        <View style={{ gap: space.sm }}>
          <View style={styles.sectionHeader}>
            <Zap size={13} color={color.signal} fill={color.signal} />
            <Text style={styles.h}>Telegraph</Text>
          </View>
          <Text style={styles.sectionDesc}>
            Smart suggestions appear above the composer when Telegraph detects travel planning in your chats.
          </Text>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Direct messages</Text>
              <Text style={styles.toggleSub}>Show suggestions in 1-on-1 chats</Text>
            </View>
            <Switch
              value={telegraphDM}
              onValueChange={(v) => handleTelegraphToggle('show_telegraph_dm', v)}
              trackColor={{ true: color.signal }}
              thumbColor={color.onInk}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Trip chats</Text>
              <Text style={styles.toggleSub}>Show suggestions in trip group chats</Text>
            </View>
            <Switch
              value={telegraphTrip}
              onValueChange={(v) => handleTelegraphToggle('show_telegraph_trip', v)}
              trackColor={{ true: color.signal }}
              thumbColor={color.onInk}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Circle chats</Text>
              <Text style={styles.toggleSub}>Show suggestions in circle group chats</Text>
            </View>
            <Switch
              value={telegraphCircle}
              onValueChange={(v) => handleTelegraphToggle('show_telegraph_circle', v)}
              trackColor={{ true: color.signal }}
              thumbColor={color.onInk}
            />
          </View>
        </View>

        {/* Travel Preferences section */}
        <View style={{ gap: space.md }}>
          <View style={styles.sectionHeader}>
            <Brain size={13} color={color.deep} />
            <Text style={styles.h}>Travel Preferences</Text>
            {prefSaving && <ActivityIndicator size="small" color={color.mute} />}
          </View>
          <Text style={styles.sectionDesc}>
            Portava learns from what you save, dismiss, and add to trips so suggestions get better over time.
          </Text>

          {prefLoading ? (
            <View style={styles.loadRow}><ActivityIndicator color={color.signal} /><Text style={styles.loadText}>Loading…</Text></View>
          ) : (
            <>
              {/* Interests */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Interests</Text>
                <View style={styles.chipGrid}>
                  {INTERESTS_OPTIONS.map((i) => (
                    <Pressable key={i} style={[styles.chip, interests.includes(i) && styles.chipActive]} onPress={() => toggleInterest(i)}>
                      <Text style={[styles.chipText, interests.includes(i) && styles.chipTextActive]}>{i}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Food preferences */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Food preferences</Text>
                <View style={styles.chipGrid}>
                  {FOOD_OPTIONS.map((f) => (
                    <Pressable key={f} style={[styles.chip, foodPreferences.includes(f) && styles.chipActive]} onPress={() => toggleFoodPref(f)}>
                      <Text style={[styles.chipText, foodPreferences.includes(f) && styles.chipTextActive]}>{f}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Nightlife preferences */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Nightlife preferences</Text>
                <View style={styles.chipGrid}>
                  {NIGHTLIFE_OPTIONS.map((n) => (
                    <Pressable key={n} style={[styles.chip, nightlifePreferences.includes(n) && styles.chipActive]} onPress={() => toggleNightlifePref(n)}>
                      <Text style={[styles.chipText, nightlifePreferences.includes(n) && styles.chipTextActive]}>{n}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Travel pace */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Travel pace</Text>
                {PACE_OPTIONS.map((p) => (
                  <Pressable
                    key={p.value}
                    style={[styles.radioRow, pace === p.value && styles.radioRowActive]}
                    onPress={() => { setPace(p.value); savePref({ pace: p.value }); }}
                  >
                    <View style={[styles.radio, pace === p.value && styles.radioChecked]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.radioLabel}>{p.label}</Text>
                      <Text style={styles.radioSub}>{p.sub}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>

              {/* Group style */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Who do you travel with?</Text>
                <View style={styles.chipGrid}>
                  {GROUP_OPTIONS.map((g) => (
                    <Pressable
                      key={g.value}
                      style={[styles.chip, groupStyle === g.value && styles.chipActive]}
                      onPress={() => { setGroupStyle(g.value); savePref({ groupStyle: g.value }); }}
                    >
                      <Text style={[styles.chipText, groupStyle === g.value && styles.chipTextActive]}>{g.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Preferred activity times */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Preferred activity times</Text>
                <View style={styles.chipGrid}>
                  {TIME_OPTIONS.map((tm) => (
                    <Pressable key={tm} style={[styles.chip, prefTimes.includes(tm) && styles.chipActive]} onPress={() => toggleTime(tm)}>
                      <Text style={[styles.chipText, prefTimes.includes(tm) && styles.chipTextActive]}>{TIME_LABELS[tm]}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Avoid list */}
              <View style={{ gap: space.sm }}>
                <Text style={styles.prefLabel}>Avoid list</Text>
                <View style={styles.avoidInput}>
                  <TextInput
                    style={styles.avoidField}
                    value={avoidInput}
                    onChangeText={setAvoidInput}
                    placeholder="e.g. gambling, crowded places…"
                    placeholderTextColor={color.faint}
                    onSubmitEditing={addAvoid}
                    returnKeyType="done"
                    maxLength={50}
                  />
                  <Pressable style={styles.avoidAdd} onPress={addAvoid}><Text style={styles.avoidAddText}>Add</Text></Pressable>
                </View>
                {avoidList.length > 0 && (
                  <View style={styles.chipGrid}>
                    {avoidList.map((a) => (
                      <Pressable key={a} style={[styles.chip, styles.chipDanger]} onPress={() => removeAvoid(a)}>
                        <Text style={[styles.chipText, styles.chipTextDanger]}>{a} ×</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>

              {/* Reset learned */}
              <Pressable style={styles.resetBtn} onPress={handleResetLearned}>
                <Text style={styles.resetText}>Reset learned preferences</Text>
              </Pressable>
              <Text style={styles.resetSub}>Clears what Telegraph learned from your behaviour. Your explicit settings above are kept.</Text>
            </>
          )}
        </View>

        {/* Admin section — visible to users with role = 'admin' */}
        {isAdmin && (
          <View style={{ gap: space.sm }}>
            <Text style={styles.h}>Admin</Text>
            <Pressable
              style={({ pressed }) => [styles.row, styles.rowInline, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => router.push('/admin/feature-flags' as any)}
            >
              <Text style={styles.item}>Feature Flags</Text>
              {killSwitchCount > 0 && (
                <View style={styles.killPill}>
                  <View style={styles.killDot} />
                  <Text style={styles.killCount}>{killSwitchCount} active</Text>
                </View>
              )}
            </Pressable>
            {rentBuddyEnabled && (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => router.push('/(rent-a-buddy)/admin' as any)}
              >
                <Text style={styles.item}>Rent a Buddy Admin</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Find Your Circle section */}
        <View style={{ gap: space.sm }}>
          <Text style={styles.h}>Find Your Circle</Text>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
            onPress={() => router.push('/profile/edit/location' as any)}
          >
            <Text style={styles.item}>Find Your Circle settings</Text>
          </Pressable>
        </View>

        {/* Privacy section */}
        <View style={{ gap: space.sm }}>
          <Text style={styles.h}>Privacy</Text>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
            onPress={() => router.push('/profile/edit/privacy' as any)}
          >
            <Text style={styles.item}>Privacy settings</Text>
          </Pressable>
        </View>

        {/* Safety section */}
        <View style={{ gap: space.sm }}>
          <Text style={styles.h}>Safety</Text>
          {SAFETY_ITEMS.map((i) => (
            <Pressable
              key={i}
              style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => onItem(i)}
            >
              <Text style={styles.item}>{i}</Text>
            </Pressable>
          ))}
        </View>

        {/* Account section */}
        <View style={{ gap: space.sm }}>
          <Text style={styles.h}>Account</Text>
          {ACCOUNT_ITEMS.map((i) => (
            <Pressable
              key={i}
              style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => onItem(i)}
            >
              <Text style={styles.item}>{i}</Text>
            </Pressable>
          ))}

          {(configured && isAuthed) && (
            <>
              {resolveAccountButton(accountStatus) === 'reactivate' && (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                  onPress={handleReactivate}
                >
                  <Text style={[styles.item, { color: color.success }]}>Reactivate account</Text>
                </Pressable>
              )}
              {resolveAccountButton(accountStatus) === 'deactivate' && (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                  onPress={handleDeactivate}
                >
                  <Text style={[styles.item, { color: color.mute }]}>Deactivate account</Text>
                </Pressable>
              )}
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                onPress={handleRequestDeletion}
              >
                <Text style={[styles.item, { color: color.signal }]}>Delete account</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => onItem('Log out')}
              >
                <Text style={[styles.item, styles.logout]}>Log out</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  h: { ...t.stamp, fontFamily: 'Courier', color: color.mute },
  sectionDesc: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 17 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md,
  },
  toggleLabel: { ...t.body, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  loadRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  loadText: { ...t.small, color: color.mute },
  prefLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  chipActive: { backgroundColor: color.deep, borderColor: color.deep },
  chipDanger: { backgroundColor: '#FFF0EE', borderColor: color.signal },
  chipText: { ...t.small, color: color.ink, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: color.onInk },
  chipTextDanger: { color: color.signal },
  radioRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, padding: space.md,
  },
  radioRowActive: { borderColor: color.deep, backgroundColor: '#EAF2F4' },
  radio: { width: icon.s18, height: icon.s18, borderRadius: icon.s18 / 2, borderWidth: 2, borderColor: color.haze },
  radioChecked: { borderColor: color.deep, backgroundColor: color.deep },
  radioLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  radioSub: { ...t.small, color: color.mute, fontSize: 11 },
  avoidInput: { flexDirection: 'row', gap: space.sm },
  avoidField: {
    flex: 1, backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md,
    paddingVertical: space.sm, ...t.body, color: color.ink, fontSize: 13,
  },
  avoidAdd: {
    paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.deep,
    borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
  },
  avoidAddText: { ...t.small, color: color.onInk, fontWeight: '700' },
  resetBtn: {
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.signal,
    borderRadius: radius.md, padding: space.md, alignItems: 'center',
  },
  resetText: { ...t.bodyStrong, color: color.signal, fontSize: 13 },
  resetSub: { ...t.small, color: color.mute, fontSize: 11, lineHeight: 16 },
  row: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.lg },
  rowInline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  killPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FFF0EE', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  killDot: { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: '#E03131' },
  killCount: { ...t.small, color: '#E03131', fontWeight: '700', fontSize: 11 },
  item: { ...t.body, color: color.ink },
  logout: { color: color.signal, fontWeight: '700' },
  langRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  langRowLabel: { ...t.body, color: color.ink, fontSize: 14 },
  langRowValue: { ...t.small, color: color.mute, fontSize: 12, marginTop: 2 },
  langChevron: { fontSize: 22, color: color.mute, lineHeight: 26 },
});
