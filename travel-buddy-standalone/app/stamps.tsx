import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Modal, StyleSheet, ActivityIndicator } from 'react-native';
import { X } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { PulseFilterRail } from '../src/components/PulseFilterRail';
import { StampArtwork } from '../src/components/StampArtwork';
import { getMyPassportStamps, updateStampVisibility } from '../src/services/passportStamps';
import type { PassportStampNew, StampVisibility } from '../src/services/passportStamps';
import type { PassportStamp } from '../src/types/models';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { NavBarFiller, useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';

const FILTERS: { label: string; kind?: string }[] = [
  { label: 'All' },
  { label: 'Cities',       kind: 'city' },
  { label: 'Areas',        kind: 'neighborhood' },
  { label: 'Plans',        kind: 'plan' },
  { label: 'Hosted',       kind: 'host' },
  { label: 'Gems',         kind: 'hidden_gem' },
  { label: 'Safe Return',  kind: 'safe_return' },
  { label: 'Crew',         kind: 'trip_crew' },
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

function toLegacy(s: PassportStampNew): PassportStamp {
  const label = s.titleOverride ?? s.definition?.name ?? s.city ?? s.country ?? s.stampType;
  const kind = (
    s.stampType === 'city' ? 'city'
    : s.stampType === 'plan' ? 'plan'
    : s.stampType === 'hidden_gem' ? 'gem'
    : s.stampType === 'safe_return' ? 'safe'
    : s.stampType === 'host' ? 'host'
    : 'city'
  ) as any;
  const sub: string[] = [];
  if (s.country && s.city) sub.push(s.country);
  if (s.earnedAt) sub.push(new Date(s.earnedAt).getFullYear().toString());
  return { id: s.id, kind, label, sublabel: sub.join(' · ') || undefined, earnedAt: s.earnedAt, locked: s.isRevoked };
}

export default function StampsPage() {
  const [stamps, setStamps]       = useState<PassportStampNew[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState('All');
  const [selected, setSelected]   = useState<PassportStampNew | null>(null);
  const [visUpdating, setVisUpdating] = useState(false);

  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyPassportStamps();
    setLoading(false);
    if (res.ok) setStamps(res.data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const active = FILTERS.find((f) => f.label === filter);
  const shown = active?.kind
    ? stamps.filter((s) => s.stampType === active.kind)
    : stamps;

  async function handleVisChange(stampId: string, vis: StampVisibility) {
    setVisUpdating(true);
    const res = await updateStampVisibility(stampId, vis);
    setVisUpdating(false);
    if (res.ok) {
      setStamps((prev) => prev.map((s) => s.id === stampId ? { ...s, visibility: vis } : s));
      setSelected((prev) => prev?.id === stampId ? { ...prev, visibility: vis } : prev);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Passport Stamps" back />

      <PulseFilterRail
        filters={FILTERS.map((f) => f.label)}
        active={[filter]}
        onPress={(label) => setFilter(label)}
      />

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.grid} onScroll={navBarScrollHandler} scrollEventThrottle={16}>
          {shown.map((s, i) => {
            const leg = toLegacy(s);
            return (
              <View key={s.id} style={styles.cell}>
                <StampArtwork stamp={leg} size={96} rotate={((i % 3) - 1) * 4} onPress={() => setSelected(s)} />
                <Text style={styles.cellName} numberOfLines={1}>{leg.label}</Text>
                {leg.sublabel ? <Text style={styles.cellSub} numberOfLines={1}>{leg.sublabel}</Text> : null}
                {s.isRevoked ? <Text style={styles.revokedTag}>revoked</Text> : null}
              </View>
            );
          })}
          {shown.length === 0 && (
            <View style={styles.empty}><Text style={styles.emptyText}>No stamps in this category yet.</Text></View>
          )}
          <NavBarFiller />
        </ScrollView>
      )}

      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSelected(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Pressable style={styles.close} onPress={() => setSelected(null)} hitSlop={8}>
              <X size={20} color={color.ink} />
            </Pressable>
            {selected && (
              <View style={{ gap: space.md }}>
                {/* Name + rarity */}
                <View style={{ alignItems: 'center', gap: space.xs }}>
                  <Text style={styles.detailName}>
                    {selected.titleOverride ?? selected.definition?.name ?? toLegacy(selected).label}
                  </Text>
                  {selected.definition?.rarity && (
                    <View style={[styles.rarityBadge, { backgroundColor: (RARITY_COLORS[selected.definition.rarity] ?? '#6B7280') + '25' }]}>
                      <Text style={[styles.rarityText, { color: RARITY_COLORS[selected.definition.rarity] ?? '#6B7280' }]}>
                        {selected.definition.rarity.toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Location */}
                {(selected.city || selected.country) && (
                  <View style={styles.row}>
                    <Text style={styles.rowKey}>Location</Text>
                    <Text style={styles.rowVal}>{[selected.city, selected.country].filter(Boolean).join(', ')}</Text>
                  </View>
                )}

                {/* How earned */}
                <View style={styles.row}>
                  <Text style={styles.rowKey}>How earned</Text>
                  <Text style={styles.rowVal}>
                    {SOURCE_LABELS[selected.sourceType] ?? selected.sourceType.replace(/_/g, ' ')}
                  </Text>
                </View>

                {/* Earned date */}
                <View style={styles.row}>
                  <Text style={styles.rowKey}>Earned</Text>
                  <Text style={styles.rowVal}>
                    {new Date(selected.earnedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                  </Text>
                </View>

                {/* Description */}
                {selected.definition?.description ? (
                  <Text style={styles.desc}>{selected.definition.description}</Text>
                ) : null}

                {/* Revoked notice */}
                {selected.isRevoked && (
                  <View style={styles.revokedBanner}>
                    <Text style={styles.revokedBannerText}>This stamp has been revoked.</Text>
                  </View>
                )}

                {/* Visibility */}
                {!selected.isRevoked && (
                  <>
                    <Text style={styles.rowKey}>Visibility</Text>
                    <View style={styles.visRow}>
                      {(['public', 'circle_only', 'private'] as StampVisibility[]).map((v) => (
                        <Pressable
                          key={v}
                          style={[styles.visBtn, selected.visibility === v && styles.visBtnActive]}
                          onPress={() => handleVisChange(selected.id, v)}
                          disabled={visUpdating}
                        >
                          <Text style={[styles.visBtnText, selected.visibility === v && styles.visBtnTextActive]}>
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

const styles = StyleSheet.create({
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  grid:        { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', padding: space.lg, paddingTop: 0, rowGap: space.xl },
  cell:        { width: '30%', alignItems: 'center', gap: 4 },
  cellName:    { ...t.small, color: color.ink, fontWeight: '600', textAlign: 'center' },
  cellSub:     { ...t.small, color: color.faint, fontSize: 10, textAlign: 'center' },
  revokedTag:  { ...t.small, color: '#DC2626', fontFamily: 'Courier', fontSize: 10 },
  empty:       { width: '100%', padding: space.xl, alignItems: 'center' },
  emptyText:   { ...t.body, color: color.mute },
  backdrop:    { flex: 1, backgroundColor: 'rgba(17,17,15,0.55)', alignItems: 'center', justifyContent: 'center', padding: space.xl },
  sheet:       { width: '100%', maxWidth: 360, backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.xl },
  close:       { position: 'absolute', right: space.md, top: space.md, zIndex: 2 },
  detailName:  { ...t.title, color: color.ink, fontWeight: '800', textAlign: 'center' },
  rarityBadge: { alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  rarityText:  { ...t.small, fontWeight: '700', letterSpacing: 0.5 },
  row:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm },
  rowKey:      { ...t.small, color: color.mute, fontWeight: '600', flex: 1 },
  rowVal:      { ...t.small, color: color.ink, fontWeight: '500', flex: 2, textAlign: 'right' },
  desc:        { ...t.body, color: color.mute, textAlign: 'center', fontStyle: 'italic' },
  revokedBanner:     { backgroundColor: '#FEE2E2', borderRadius: radius.md, padding: space.sm, alignItems: 'center' },
  revokedBannerText: { ...t.small, color: '#DC2626', fontWeight: '600' },
  visRow:      { flexDirection: 'row', gap: space.sm },
  visBtn:      { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  visBtnActive:     { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visBtnText:       { ...t.small, color: color.mute, fontWeight: '600' },
  visBtnTextActive: { color: color.signal },
});
