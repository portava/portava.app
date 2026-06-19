import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Modal, StyleSheet } from 'react-native';
import { X } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { Chip, Stamp } from '../src/components/ui';
import { StampBadge } from '../src/components/PassportStamps';
import { motifFor } from '../src/lib/stampMotif';
import { usePassport } from '../src/hooks/usePassport';
import type { PassportStamp, StampKind } from '../src/types/models';
import { color, space, radius, type as t } from '../src/theme/tokens';

const FILTERS: { label: string; kind?: StampKind }[] = [
  { label: 'All' },
  { label: 'Cities', kind: 'city' },
  { label: 'Plans', kind: 'plan' },
  { label: 'Gems', kind: 'gem' },
  { label: 'Trust', kind: 'safe' },
  { label: 'Hosted', kind: 'host' },
  { label: 'Perks', kind: 'perk' },
];

const REASON: Record<StampKind, string> = {
  city: 'Visited and checked in to this city.',
  plan: 'Joined a travel plan with other buddies.',
  gem: 'Discovered and shared a hidden gem.',
  safe: 'Completed a verified safe meetup.',
  host: 'Hosted an experience for other travelers.',
  perk: 'Unlocked a Travel Buddy perk.',
};

export default function StampsPage() {
  const { data } = usePassport();
  const [filter, setFilter] = useState('All');
  const [selected, setSelected] = useState<PassportStamp | null>(null);
  const stamps = data?.stamps ?? [];
  const active = FILTERS.find((f) => f.label === filter);
  const shown = active?.kind ? stamps.filter((s) => s.kind === active.kind) : stamps;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Passport Stamps" back />
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: space.sm, padding: space.lg }}
      >
        {FILTERS.map((f) => (
          <Chip key={f.label} label={f.label} active={f.label === filter} onPress={() => setFilter(f.label)} />
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={styles.grid}>
        {shown.map((s, i) => (
          <View key={s.id} style={styles.cell}>
            <StampBadge stamp={s} size={96} rotate={((i % 3) - 1) * 4} onPress={() => setSelected(s)} />
            <Text style={styles.cellName} numberOfLines={1}>{s.label}</Text>
            {s.locked ? <Text style={styles.cellLocked}>Locked</Text> : null}
          </View>
        ))}
        {shown.length === 0 && (
          <View style={styles.empty}><Text style={styles.emptyText}>No stamps in this category yet.</Text></View>
        )}
      </ScrollView>

      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSelected(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Pressable style={styles.close} onPress={() => setSelected(null)} hitSlop={8}>
              <X size={20} color={color.ink} />
            </Pressable>
            {selected && (
              <View style={{ alignItems: 'center', gap: space.md }}>
                <StampBadge stamp={selected} size={120} />
                <Text style={styles.detailName}>{selected.label}</Text>
                <View style={styles.detailStamps}>
                  <Stamp label={selected.kind} tone="deep" />
                  {selected.sublabel ? <Stamp label={selected.sublabel} rotate={2} /> : null}
                  <Stamp label={selected.locked ? 'locked' : 'earned'} tone={selected.locked ? 'ink' : 'signal'} rotate={-2} />
                </View>
                <Text style={styles.detailReason}>{REASON[selected.kind]}</Text>
                {motifFor(selected).provisional && (
                  <Text style={styles.provisional}>ⓘ Starter city notes — provisional, not verified</Text>
                )}
                {!selected.locked && selected.earnedAt ? (
                  <Text style={styles.detailDate}>Earned {new Date(selected.earnedAt).toLocaleDateString()}</Text>
                ) : (
                  <Text style={styles.detailDate}>Not earned yet</Text>
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', padding: space.lg, paddingTop: 0, rowGap: space.xl },
  cell: { width: '30%', alignItems: 'center', gap: 6 },
  cellName: { ...t.small, color: color.ink, fontWeight: '600' },
  cellLocked: { ...t.stamp, fontFamily: 'Courier', color: color.faint },
  empty: { width: '100%', padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute },

  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.55)', alignItems: 'center', justifyContent: 'center', padding: space.xl },
  sheet: { width: '100%', maxWidth: 360, backgroundColor: color.paper, borderRadius: radius.lg, padding: space.xl },
  close: { position: 'absolute', right: space.md, top: space.md, zIndex: 2 },
  detailName: { ...t.title, color: color.ink },
  detailStamps: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', justifyContent: 'center' },
  detailReason: { ...t.body, color: color.mute, textAlign: 'center' },
  provisional: { ...t.small, color: color.faint, fontFamily: 'Courier', textAlign: 'center', fontSize: 11 },
  detailDate: { ...t.small, color: color.faint, fontFamily: 'Courier' },
});
