import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Modal } from 'react-native';
import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import type { PassportStamp } from '../types/models';
import type { PassportStampNew, StampVisibility } from '../services/passportStamps';
import { getMyPassportStamps, getUserStampsByUsername, updateStampVisibility } from '../services/passportStamps';
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

const RARITY_COLORS: Record<string, string> = {
  common:    '#6B7280',
  uncommon:  '#16A34A',
  rare:      '#2563EB',
  epic:      '#7C3AED',
  legendary: '#D97706',
};

const SOURCE_LABELS: Record<string, string> = {
  trip:        'Completed a trip',
  plan:        'Joined a travel plan',
  host:        'Hosted an experience',
  safe_return: 'Completed a verified safe meetup',
  hidden_gem:  'Discovered a hidden gem',
  check_in:    'GPS-verified check-in',
  system:      'Awarded by Travel Buddy',
  manual:      'Manually awarded',
  event:       'Attended an event',
};

function stampLabel(s: PassportStampNew): string {
  if (s.titleOverride) return s.titleOverride;
  if (s.definition?.name) return s.definition.name;
  return s.city ?? s.country ?? s.stampType.replace(/_/g, ' ').toUpperCase();
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
    kind: (s.stampType === 'city' ? 'city'
         : s.stampType === 'plan' ? 'plan'
         : s.stampType === 'hidden_gem' ? 'gem'
         : s.stampType === 'safe_return' ? 'safe'
         : s.stampType === 'host' ? 'host'
         : 'city') as any,
    label: stampLabel(s),
    sublabel: stampSublabel(s),
    earnedAt: s.earnedAt,
    locked: s.isRevoked,
  };
}

interface StampsTabProps {
  stamps: PassportStamp[];
  viewingUsername?: string;
  isOwner?: boolean;
}

export function StampsTab({ stamps: legacyStamps, viewingUsername, isOwner = false }: StampsTabProps) {
  const [liveStamps, setLiveStamps]     = useState<PassportStampNew[]>([]);
  const [loading, setLoading]           = useState(true);
  const [filterType, setFilterType]     = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [selected, setSelected]         = useState<PassportStampNew | null>(null);
  const [visUpdating, setVisUpdating]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = viewingUsername
      ? await getUserStampsByUsername(viewingUsername)
      : await getMyPassportStamps(
          filterType || filterCountry
            ? { type: filterType || undefined, country: filterCountry || undefined }
            : undefined,
        );
    setLoading(false);
    if (res.ok) setLiveStamps(res.data);
  }, [filterType, filterCountry, viewingUsername]);

  useEffect(() => { load(); }, [load]);

  const countries = [...new Set(liveStamps.map((s) => s.country).filter(Boolean) as string[])].sort();

  const filtered = liveStamps.filter((s) => {
    if (filterType && s.stampType !== filterType) return false;
    if (filterCountry && s.country !== filterCountry) return false;
    return true;
  });

  const displayStamps: PassportStamp[] =
    liveStamps.length > 0 ? filtered.map(toLegacyStamp) : legacyStamps.filter((s) => !s.locked);

  async function handleVisChange(stampId: string, vis: StampVisibility) {
    setVisUpdating(true);
    const res = await updateStampVisibility(stampId, vis);
    setVisUpdating(false);
    if (res.ok) {
      setLiveStamps((prev) => prev.map((s) => s.id === stampId ? { ...s, visibility: vis } : s));
      setSelected((prev) => prev?.id === stampId ? { ...prev, visibility: vis } : prev);
    }
  }

  return (
    <View style={st.wrap}>
      {!viewingUsername && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.filterStrip}>
          {STAMP_TYPES.map((f) => (
            <Pressable
              key={f.key}
              style={[st.filterChip, filterType === f.key && st.filterChipActive]}
              onPress={() => setFilterType(f.key)}
            >
              <Text style={[st.filterChipText, filterType === f.key && st.filterChipTextActive]}>{f.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {countries.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.countryStrip}>
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
        <View style={st.center}><ActivityIndicator color={color.signal} /></View>
      ) : displayStamps.length === 0 ? (
        <View style={st.empty}>
          <Text style={st.emptyIcon}>🔖</Text>
          <Text style={st.emptyTitle}>
            {filterType || filterCountry
              ? 'No stamps match this filter'
              : viewingUsername ? 'No public stamps yet' : 'No stamps yet'}
          </Text>
          <Text style={st.emptySub}>
            {filterType || filterCountry
              ? 'Try changing the filter above.'
              : viewingUsername
                ? `@${viewingUsername} hasn't earned any public stamps yet.`
                : 'GPS-verified check-ins, plan attendance, and Safe Return completions can earn stamps.'}
          </Text>
        </View>
      ) : (
        <View style={st.grid}>
          {displayStamps.map((s, i) => {
            const rich = liveStamps.find((r) => r.id === s.id);
            return (
              <View key={s.id} style={st.cell}>
                <StampArtwork
                  stamp={s}
                  size={80}
                  rotate={((i % 3) - 1) * 4}
                  onPress={() => rich ? setSelected(rich) : (!viewingUsername && router.push('/stamps'))}
                />
                <Text style={st.cellLabel} numberOfLines={1}>{s.label}</Text>
                {s.sublabel ? <Text style={st.cellSublabel} numberOfLines={1}>{s.sublabel}</Text> : null}
              </View>
            );
          })}
        </View>
      )}

      {!viewingUsername && displayStamps.length > 0 && (
        <Pressable style={st.viewAll} onPress={() => router.push('/stamps')}>
          <Text style={st.viewAllText}>View full stamp collection</Text>
        </Pressable>
      )}

      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <Pressable style={st.backdrop} onPress={() => setSelected(null)}>
          <Pressable style={st.sheet} onPress={(e) => e.stopPropagation()}>
            <Pressable style={st.closeBtn} onPress={() => setSelected(null)} hitSlop={8}>
              <X size={20} color={color.ink} />
            </Pressable>
            {selected && (
              <View style={{ gap: space.md }}>
                <View style={{ alignItems: 'center', gap: space.xs }}>
                  <Text style={st.detailName} numberOfLines={2}>
                    {selected.titleOverride ?? selected.definition?.name ?? stampLabel(selected)}
                  </Text>
                  {selected.definition?.rarity && (
                    <View style={[st.rarityBadge, { backgroundColor: (RARITY_COLORS[selected.definition.rarity] ?? '#6B7280') + '25' }]}>
                      <Text style={[st.rarityText, { color: RARITY_COLORS[selected.definition.rarity] ?? '#6B7280' }]}>
                        {selected.definition.rarity.toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>

                {(selected.city || selected.country) && (
                  <View style={st.detailRow}>
                    <Text style={st.detailKey}>Location</Text>
                    <Text style={st.detailVal}>{[selected.city, selected.country].filter(Boolean).join(', ')}</Text>
                  </View>
                )}

                <View style={st.detailRow}>
                  <Text style={st.detailKey}>How earned</Text>
                  <Text style={st.detailVal}>
                    {SOURCE_LABELS[selected.sourceType] ?? selected.sourceType.replace(/_/g, ' ')}
                  </Text>
                </View>

                <View style={st.detailRow}>
                  <Text style={st.detailKey}>Earned</Text>
                  <Text style={st.detailVal}>
                    {new Date(selected.earnedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                  </Text>
                </View>

                {selected.definition?.description ? (
                  <Text style={st.detailDesc}>{selected.definition.description}</Text>
                ) : null}

                {selected.isRevoked && (
                  <View style={st.revokedBanner}>
                    <Text style={st.revokedText}>This stamp has been revoked.</Text>
                  </View>
                )}

                {isOwner && !selected.isRevoked && (
                  <>
                    <Text style={st.detailKey}>Visibility</Text>
                    <View style={st.visRow}>
                      {(['public', 'circle_only', 'private'] as StampVisibility[]).map((v) => (
                        <Pressable
                          key={v}
                          style={[st.visBtn, selected.visibility === v && st.visBtnActive]}
                          onPress={() => handleVisChange(selected.id, v)}
                          disabled={visUpdating}
                        >
                          <Text style={[st.visBtnText, selected.visibility === v && st.visBtnTextActive]}>
                            {v === 'circle_only' ? 'Circle' : v.charAt(0).toUpperCase() + v.slice(1)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  wrap:               { paddingHorizontal: space.lg, paddingTop: space.md },
  filterStrip:        { gap: space.xs, paddingBottom: space.sm, paddingRight: space.md },
  filterChip:         { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  filterChipActive:   { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  filterChipText:     { ...t.small, color: color.mute, fontWeight: '600' },
  filterChipTextActive: { color: color.signal },
  countryStrip:       { gap: space.xs, paddingBottom: space.sm, paddingRight: space.md },
  countryChip:        { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  countryChipActive:  { borderColor: color.deep, backgroundColor: color.deep },
  countryChipText:    { ...t.small, color: color.mute, fontWeight: '600', fontSize: 11 },
  countryChipTextActive: { color: '#fff' },
  center:             { paddingTop: space.xxxl, alignItems: 'center' },
  grid:               { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, justifyContent: 'flex-start', paddingTop: space.sm },
  cell:               { alignItems: 'center', width: 80 },
  cellLabel:          { ...t.small, color: color.ink, fontWeight: '600', textAlign: 'center', marginTop: 4 },
  cellSublabel:       { ...t.small, color: color.faint, fontSize: 10, textAlign: 'center' },
  viewAll:            { marginTop: space.xl, alignItems: 'center', borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.md },
  viewAllText:        { ...t.bodyStrong, color: color.ink },
  empty:              { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon:          { fontSize: 48 },
  emptyTitle:         { ...t.heading, color: color.ink },
  emptySub:           { ...t.body, color: color.mute, textAlign: 'center' },
  backdrop:           { flex: 1, backgroundColor: 'rgba(17,17,15,0.55)', alignItems: 'center', justifyContent: 'center', padding: space.xl },
  sheet:              { width: '100%', maxWidth: 360, backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.xl },
  closeBtn:           { position: 'absolute', right: space.md, top: space.md, zIndex: 2 },
  detailName:         { ...t.title, color: color.ink, fontWeight: '800', textAlign: 'center' },
  rarityBadge:        { alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  rarityText:         { ...t.small, fontWeight: '700', letterSpacing: 0.5 },
  detailRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm },
  detailKey:          { ...t.small, color: color.mute, fontWeight: '600', flex: 1 },
  detailVal:          { ...t.small, color: color.ink, fontWeight: '500', flex: 2, textAlign: 'right' },
  detailDesc:         { ...t.body, color: color.mute, textAlign: 'center', fontStyle: 'italic' },
  revokedBanner:      { backgroundColor: '#FEE2E2', borderRadius: radius.md, padding: space.sm, alignItems: 'center' },
  revokedText:        { ...t.small, color: '#DC2626', fontWeight: '600' },
  visRow:             { flexDirection: 'row', gap: space.sm },
  visBtn:             { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  visBtnActive:       { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visBtnText:         { ...t.small, color: color.mute, fontWeight: '600' },
  visBtnTextActive:   { color: color.signal },
});
