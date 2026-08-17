/**
 * CrewMapSection
 *
 * Trip Crew location tab rendered inside the Trip detail screen.
 * Shows:
 *  - Approximate density map (View-based bubbles — no external map SDK)
 *  - Scrollable list of CrewMemberCards
 *  - "Share location temporarily" button → LiveShareSheet
 *  - Ghost Mode toggle
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Switch, Alert,
} from 'react-native';
import {
  Navigation, EyeOff, RefreshCw, Users, Info, MapPin,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, icon, dot} from '../../theme/tokens.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { CrewMemberCard } from './CrewMemberCard.tsx';
import { CrewCallCard } from './CrewCallCard.tsx';
import { LiveShareSheet } from './LiveShareSheet.tsx';
import { ArrivalBoard } from './ArrivalBoard.tsx';
import { useTripCrewMap } from '../../hooks/useTripCrewMap.ts';
import { enableGhostMode, disableGhostMode, updateCrewPreferences } from '../../services/tripCrewLocation.ts';
import type { CrewMemberCard as CrewMemberCardType } from '../../services/tripCrewLocation.ts';
import { errorCopy } from '../../lib/errorCopy.ts';

interface Props {
  tripId: string;
  /** Increment to trigger an immediate crew re-fetch (e.g. after sending an invite). */
  refreshKey?: number;
}

// ── Approximate density map (no SDK) ─────────────────────────────────────────

function DensityMap({ members }: { members: CrewMemberCardType[] }) {
  const active = members.filter((m) => m.statusLabel !== 'not_shared' && m.statusLabel !== 'location_hidden');
  const arrived = members.filter((m) => m.statusLabel === 'arrived');
  const live = members.filter((m) => m.statusLabel === 'live_sharing_active');

  return (
    <View style={dm.wrap}>
      {/* Stylised map rings */}
      <View style={dm.map}>
        {/* Outer area ring */}
        <View style={dm.ringOuter} />
        {/* Inner area ring */}
        <View style={dm.ringInner} />
        {/* Center dot (venue/plan) */}
        <View style={dm.center} />

        {/* Density dot: active members */}
        {active.length > 0 && (
          <View style={[dm.clusterDot, { top: '28%', left: '55%', backgroundColor: color.deep }]}>
            <Text style={dm.clusterText}>{active.length}</Text>
          </View>
        )}
        {arrived.length > 0 && (
          <View style={[dm.clusterDot, { top: '47%', left: '46%', backgroundColor: color.success }]}>
            <Text style={dm.clusterText}>{arrived.length}</Text>
          </View>
        )}
        {live.length > 0 && (
          <View style={[dm.clusterDot, { top: '35%', left: '30%', backgroundColor: color.signal }]}>
            <Text style={dm.clusterText}>{live.length}</Text>
          </View>
        )}

        {/* City label */}
        <View style={dm.cityLabel}>
          <Text style={dm.cityText}>Approximate area</Text>
        </View>
      </View>

      {/* Legend */}
      <View style={dm.legend}>
        <View style={dm.legendItem}>
          <View style={[dm.dot, { backgroundColor: color.signal }]} />
          <Text style={dm.legendText}>Live</Text>
        </View>
        <View style={dm.legendItem}>
          <View style={[dm.dot, { backgroundColor: color.success }]} />
          <Text style={dm.legendText}>Arrived</Text>
        </View>
        <View style={dm.legendItem}>
          <View style={[dm.dot, { backgroundColor: color.deep }]} />
          <Text style={dm.legendText}>Nearby</Text>
        </View>
      </View>

      <View style={dm.noteRow}>
        <Info size={11} color={color.mute} />
        <Text style={dm.note}>Approximate areas only — exact locations stay private.</Text>
      </View>
    </View>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

type VisibilityLevel = 'hidden' | 'city_only' | 'neighborhood' | 'nearby' | 'arrived_only';

const VISIBILITY_OPTIONS: { value: VisibilityLevel; label: string; sub: string }[] = [
  { value: 'hidden',       label: 'Hidden',         sub: 'Never shown on crew map' },
  { value: 'city_only',   label: 'City only',       sub: 'Shows city name only' },
  { value: 'neighborhood', label: 'Neighborhood',    sub: 'Shows district or area' },
  { value: 'nearby',       label: 'Nearby',          sub: 'Shows when in the same area' },
  { value: 'arrived_only', label: 'Arrived only',    sub: 'Only shows when checked in' },
];

function VisibilitySelector({
  value,
  onChange,
  saving,
}: {
  value: VisibilityLevel;
  onChange: (v: VisibilityLevel) => void;
  saving: boolean;
}) {
  return (
    <View style={vs.wrap}>
      <Text style={vs.label}>Default visibility</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={vs.row}>
        {VISIBILITY_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            style={[vs.chip, value === opt.value && vs.chipActive]}
            onPress={() => !saving && onChange(opt.value)}
          >
            <Text style={[vs.chipLabel, value === opt.value && vs.chipLabelActive]}>{opt.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={vs.sub}>
        {VISIBILITY_OPTIONS.find((o) => o.value === value)?.sub ?? ''}
      </Text>
    </View>
  );
}

export function CrewMapSection({ tripId, refreshKey = 0 }: Props) {
  const { members, totalCount, featureEnabled, loading, error, refresh } = useTripCrewMap(tripId, refreshKey);
  const { blockedIds, blockerIds } = useBlockedIds();

  function isBlockedMember(userId: string): boolean {
    return blockedIds.has(userId) || blockerIds.has(userId);
  }

  const visibleMembers = members.filter((m) => !isBlockedMember(m.userId));
  const [liveShareOpen, setLiveShareOpen] = useState(false);
  const [ghostMode, setGhostMode] = useState(false);
  const [ghostLoading, setGhostLoading] = useState(false);
  const [visibility, setVisibility] = useState<VisibilityLevel>('city_only');
  const [visibilitySaving, setVisibilitySaving] = useState(false);

  if (!featureEnabled) {
    return (
      <View style={s.disabled}>
        <Text style={s.disabledText}>Crew location coordination is not available for this trip.</Text>
      </View>
    );
  }

  async function toggleGhostMode(value: boolean) {
    setGhostLoading(true);
    const result = value
      ? await enableGhostMode(tripId)
      : await disableGhostMode(tripId);
    setGhostLoading(false);
    if (!result.ok) {
      Alert.alert('Error', errorCopy(result.error, 'Could not update ghost mode'));
      return;
    }
    setGhostMode(value);
  }

  async function handleVisibilityChange(v: VisibilityLevel) {
    setVisibility(v);
    setVisibilitySaving(true);
    const result = await updateCrewPreferences(tripId, { defaultVisibility: v });
    setVisibilitySaving(false);
    if (!result.ok) {
      Alert.alert('Error', errorCopy(result.error, 'Could not update visibility'));
    }
  }

  return (
    <View style={s.wrap}>
      {/* Crew voice room — Start / Join affordance (members only) */}
      <CrewCallCard tripId={tripId} />

      {/* Ghost mode + share controls */}
      <View style={s.controlsCard}>
        <View style={s.controlRow}>
          <View style={s.controlInfo}>
            <EyeOff size={16} color={color.mute} />
            <View>
              <Text style={s.controlLabel}>Ghost Mode</Text>
              <Text style={s.controlSub}>Hide your location from the crew map</Text>
            </View>
          </View>
          {ghostLoading ? (
            <ActivityIndicator size="small" color={color.signal} />
          ) : (
            <Switch
              value={ghostMode}
              onValueChange={toggleGhostMode}
              trackColor={{ true: color.signal }}
            />
          )}
        </View>

        <View style={s.divider} />

        <VisibilitySelector
          value={visibility}
          onChange={handleVisibilityChange}
          saving={visibilitySaving}
        />

        <View style={s.divider} />

        <Pressable style={s.shareBtn} onPress={() => setLiveShareOpen(true)}>
          <Navigation size={15} color={color.signal} />
          <Text style={s.shareBtnText}>Share location temporarily</Text>
        </Pressable>
      </View>

      {/* Density map — blocked members excluded so their location can't be inferred from dot counts */}
      {visibleMembers.length > 0 && <DensityMap members={visibleMembers} />}

      {/* Members list */}
      <View style={s.listCard}>
        <View style={s.listHead}>
          <Users size={15} color={color.ink} />
          <Text style={s.listTitle}>
            {totalCount} crew member{totalCount !== 1 ? 's' : ''}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={refresh} hitSlop={8}>
            <RefreshCw size={15} color={color.mute} />
          </Pressable>
        </View>

        {loading && members.length === 0 ? (
          <View style={s.center}><ActivityIndicator color={color.signal} /></View>
        ) : error ? (
          <Text style={s.errorText}>{error}</Text>
        ) : members.length === 0 ? (
          <View style={s.emptyWrap}>
            <MapPin size={28} color={color.faint} />
            <Text style={s.emptyTitle}>No crew members yet</Text>
            <Text style={s.emptySub}>Invite friends to your trip to see their approximate location here.</Text>
          </View>
        ) : (
          <View>
            {members.map((m) => (
              <CrewMemberCard
                key={m.userId}
                member={m}
                isBlockedByViewer={isBlockedMember(m.userId)}
              />
            ))}
          </View>
        )}
      </View>

      {/* Arrival board — degrades by content; hidden when null or no data */}
      <ArrivalBoard tripId={tripId} members={members} />

      <LiveShareSheet
        visible={liveShareOpen}
        tripId={tripId}
        members={members}
        onDismiss={() => setLiveShareOpen(false)}
        onStarted={() => { refresh(); }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: space.md, padding: space.lg },
  disabled: { padding: space.lg, alignItems: 'center' },
  disabledText: { ...t.body, color: color.mute, textAlign: 'center' },
  controlsCard: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, padding: space.md, ...shadow.card,
  },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  controlInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  controlLabel: { ...t.small, fontWeight: '700', color: color.ink },
  controlSub: { ...t.small, color: color.mute, fontSize: 11 },
  divider: { height: 1, backgroundColor: color.haze, marginVertical: space.md },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.md, paddingVertical: 10,
  },
  shareBtnText: { ...t.small, fontWeight: '800', color: color.signal },
  listCard: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, padding: space.md, ...shadow.card,
  },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md },
  listTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  center: { paddingVertical: space.xl, alignItems: 'center' },
  errorText: { ...t.small, color: '#DC2626' },
  emptyWrap: { alignItems: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
});

const vs = StyleSheet.create({
  wrap: { gap: 6 },
  label: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  row: { gap: space.sm, paddingVertical: 4 },
  chip: {
    paddingHorizontal: space.md, paddingVertical: 6,
    borderRadius: radius.pill, borderWidth: 1,
    borderColor: color.haze, backgroundColor: color.paper,
  },
  chipActive: { borderColor: color.signal, backgroundColor: '#FFF5F5' },
  chipLabel: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 12 },
  chipLabelActive: { color: color.signal, fontWeight: '800' },
  sub: { ...t.small, color: color.mute, fontSize: 11 },
});

/** Concentric visualization rings for the crew density map. Ratio is deliberate — not avatar sizes. */
const CREW_MAP_RING_OUTER = 110;
const CREW_MAP_RING_INNER = 70;

const dm = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card,
  },
  map: { height: 140, backgroundColor: '#DDE6E8', position: 'relative' },
  ringOuter: {
    position: 'absolute', top: '15%', left: '20%',
    width: CREW_MAP_RING_OUTER, height: CREW_MAP_RING_OUTER, borderRadius: CREW_MAP_RING_OUTER / 2,
    borderWidth: 1.5, borderColor: color.deep + '33',
    backgroundColor: color.deep + '08',
  },
  ringInner: {
    position: 'absolute', top: '30%', left: '32%',
    width: CREW_MAP_RING_INNER, height: CREW_MAP_RING_INNER, borderRadius: CREW_MAP_RING_INNER / 2,
    borderWidth: 1.5, borderColor: color.deep + '55',
    backgroundColor: color.deep + '14',
  },
  center: {
    position: 'absolute', top: '45%', left: '47%',
    width: icon.s14, height: icon.s14, borderRadius: icon.s14 / 2,
    backgroundColor: color.signal, borderWidth: 2, borderColor: color.paper,
  },
  clusterDot: {
    position: 'absolute', width: icon.s22, height: icon.s22, borderRadius: icon.s22 / 2,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: color.paper,
  },
  clusterText: { color: color.onInk, fontWeight: '800', fontSize: 10 },
  cityLabel: {
    position: 'absolute', bottom: '10%', left: '5%',
    backgroundColor: 'rgba(255,255,255,0.75)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  cityText: { ...t.small, color: color.ink, fontWeight: '700', fontSize: 10 },
  legend: { flexDirection: 'row', gap: space.lg, padding: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: dot.s10, height: dot.s10, borderRadius: dot.s10 / 2 },
  legendText: { ...t.small, color: color.mute, fontSize: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingBottom: space.md },
  note: { ...t.small, color: color.mute, fontSize: 11 },
});
