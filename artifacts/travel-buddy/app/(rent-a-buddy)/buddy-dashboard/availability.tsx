import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { GlobalCalendarPicker } from '../../../src/components/selectors/GlobalCalendarPicker';
import { fromISODate, formatDisplayDate } from '../../../src/lib/dateTime/formatters';
import { weekdayKeyFromISODate } from '../../../src/lib/weekdayFromISODate';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKS_AHEAD = 8;
const DAY_OF_WEEK: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

function nextOccurrences(dayName: string, weeks: number): string[] {
  const target = DAY_OF_WEEK[dayName];
  if (target === undefined) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const offset = (target - today.getDay() + 7) % 7;
  const dates: string[] = [];
  for (let w = 0; w < weeks; w++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset + w * 7);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}
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
  const saveLockRef = useRef(false);
  const [availableNow, setAvailableNow] = useState(false);
  const [grid, setGrid] = useState<Record<string, Record<string, boolean>>>({});
  const [notice, setNotice] = useState('2 hours');
  const [buffer, setBuffer] = useState('30 min');
  const [maxPerDay, setMaxPerDay] = useState(3);
  const [vacStart, setVacStart] = useState('');
  const [vacEnd, setVacEnd] = useState('');
  const [showVacPicker, setShowVacPicker] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await rentABuddy.getDashboardAvailability();
    setLoading(false);
    if (res.ok) {
      const g: Record<string, Record<string, boolean>> = {};
      res.data.availability.forEach((a) => {
        DAYS.forEach((d) => { g[d] = g[d] ?? {}; });
        // Derive the weekday from the ISO date parts in LOCAL time.
        // `new Date('YYYY-MM-DD')` parses as UTC midnight, so in negative-UTC
        // timezones toLocaleDateString shifted every row back one weekday and
        // the reloaded grid didn't match what was saved.
        const dayKey = weekdayKeyFromISODate(a.date);
        if (!dayKey) return;
        a.timeSlots.forEach((slot) => {
          if (!g[dayKey]) g[dayKey] = {};
          g[dayKey][slot] = a.isAvailable;
        });
      });
      if (Object.keys(g).length > 0) setGrid(g);
      const st = res.data.settings;
      if (st) {
        setAvailableNow(!!st.availableNow);
        if (st.minNoticeHours != null) {
          const idx = [1, 2, 4, 24].indexOf(st.minNoticeHours);
          if (idx >= 0) setNotice(NOTICE_OPTIONS[idx]);
        }
        if (st.bufferMinutes != null) {
          const idx = [0, 30, 60].indexOf(st.bufferMinutes);
          if (idx >= 0) setBuffer(BUFFER_OPTIONS[idx]);
        }
        if (st.maxBookingsPerDay != null) setMaxPerDay(st.maxBookingsPerDay);
        setVacStart(st.blockedFrom ?? '');
        setVacEnd(st.blockedTo ?? '');
      }
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
    if (saveLockRef.current) return;
    saveLockRef.current = true;
    setSaving(true);
    try {
      const entries: Array<{ date: string; timeSlots: string[]; isAvailable: boolean }> = [];
      DAYS.forEach((day) => {
        const slots = Object.entries(grid[day] ?? {})
          .filter(([, on]) => on)
          .map(([k]) => k);
        // Send an entry for every date in the window — not just "on" days.
        // isAvailable:false entries upsert the existing DB row to "off", so
        // previously saved slots are cleared when a buddy deselects a day.
        nextOccurrences(day, WEEKS_AHEAD).forEach((date) => {
          entries.push({ date, timeSlots: slots, isAvailable: slots.length > 0 });
        });
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
          // '' clears a previously saved blocked range on the server
          blockedFrom: vacStart.trim(),
          blockedTo: vacEnd.trim(),
        }),
      ]);
      if (gridRes.ok && settingsRes.ok) {
        Alert.alert('Saved', 'Your availability has been updated.', [
          { text: 'OK', onPress: () => { if (router.canGoBack()) router.back(); } },
        ]);
      } else {
        const errMsg = !gridRes.ok ? gridRes.error : (!settingsRes.ok ? settingsRes.error : undefined);
        Alert.alert('Error', errMsg ?? 'Could not save availability.');
      }
    } finally {
      saveLockRef.current = false;
      setSaving(false);
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
            <Pressable style={fi.input} onPress={() => setShowVacPicker(true)}>
              <Text style={vacStart ? fi.inputText : fi.inputPlaceholder}>
                {vacStart ? (() => { const d = fromISODate(vacStart); return d ? formatDisplayDate(d) : vacStart; })() : 'Select date'}
              </Text>
            </Pressable>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.inputLabel}>To</Text>
            <Pressable style={fi.input} onPress={() => setShowVacPicker(true)}>
              <Text style={vacEnd ? fi.inputText : fi.inputPlaceholder}>
                {vacEnd ? (() => { const d = fromISODate(vacEnd); return d ? formatDisplayDate(d) : vacEnd; })() : 'Select date'}
              </Text>
            </Pressable>
          </View>
        </View>
        {(vacStart || vacEnd) ? (
          <Pressable
            onPress={() => { setVacStart(''); setVacEnd(''); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ alignSelf: 'flex-start', marginTop: space.sm }}
          >
            <Text style={{ ...t.small, color: color.signal, fontWeight: '600' }}>Clear blocked dates</Text>
          </Pressable>
        ) : null}
        <GlobalCalendarPicker
          visible={showVacPicker}
          mode="range"
          value={{ start: vacStart || null, end: vacEnd || null }}
          title="Blocked dates"
          onConfirm={({ start, end }) => {
            setVacStart(start ?? '');
            setVacEnd(end ?? '');
            setShowVacPicker(false);
          }}
          onCancel={() => setShowVacPicker(false)}
        />
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
  blockSub: { fontFamily: 'Courier', fontSize: 8, color: color.haze, letterSpacing: 0.3 },
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
  inputPlaceholder: { ...t.body, color: color.haze },
});
