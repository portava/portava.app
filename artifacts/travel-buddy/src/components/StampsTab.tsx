import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import type { PassportStamp } from '../types/models';
import type { PassportStampNew, StampVisibility } from '../services/passportStamps';
import { getMyPassportStamps, updateStampVisibility } from '../services/passportStamps';
import { StampArtwork } from './StampArtwork';
import { color, space, radius, type as t } from '../theme/tokens';

const STAMP_TYPES = [
  { key: '', label: 'All' },
  { key: 'city', label: '🏙 City' },
  { key: 'neighborhood', label: '📍 Area' },
  { key: 'plan', label: '📅 Plan' },
  { key: 'host', label: '🏠 Host' },
  { key: 'hidden_gem', label: '💎 Gem' },
  { key: 'safe_return', label: '🛡 Safe' },
  { key: 'trip_crew', label: '👥 Crew' },
];

function stampLabel(s: PassportStampNew): string {
  return s.city ?? s.country ?? s.stampType.replace('_', ' ').toUpperCase();
}

function stampSublabel(s: PassportStampNew): string | undefined {
  const parts: string[] = [];
  if (s.country && s.city) parts.push(s.country);
  if (s.earnedAt) parts.push(new Date(s.earnedAt).getFullYear().toString());
  return parts.length ? parts.join(' · ') : undefined;
}

function toLegacyStamp(s: PassportStampNew): PassportStamp {
  return {
    id: s.id,
    kind: (s.stampType === 'city' ? 'city' : s.stampType === 'plan' ? 'plan' : s.stampType === 'hidden_gem' ? 'gem' : s.stampType === 'safe_return' ? 'safe' : s.stampType === 'host' ? 'host' : 'city') as any,
    label: stampLabel(s),
    sublabel: stampSublabel(s),
    earnedAt: s.earnedAt,
    locked: false,
  };
}

interface StampsTabProps {
  /** Legacy stamps passed from usePassport (fallback when API unavailable) */
  stamps: PassportStamp[];
}

export function StampsTab({ stamps: legacyStamps }: StampsTabProps) {
  const [liveStamps, setLiveStamps] = useState<PassportStampNew[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('');
  const [filterCountry, setFilterCountry] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyPassportStamps(
      filterType || filterCountry
        ? { type: filterType || undefined, country: filterCountry || undefined }
        : undefined,
    );
    setLoading(false);
    if (res.ok) setLiveStamps(res.data);
  }, [filterType, filterCountry]);

  useEffect(() => {
    load();
  }, [load]);

  // Compute unique countries for filter bar
  const countries = [...new Set(liveStamps.map((s) => s.country).filter(Boolean) as string[])].sort();

  // Display stamps: prefer live API data, fall back to legacy
  const displayStamps: PassportStamp[] = liveStamps.length > 0
    ? liveStamps.map(toLegacyStamp)
    : legacyStamps.filter((s) => !s.locked);

  return (
    <View style={st.wrap}>
      {/* Type filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={st.filterStrip}
      >
        {STAMP_TYPES.map((f) => (
          <Pressable
            key={f.key}
            style={[st.filterChip, filterType === f.key && st.filterChipActive]}
            onPress={() => setFilterType(f.key)}
          >
            <Text style={[st.filterChipText, filterType === f.key && st.filterChipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Country filter (shown only when countries exist) */}
      {countries.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={st.countryStrip}
        >
          <Pressable
            style={[st.countryChip, filterCountry === '' && st.countryChipActive]}
            onPress={() => setFilterCountry('')}
          >
            <Text style={[st.countryChipText, filterCountry === '' && st.countryChipTextActive]}>All countries</Text>
          </Pressable>
          {countries.map((c) => (
            <Pressable
              key={c}
              style={[st.countryChip, filterCountry === c && st.countryChipActive]}
              onPress={() => setFilterCountry(c)}
            >
              <Text style={[st.countryChipText, filterCountry === c && st.countryChipTextActive]}>{c}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {loading && liveStamps.length === 0 ? (
        <View style={st.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : displayStamps.length === 0 ? (
        <View style={st.empty}>
          <Text style={st.emptyIcon}>🔖</Text>
          <Text style={st.emptyTitle}>
            {filterType || filterCountry ? 'No stamps match this filter' : 'No verified stamps yet'}
          </Text>
          <Text style={st.emptySub}>
            {filterType || filterCountry
              ? 'Try changing the filter above.'
              : 'GPS-verified check-ins, plan attendance, and Safe Return completions can earn stamps.'}
          </Text>
        </View>
      ) : (
        <View style={st.grid}>
          {displayStamps.map((s, i) => (
            <View key={s.id} style={st.cell}>
              <StampArtwork stamp={s} size={80} rotate={((i % 3) - 1) * 4} onPress={() => router.push('/stamps')} />
            </View>
          ))}
        </View>
      )}

      {displayStamps.length > 0 && (
        <Pressable style={st.viewAll} onPress={() => router.push('/stamps')}>
          <Text style={st.viewAllText}>View full stamp collection</Text>
        </Pressable>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  filterStrip: { gap: space.xs, paddingBottom: space.sm, paddingRight: space.md },
  filterChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  filterChipActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  filterChipText: { ...t.small, color: color.mute, fontWeight: '600' },
  filterChipTextActive: { color: color.signal },
  countryStrip: { gap: space.xs, paddingBottom: space.sm, paddingRight: space.md },
  countryChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  countryChipActive: { borderColor: color.deep, backgroundColor: color.deep },
  countryChipText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 11 },
  countryChipTextActive: { color: '#fff' },
  center: { paddingTop: space.xxxl, alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, justifyContent: 'flex-start', paddingTop: space.sm },
  cell: { alignItems: 'center' },
  viewAll: {
    marginTop: space.xl, alignItems: 'center', borderWidth: 1,
    borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.md,
  },
  viewAllText: { ...t.bodyStrong, color: color.ink },
  empty: { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center' },
});
