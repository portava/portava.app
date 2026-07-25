/**
 * ExploreTodaySection
 *
 * Renders in place of the "No plans fit your availability" message when the
 * user has no availability blocks set (status === 'not_set').
 *
 * Availability improves personalisation but must not gate Pulse's usefulness.
 * Three inline sections — the outer Pulse FlatList scrolls them all:
 *
 *   1. "Happening Now" horizontal strip — events starting within ±60 min of
 *      the current local time.
 *   2. "Today Around You" time-band picker — Morning / Afternoon / Evening /
 *      Late Night. Default segment = the band the current hour falls in.
 *      Selecting a band swaps the horizontally-scrolling event cards below it.
 *   3. Chronological list — every event today sorted by start time so users
 *      can keep scrolling past the selected band.
 *
 * Privacy rules:
 *   - No traveler precise locations are exposed.
 *   - Uses only city-level CityEvent data from the existing useCityPulse
 *     pipeline. Respects whatever filters the pipeline already applies.
 *   - Degrades gracefully: empty bands show a nudge, not a scolding message.
 *     If the server returns zero events for the whole day, a "Create a plan"
 *     CTA is shown as the absolute last resort.
 */
import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { CalendarDays, Radio } from 'lucide-react-native';
import type { CityEvent } from '../types/models.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { FitsCard } from './PulseFits.tsx';

// ── Types & constants ─────────────────────────────────────────────────────────

type TimeBand = 'morning' | 'afternoon' | 'evening' | 'late';

const BANDS: { key: TimeBand; label: string; sub: string }[] = [
  { key: 'morning',   label: 'Morning',    sub: 'Until noon'  },
  { key: 'afternoon', label: 'Afternoon',  sub: '12 – 5 PM'   },
  { key: 'evening',   label: 'Evening',    sub: '5 – 10 PM'   },
  { key: 'late',      label: 'Late Night', sub: 'After 10 PM' },
];

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Returns the time-band the current local hour falls in. */
function currentBand(): TimeBand {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'late';
}

/**
 * True when an event is active (started up to 1 h ago) OR starting soon
 * (within the next 60 min). Does NOT require a server-side "live" flag.
 */
function isHappeningNow(ev: CityEvent, nowMs: number): boolean {
  if (!ev.startAt) return false;
  const diff = new Date(ev.startAt).getTime() - nowMs;
  return diff >= -60 * 60 * 1000 && diff <= 60 * 60 * 1000;
}

/** "9 AM" / "2:30 PM" from any ISO string, using local time. */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NowChip({ ev }: { ev: CityEvent }) {
  return (
    <Pressable
      style={s.nowChip}
      onPress={() => router.push(`/event/${ev.id}` as any)}
    >
      <View style={s.liveDotSm} />
      <View style={s.nowChipBody}>
        <Text style={s.nowChipTitle} numberOfLines={1}>{ev.title}</Text>
        <Text style={s.nowChipMeta}>
          {fmtTime(ev.startAt)} · {ev.attendeeCount ?? 0} going
        </Text>
      </View>
    </Pressable>
  );
}

function ChronRow({ ev }: { ev: CityEvent }) {
  return (
    <Pressable
      style={s.chronRow}
      onPress={() => router.push(`/event/${ev.id}` as any)}
    >
      <Text style={s.chronTime}>{fmtTime(ev.startAt)}</Text>
      <View style={s.chronDivider} />
      <View style={s.chronBody}>
        <Text style={s.chronTitle} numberOfLines={2}>{ev.title}</Text>
        <Text style={s.chronMeta}>
          {ev.attendeeCount ?? 0} going
          {ev.capacity ? ` · ${ev.capacity} max` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ExploreTodaySection({
  events,
  city,
}: {
  events: CityEvent[];
  city: string;
}) {
  const [band, setBand] = useState<TimeBand>(currentBand);

  const happeningNow = useMemo(() => {
    const nowMs = Date.now();
    return events
      .filter((e) => isHappeningNow(e, nowMs))
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  }, [events]);

  const bandEvents = useMemo(
    () =>
      events
        .filter((e) => e.block === band)
        .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()),
    [events, band],
  );

  const chronEvents = useMemo(
    () =>
      [...events].sort(
        (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
      ),
    [events],
  );

  // ── Absolute fallback — server returned zero events ────────────────────────
  if (events.length === 0) {
    return (
      <View style={s.fallback}>
        <CalendarDays size={28} color={color.mute} />
        <Text style={s.fallbackTitle}>
          Nothing on the calendar{city ? ` in ${city}` : ''} yet
        </Text>
        <Text style={s.fallbackSub}>Be the first — create a plan for today.</Text>
        <Pressable
          style={s.fallbackBtn}
          onPress={() => router.push('/create' as any)}
        >
          <Text style={s.fallbackBtnText}>Create a plan</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.root}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={s.header}>
        <Radio size={15} color={color.signal} />
        <Text style={s.headerTitle}>Explore Today</Text>
        {city ? <Text style={s.headerCity}>in {city}</Text> : null}
      </View>

      {/* ── 1. Happening Now ─────────────────────────────────────────────
           Auto-refreshes on each events re-fetch (useCityPulse TTL timer).
           Hidden when no events fall in the ±60-min window.             */}
      {happeningNow.length > 0 && (
        <View style={s.nowSection}>
          <View style={s.nowLabelRow}>
            <View style={s.liveDot} />
            <Text style={s.nowLabel}>Happening Now</Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.nowStrip}
          >
            {happeningNow.map((ev) => <NowChip key={ev.id} ev={ev} />)}
          </ScrollView>
        </View>
      )}

      {/* ── 2. Today Around You — time-band picker ───────────────────────
           Defaults to the band containing the current local hour.
           Selecting a different band swaps the card row below.          */}
      <View style={s.bandSection}>
        <Text style={s.bandSectionTitle}>Today Around You</Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.bandRow}
        >
          {BANDS.map((b) => {
            const active = band === b.key;
            return (
              <Pressable
                key={b.key}
                style={[s.bandTab, active && s.bandTabActive]}
                onPress={() => setBand(b.key)}
              >
                <Text style={[s.bandTabLabel, active && s.bandTabLabelActive]}>
                  {b.label}
                </Text>
                <Text style={[s.bandTabSub, active && s.bandTabSubActive]}>
                  {b.sub}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Cards for the selected band — reuse the same FitsCard used in the
            availability section so layout and interactions are consistent.  */}
        {bandEvents.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.bandCards}
          >
            {bandEvents.map((ev) => <FitsCard key={ev.id} ev={ev} />)}
          </ScrollView>
        ) : (
          <View style={s.bandEmpty}>
            <Text style={s.bandEmptyText}>
              Nothing in this window — try another band or scroll down to see the full day.
            </Text>
          </View>
        )}
      </View>

      {/* ── 3. Chronological feed ────────────────────────────────────────
           All events today, sorted by start time. Lets users scan the whole
           day without being locked to the selected band.                 */}
      <View style={s.chronSection}>
        <Text style={s.chronSectionTitle}>
          Full Day{city ? ` · ${city}` : ''}
        </Text>
        {chronEvents.map((ev) => <ChronRow key={ev.id} ev={ev} />)}
      </View>

    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, marginTop: space.lg, marginBottom: space.md,
  },
  headerTitle: { ...t.title, color: color.ink, fontSize: 20, flex: 1 },
  headerCity: { ...t.small, color: color.mute },

  // ── Happening Now ──────────────────────────────────────────────────────────
  nowSection: { gap: space.sm, marginBottom: space.md },
  nowLabelRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: 6, paddingHorizontal: space.lg,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  liveDotSm: {
    width: 7, height: 7, borderRadius: 3.5,
    backgroundColor: '#EF4444', flexShrink: 0, marginTop: 3,
  },
  nowLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  nowStrip: { gap: space.sm, paddingHorizontal: space.lg },
  nowChip: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.sm, width: 200,
  },
  nowChipBody: { flex: 1, gap: 3 },
  nowChipTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  nowChipMeta: { ...t.small, color: color.mute, fontSize: 11 },

  // ── Band picker ────────────────────────────────────────────────────────────
  bandSection: { gap: space.sm, marginBottom: space.md },
  bandSectionTitle: {
    ...t.bodyStrong, color: color.ink,
    paddingHorizontal: space.lg, fontSize: 15,
  },
  bandRow: { gap: space.sm, paddingHorizontal: space.lg },
  bandTab: {
    alignItems: 'center', gap: 2, minWidth: 88,
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.paperRaised,
  },
  bandTabActive: { borderColor: color.signal, backgroundColor: color.signal + '12' },
  bandTabLabel: { ...t.bodyStrong, color: color.mute, fontSize: 13 },
  bandTabLabelActive: { color: color.signal },
  bandTabSub: { ...t.small, color: color.faint, fontSize: 10 },
  bandTabSubActive: { color: color.signal + 'bb' },
  bandCards: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  bandEmpty: {
    marginHorizontal: space.lg, padding: space.md,
    borderRadius: radius.md, backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.haze,
  },
  bandEmptyText: { ...t.small, color: color.mute, lineHeight: 18 },

  // ── Chronological feed ─────────────────────────────────────────────────────
  chronSection: {
    paddingHorizontal: space.lg, marginBottom: space.lg,
  },
  chronSectionTitle: {
    ...t.bodyStrong, color: color.ink, fontSize: 15, marginBottom: space.sm,
  },
  chronRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  chronTime: {
    ...t.small, color: color.signal, fontWeight: '700',
    fontSize: 12, width: 58, paddingTop: 2,
  },
  chronDivider: { width: 1, alignSelf: 'stretch', backgroundColor: color.haze },
  chronBody: { flex: 1, gap: 3 },
  chronTitle: { ...t.body, color: color.ink, fontSize: 14, lineHeight: 20 },
  chronMeta: { ...t.small, color: color.mute, fontSize: 11 },

  // ── Fallback (zero events from server) ────────────────────────────────────
  fallback: {
    marginHorizontal: space.lg, marginTop: space.lg, padding: space.xl,
    borderRadius: 16, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, alignItems: 'center', gap: space.md,
  },
  fallbackTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  fallbackSub: { ...t.small, color: color.mute, textAlign: 'center' },
  fallbackBtn: {
    backgroundColor: color.signal, paddingHorizontal: space.lg,
    paddingVertical: 10, borderRadius: 10, marginTop: 4,
  },
  fallbackBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
});
