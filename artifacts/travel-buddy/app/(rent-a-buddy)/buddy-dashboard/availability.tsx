import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Switch, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Save, Minus, Plus } from 'lucide-react-native';
import {
  TravelButton, TravelCard, TravelChip, TravelLoadingState, TravelSectionHeader,
} from '../../../src/components/primitives';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_BLOCKS = [
  { key: 'morning', label: 'Morning', sub: '6am–12pm' },
  { key: 'afternoon', label: 'Afternoon', sub: '12pm–6pm' },
  { key: 'evening', label: 'Evening', sub: '6pm–10pm' },
  { key: 'latenight', label: 'Late Night', sub: '10pm–2am' },
];
const NOTICE_OPTIONS = ['1 hour', '2 hours', '4 hours', '24 hours'];
const BUFFER_OPTIONS = ['None', '30 min', '1 hour'];

export default function BuddyAvailabilityScreen() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [availableNow, setAvailableNow] = useState(false);
  const [grid, setGrid] = useState<Record<string, Record<string, boolean>>>({});
  const [notice, setNotice] = useState('2 hours');
  const [buffer, setBuffer] = useState('30 min');
  const [maxPerDay, setMaxPerDay] = useState(3);
  const [vacStart, setVacStart] = useState('');
  const [vacEnd, setVacEnd] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await rentABuddy.getDashboardAvailability();
    setLoading(false);
    if (res.ok) {
      const g: Record<string, Record<string, boolean>> = {};
      res.data.availability.forEach((a) => {
        DAYS.forEach((d) => { g[d] = g[d] ?? {}; });
        a.timeSlots.forEach((slot) => {
          const dayKey = new Date(a.date).toLocaleDateString('en-US', { weekday: 'short' });
          if (!g[dayKey]) g[dayKey] = {};
          g[dayKey][slot] = a.isAvailable;
        });
      });
      if (Object.keys(g).length > 0) setGrid(g);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleSlot(day: string, block: string) {
    setGrid((prev) => {
      const dayCopy = { ...(prev[day] ?? {}) };
      dayCopy[block] = !dayCopy[block];
      return { ...prev, [day]: dayCopy };
    });
  }

  function setDayAll(day: string, val: boolean) {
    setGrid((prev) => {
      const next: Record<string, boolean> = {};
      TIME_BLOCKS.forEach((b) => { next[b.key] = val; });
      return { ...prev, [day]: next };
    });
  }

  async function handleSave() {
    setSaving(true);
    const entries: Array<{ date: string; timeSlots: string[]; isAvailable: boolean }> = [];
    DAYS.forEach((day) => {
      const slots = Object.entries(grid[day] ?? {})
        .filter(([, on]) => on)
        .map(([k]) => k);
      if (slots.length > 0) {
        entries.push({ date: day, timeSlots: slots, isAvailable: true });
      }
    });
    const [gridRes, settingsRes] = await Promise.all([
      rentABuddy.setDashboardAvailability(entries),
      rentABuddy.setAvailabilitySettings({
        availableNow,
        minNoticeHours: NOTICE_OPTIONS.indexOf(notice) >= 0
          ? [1, 2, 4, 24][NOTICE_OPTIONS.indexOf(notice)]
          : undefined,
        bufferMinutes: BUFFER_OPTIONS.indexOf(buffer) >= 0
          ? [0, 30, 60][BUFFER_OPTIONS.indexOf(buffer)]
          : undefined,
        maxBookingsPerDay: maxPerDay,
        blockedFrom: vacStart.trim() || undefined,
        blockedTo: vacEnd.trim() || undefined,
      }),
    ]);
    setSaving(false);
    if (gridRes.ok && settingsRes.ok) {
      Alert.alert('Saved', 'Your availability has been updated.');
    } else {
      const errMsg = !gridRes.ok ? gridRes.error : (!settingsRes.ok ? settingsRes.error : undefined);
      Alert.alert('Error', errMsg ?? 'Could not save availability.');
    }
  }

  if (loading) return <TravelLoadingState label="Loading availability…" />;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Availability</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Available Now */}
        <TravelCard style={{ padding: space.lg, marginBottom: space.xl }}>
          <View style={s.availNowRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.availNowLabel}>Available Right Now</Text>
              <Text style={s.availNowSub}>Show travellers you can meet today</Text>
            </View>
            <Switch
              value={availableNow}
              onValueChange={setAvailableNow}
              trackColor={{ false: color.haze, true: color.success }}
              thumbColor={color.onInk}
            />
          </View>
        </TravelCard>

        {/* Weekly grid */}
        <Text style={s.sectionTitle}>Weekly schedule</Text>
        <Text style={s.sectionSub}>Tap cells to mark available time blocks. Tap a day name to toggle the whole day.</Text>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.xl }}>
          <View>
            {/* Day headers */}
            <View style={grid_.headerRow}>
              <View style={grid_.blockCol} />
              {DAYS.map((d) => {
                const dayOn = TIME_BLOCKS.every((b) => grid[d]?.[b.key]);
                return (
                  <Pressable
                    key={d}
                    style={grid_.dayHeader}
                    onPress={() => setDayAll(d, !dayOn)}
                  >
                    <Text style={[grid_.dayText, dayOn && grid_.dayTextOn]}>{d}</Text>
                  </Pressable>
                );
              })}
            </View>
            {TIME_BLOCKS.map((block) => (
              <View key={block.key} style={grid_.row}>
                <View style={grid_.blockCol}>
                  <Text style={grid_.blockLabel}>{block.label}</Text>
                  <Text style={grid_.blockSub}>{block.sub}</Text>
                </View>
                {DAYS.map((d) => {
                  const on = grid[d]?.[block.key] ?? false;
                  return (
                    <Pressable
                      key={d}
                      style={[grid_.cell, on && grid_.cellOn]}
                      onPress={() => toggleSlot(d, block.key)}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>

        {/* Minimum notice */}
        <Text style={s.sectionTitle}>Minimum notice</Text>
        <Text style={s.sectionSub}>How much advance notice do you need before a booking?</Text>
        <View style={chips.row}>
          {NOTICE_OPTIONS.map((n) => (
            <TravelChip key={n} label={n} active={notice === n} onPress={() => setNotice(n)} />
          ))}
        </View>

        {/* Buffer time */}
        <Text style={[s.sectionTitle, { marginTop: space.xl }]}>Buffer between bookings</Text>
        <Text style={s.sectionSub}>Time you need between back-to-back bookings.</Text>
        <View style={chips.row}>
          {BUFFER_OPTIONS.map((b) => (
            <TravelChip key={b} label={b} active={buffer === b} onPress={() => setBuffer(b)} />
          ))}
        </View>

        {/* Max bookings */}
        <Text style={[s.sectionTitle, { marginTop: space.xl }]}>Max bookings per day</Text>
        <View style={stepper.wrap}>
          <Pressable
            style={stepper.btn}
            onPress={() => setMaxPerDay((v) => Math.max(1, v - 1))}
          >
            <Minus size={16} color={color.ink} />
          </Pressable>
          <Text style={stepper.val}>{maxPerDay}</Text>
          <Pressable
            style={stepper.btn}
            onPress={() => setMaxPerDay((v) => Math.min(10, v + 1))}
          >
            <Plus size={16} color={color.ink} />
          </Pressable>
        </View>

        {/* Blocked dates */}
        <Text style={[s.sectionTitle, { marginTop: space.xl }]}>Vacation / blocked dates</Text>
        <Text style={s.sectionSub}>Block a date range when you're away.</Text>
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          <View style={{ flex: 1 }}>
            <Text style={s.inputLabel}>From</Text>
            <View style={fi.input}>
              <Text style={vacStart ? fi.inputText : fi.inputPlaceholder}>
                {vacStart || 'YYYY-MM-DD'}
              </Text>
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.inputLabel}>To</Text>
            <View style={fi.input}>
              <Text style={vacEnd ? fi.inputText : fi.inputPlaceholder}>
                {vacEnd || 'YYYY-MM-DD'}
              </Text>
            </View>
          </View>
        </View>
        <Text style={[s.sectionSub, { marginTop: space.xs }]}>
          Date picker coming soon. Enter dates manually above.
        </Text>
      </ScrollView>

      <View style={[s.footer, { paddingBottom: insets.bottom + space.md }]}>
        <TravelButton
          label={saving ? 'Saving…' : 'Save availability'}
          onPress={handleSave}
          variant="primary"
          full
          icon={<Save size={14} color={color.onInk} />}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: color.ink, flexDirection: 'row',
    alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },
  headerTitle: { ...t.heading, color: color.onInk, flex: 1 },
  sectionTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 4 },
  sectionSub: { ...t.small, color: color.mute, lineHeight: 17, marginBottom: space.md },
  availNowRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  availNowLabel: { ...t.bodyStrong, color: color.ink },
  availNowSub: { ...t.small, color: color.mute, marginTop: 2 },
  footer: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze,
    backgroundColor: color.paper,
  },
  inputLabel: { ...t.small, color: color.ink, fontWeight: '600', marginBottom: space.xs },
});

const grid_ = StyleSheet.create({
  headerRow: { flexDirection: 'row', marginBottom: 2 },
  row: { flexDirection: 'row', marginBottom: 2 },
  blockCol: { width: 90, justifyContent: 'center', paddingRight: space.sm },
  blockLabel: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 11 },
  blockSub: { fontFamily: 'Courier', fontSize: 8, color: color.faint, letterSpacing: 0.3 },
  dayHeader: { width: 42, alignItems: 'center', paddingBottom: 4 },
  dayText: { ...t.stamp, color: color.mute },
  dayTextOn: { color: color.signal },
  cell: {
    width: 42, height: 42, borderRadius: radius.sm,
    borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, margin: 1,
  },
  cellOn: { backgroundColor: '#E6F4ED', borderColor: color.success },
});

const chips = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});

const stepper = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.sm },
  btn: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 1.5, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.paperRaised,
  },
  val: { ...t.heading, color: color.ink, minWidth: 40, textAlign: 'center' },
});

const fi = StyleSheet.create({
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    backgroundColor: color.paperRaised, justifyContent: 'center',
  },
  inputText: { ...t.body, color: color.ink },
  inputPlaceholder: { ...t.body, color: color.faint },
});
