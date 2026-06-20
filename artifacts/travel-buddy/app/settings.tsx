import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Switch, StyleSheet, TextInput, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Zap, Brain } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { useSession } from '../src/context/SessionContext';
import { color, space, type as t, radius, layout } from '../src/theme/tokens';
import { updateTelegraphChatSettings } from '../src/services/telegraphChat';
import { fetchPreferences, patchPreferences, resetLearnedPreferences } from '../src/services/intelligence';

export default function Settings() {
  const { signOut, isAuthed, configured } = useSession();

  const [telegraphDM, setTelegraphDM] = useState(true);
  const [telegraphTrip, setTelegraphTrip] = useState(true);
  const [telegraphCircle, setTelegraphCircle] = useState(true);

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
      'Travel Buddy will forget what it learned from your saves and dismissals. Your explicit preferences (interests, pace, avoid list) are kept.',
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

  async function onItem(label: string) {
    if (label === 'Log out') {
      await signOut();
      router.replace('/(auth)/sign-in');
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

  const BASIC_GROUPS = [
    { h: 'Privacy', items: ['Hide current location', 'Hide upcoming trips', 'Private account', 'Nearby visibility', 'Message permissions'] },
    { h: 'Safety', items: ['Blocked accounts', 'Report history', 'Muted words'] },
    { h: 'Account', items: ['Edit profile', 'Notifications', 'Log out'] },
  ];

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
            Travel Buddy learns from what you save, dismiss, and add to trips so suggestions get better over time.
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

        {/* Standard settings groups */}
        {BASIC_GROUPS.map((g) => (
          <View key={g.h} style={{ gap: space.sm }}>
            <Text style={styles.h}>{g.h}</Text>
            {g.items.map((i) => {
              const isLogout = i === 'Log out';
              if (isLogout && !(configured && isAuthed)) return null;
              return (
                <Pressable
                  key={i}
                  style={({ pressed }) => [styles.row, pressed && { opacity: layout.pressedOpacity }]}
                  onPress={() => onItem(i)}
                >
                  <Text style={[styles.item, isLogout && styles.logout]}>{i}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
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
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: color.haze },
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
  item: { ...t.body, color: color.ink },
  logout: { color: color.signal, fontWeight: '700' },
});
