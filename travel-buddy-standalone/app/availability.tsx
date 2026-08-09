import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { CalendarClock, Check, Plus, Trash2, MapPin, Sparkles, Zap } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { useAvailabilityStore } from '../src/context/AvailabilityStore';
import { resolveStatus, STATUS_LABEL } from '../src/lib/availability';
import type { Weekday, TimeBlock } from '../src/types/models';
import type { QuickStatus } from '../src/services/availability';
import { color, space, radius, type as t, shadow, layout, avatar, icon } from '../src/theme/tokens';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../src/hooks/useNavBarCollapse';

const DAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
];
const BLOCKS: { key: TimeBlock; label: string; time: string }[] = [
  { key: 'morning', label: 'Morning', time: '08:00–12:00' },
  { key: 'afternoon', label: 'Afternoon', time: '12:00–17:00' },
  { key: 'evening', label: 'Evening', time: '17:00–22:00' },
  { key: 'late', label: 'Late', time: '22:00–02:00' },
];

const PRESETS: { label: string; build: () => Partial<Record<Weekday, TimeBlock[]>> }[] = [
  { label: 'Weeknights', build: () => Object.fromEntries((['mon','tue','wed','thu','fri'] as Weekday[]).map((d) => [d, ['evening'] as TimeBlock[]])) },
  { label: 'Weekends', build: () => ({ sat: ['morning','afternoon','evening','late'], sun: ['morning','afternoon','evening'] }) },
  { label: 'Evenings', build: () => Object.fromEntries(DAYS.map((d) => [d.key, ['evening'] as TimeBlock[]])) },
  { label: 'Late nights', build: () => Object.fromEntries((['fri','sat'] as Weekday[]).map((d) => [d, ['evening','late'] as TimeBlock[]])) },
  { label: 'Flexible', build: () => Object.fromEntries(DAYS.map((d) => [d.key, ['morning','afternoon','evening','late'] as TimeBlock[]])) },
];

const QUICK_PILLS: { key: QuickStatus; label: string; emoji: string }[] = [
  { key: 'free_now',     label: 'Free now',      emoji: '🟢' },
  { key: 'free_tonight', label: 'Free tonight',  emoji: '🌙' },
  { key: 'open_to_plans',label: 'Open to plans', emoji: '✨' },
  { key: 'busy',         label: 'Busy',          emoji: '🔴' },
];

function summarize(days: Partial<Record<Weekday, TimeBlock[]>>): string {
  const active = DAYS.filter((d) => (days[d.key]?.length ?? 0) > 0);
  if (active.length === 0) return 'No weekly availability set yet.';
  const labels = active.map((d) => d.label).join('/');
  const eveningish = active.every((d) => (days[d.key] ?? []).every((b) => b === 'evening' || b === 'late'));
  return `Usually free ${labels}${eveningish ? ' evenings' : ''}.`;
}

export default function AvailabilityScreen() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const {
    availability, toggleBlock, applyWeekly, clearWeekly, setOpenToMeet, removeTripWindow,
    save, saving, saveError, quickStatus, setQuickStatus,
  } = useAvailabilityStore();
  const days = availability.weekly?.days ?? {};
  const [saved, setSaved] = useState(false);
  const [settingQuick, setSettingQuick] = useState<QuickStatus | null>(null);

  const status = resolveStatus(availability, new Date().toISOString(), 'cebu');

  async function onSave() {
    await save();
    if (!saveError) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    }
  }

  async function onQuickPill(key: QuickStatus) {
    setSettingQuick(key);
    await setQuickStatus(key);
    setSettingQuick(null);
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Availability" onBack={router.back} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: space.xxxl }} showsVerticalScrollIndicator={false} onScroll={navBarScrollHandler} scrollEventThrottle={16}>

        {/* Current status */}
        <View style={s.statusCard}>
          <View style={s.statusIcon}><CalendarClock size={20} color={color.deep} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.statusLabel}>Current status</Text>
            <Text style={s.statusValue}>{STATUS_LABEL[status]}</Text>
          </View>
          <Pressable style={[s.toggle, availability.openToMeet && s.toggleOn]} onPress={() => setOpenToMeet(!availability.openToMeet)}>
            <View style={[s.knob, availability.openToMeet && s.knobOn]} />
          </Pressable>
        </View>
        <Text style={s.toggleHint}>{availability.openToMeet ? 'Open to meet — shown on your Passport.' : 'Turn on "Open to meet" to let travelers know you\'re around.'}</Text>

        {/* Quick status pills */}
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.sm }}>
            <Zap size={13} color={color.signal} fill={color.signal} />
            <Text style={s.h2}>Quick status</Text>
          </View>
          <Text style={s.sub}>Tap to set a status that expires automatically.</Text>
          <View style={s.quickRow}>
            {QUICK_PILLS.map((p) => {
              const isActive = quickStatus === p.key;
              const isLoading = settingQuick === p.key;
              return (
                <Pressable
                  key={p.key}
                  style={[s.quickPill, isActive && s.quickPillActive]}
                  onPress={() => onQuickPill(p.key)}
                  disabled={settingQuick !== null}
                >
                  {isLoading
                    ? <ActivityIndicator size="small" color={isActive ? color.onInk : color.signal} />
                    : <Text style={s.quickPillEmoji}>{p.emoji}</Text>
                  }
                  <Text style={[s.quickPillText, isActive && s.quickPillTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Weekly rhythm */}
        <View>
          <Text style={s.h2}>Weekly rhythm</Text>
          <Text style={s.sub}>Tap to mark when you're usually free. Approximate — not exact scheduling.</Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.presets}>
            {PRESETS.map((p) => (
              <Pressable key={p.label} style={s.preset} onPress={() => applyWeekly(p.build())}>
                <Text style={s.presetText}>{p.label}</Text>
              </Pressable>
            ))}
            <Pressable style={[s.preset, s.presetClear]} onPress={clearWeekly}>
              <Text style={[s.presetText, { color: color.signal }]}>Clear</Text>
            </Pressable>
          </ScrollView>

          <View style={s.grid}>
            <View style={s.gridHeadRow}>
              <View style={s.dayCell} />
              {BLOCKS.map((b) => <Text key={b.key} style={s.colHead}>{b.label}</Text>)}
            </View>
            {DAYS.map((d) => (
              <View key={d.key} style={s.gridRow}>
                <Text style={s.dayLabel}>{d.label}</Text>
                {BLOCKS.map((b) => {
                  const on = (days[d.key] ?? []).includes(b.key);
                  return (
                    <Pressable key={b.key} style={[s.cell, on && s.cellOn]} onPress={() => toggleBlock(d.key, b.key)}>
                      {on ? <Check size={14} color={color.onInk} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>

          <View style={s.summaryRow}>
            <Sparkles size={13} color={color.deep} />
            <Text style={s.summary}>{summarize(days)}</Text>
          </View>
          <Text style={s.blockLegend}>{BLOCKS.map((b) => `${b.label} ${b.time}`).join('   ·   ')}</Text>
        </View>

        {/* Trip windows */}
        <View>
          <View style={s.tripHead}>
            <Text style={s.h2}>Trip windows</Text>
            <View style={{ flex: 1 }} />
            <Pressable style={s.addTrip} onPress={() => router.push('/trip/new')}>
              <Plus size={14} color={color.signal} /><Text style={s.addTripText}>Add</Text>
            </Pressable>
          </View>
          <Text style={s.sub}>Availability tied to a trip's city + dates — overrides your weekly rhythm while you're there.</Text>

          {availability.trips.length === 0 ? (
            <View style={s.tripEmpty}>
              <Text style={s.tripEmptyText}>No trip windows yet. Add one when you're planning a trip — e.g. "Cebu, Jun 20–27, evenings."</Text>
            </View>
          ) : (
            <View style={{ gap: space.sm }}>
              {availability.trips.map((w) => (
                <View key={w.id} style={s.tripCard}>
                  <View style={s.tripIcon}><MapPin size={16} color={color.deep} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.tripCity}>{w.citySlug}</Text>
                    <Text style={s.tripMeta}>{(w.startDate ?? '').slice(0, 10)} – {(w.endDate ?? '').slice(0, 10)} · {w.blocks.join(', ') || 'flexible'}</Text>
                  </View>
                  <Pressable hitSlop={layout.hitSlop} onPress={() => removeTripWindow(w.id)}><Trash2 size={17} color={color.mute} /></Pressable>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Save */}
        {saveError ? <Text style={s.errorText}>{saveError}</Text> : null}
        <View style={s.saveRow}>
          <Pressable style={s.cancel} onPress={() => router.back()}><Text style={s.cancelText}>Cancel</Text></Pressable>
          <Pressable style={[s.save, saving && { opacity: 0.6 }]} onPress={onSave} disabled={saving}>
            {saving
              ? <ActivityIndicator size="small" color={color.onInk} />
              : saved ? <Check size={16} color={color.onInk} /> : null
            }
            <Text style={s.saveText}>{saved ? 'Saved!' : 'Save'}</Text>
          </Pressable>
        </View>
        <NavBarFiller />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, ...shadow.card },
  statusIcon: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  statusLabel: { ...t.small, color: color.mute, fontSize: 11 },
  statusValue: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  toggle: { width: 48, height: 28, borderRadius: 14, backgroundColor: color.haze, padding: 3, justifyContent: 'center' },
  toggleOn: { backgroundColor: color.signal },
  knob: { width: icon.s22, height: icon.s22, borderRadius: icon.s22 / 2, backgroundColor: color.paperRaised },
  knobOn: { alignSelf: 'flex-end' },
  toggleHint: { ...t.small, color: color.mute, marginTop: -space.md },

  h2: { ...t.title, color: color.ink, fontSize: 18 },
  sub: { ...t.small, color: color.mute, marginTop: 2, marginBottom: space.md },

  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  quickPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm + 2, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, minHeight: 40 },
  quickPillActive: { backgroundColor: color.signal, borderColor: color.signal },
  quickPillEmoji: { fontSize: 14 },
  quickPillText: { ...t.small, fontWeight: '700', color: color.ink },
  quickPillTextActive: { color: color.onInk },

  presets: { gap: space.sm, paddingBottom: space.md },
  preset: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  presetClear: { borderColor: color.signal },
  presetText: { ...t.small, fontWeight: '700', color: color.ink },

  grid: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm, gap: 4 },
  gridHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  colHead: { flex: 1, textAlign: 'center', ...t.small, color: color.mute, fontSize: 10, fontWeight: '700' },
  gridRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dayCell: { width: 38 },
  dayLabel: { width: 38, ...t.small, color: color.ink, fontWeight: '700', fontSize: 12 },
  cell: { flex: 1, height: 38, borderRadius: radius.sm, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  cellOn: { backgroundColor: color.signal, borderColor: color.signal },

  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: space.md },
  summary: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  blockLegend: { ...t.small, color: color.faint, fontSize: 10, marginTop: 4 },

  tripHead: { flexDirection: 'row', alignItems: 'center' },
  addTrip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  addTripText: { ...t.small, fontWeight: '700', color: color.signal },
  tripEmpty: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, borderStyle: 'dashed', padding: space.lg },
  tripEmptyText: { ...t.small, color: color.mute },
  tripCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  tripIcon: { width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  tripCity: { ...t.bodyStrong, color: color.ink, textTransform: 'capitalize' },
  tripMeta: { ...t.small, color: color.mute, fontSize: 11 },

  errorText: { ...t.small, color: '#DC2626', textAlign: 'center' },
  saveRow: { flexDirection: 'row', gap: space.md },
  cancel: { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  cancelText: { ...t.bodyStrong, color: color.ink },
  save: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  saveText: { ...t.bodyStrong, color: color.onInk },
});
