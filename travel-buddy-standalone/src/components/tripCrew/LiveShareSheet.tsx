/**
 * LiveShareSheet — bottom sheet for starting a temporary live location share
 * with selected trip crew members. Duration options: 15m / 30m / 1h / plan_end.
 * Visibility is capped at "neighborhood" by default (never exact).
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Modal, ActivityIndicator, Switch,
} from 'react-native';
import { X, Navigation, Clock } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import type { CrewMemberCard, ShareDuration } from '../../services/tripCrewLocation';
import { startLiveShare } from '../../services/tripCrewLocation';

interface Props {
  visible: boolean;
  tripId: string;
  members: CrewMemberCard[];
  onDismiss: () => void;
  onStarted: (expiresAt: string) => void;
}

const DURATIONS: { value: ShareDuration; label: string }[] = [
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: 'plan_end', label: 'Until plan ends' },
];

const VISIBILITY_OPTIONS = [
  { value: 'city_only' as const, label: 'City only' },
  { value: 'neighborhood' as const, label: 'Neighborhood' },
  { value: 'nearby' as const, label: 'Nearby (approx.)' },
];

export function LiveShareSheet({ visible, tripId, members, onDismiss, onStarted }: Props) {
  const [duration, setDuration] = useState<ShareDuration>('30m');
  const [visibility, setVisibility] = useState<'city_only' | 'neighborhood' | 'nearby'>('neighborhood');
  const [shareWithAll, setShareWithAll] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleMembers = members.filter((m) => !m.ghostMode && m.statusLabel !== 'location_hidden');

  async function handleStart() {
    const allowedIds = shareWithAll
      ? eligibleMembers.map((m) => m.userId)
      : eligibleMembers.map((m) => m.userId); // simplified: always all for now

    if (allowedIds.length === 0) {
      setError('No crew members to share with');
      return;
    }

    setLoading(true);
    setError(null);
    const result = await startLiveShare(tripId, {
      duration,
      visibilityLevel: visibility,
      allowedMemberIds: allowedIds,
    });
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    onStarted(result.data.expiresAt);
    onDismiss();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <Pressable style={s.overlay} onPress={onDismiss} />
      <View style={s.sheet}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.head}>
          <Navigation size={18} color={color.signal} />
          <Text style={s.title}>Share location temporarily</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onDismiss} hitSlop={8}><X size={20} color={color.ink} /></Pressable>
        </View>

        <Text style={s.note}>
          Your approximate location will be shared with crew members for the chosen duration.
          Exact coordinates are never shared.
        </Text>

        {/* Duration picker */}
        <Text style={s.sectionLabel}>DURATION</Text>
        <View style={s.options}>
          {DURATIONS.map((d) => (
            <Pressable
              key={d.value}
              style={[s.option, duration === d.value && s.optionActive]}
              onPress={() => setDuration(d.value)}
            >
              <Clock size={13} color={duration === d.value ? color.onInk : color.ink} />
              <Text style={[s.optionText, duration === d.value && s.optionTextActive]}>
                {d.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Visibility picker */}
        <Text style={s.sectionLabel}>PRECISION</Text>
        <View style={s.options}>
          {VISIBILITY_OPTIONS.map((v) => (
            <Pressable
              key={v.value}
              style={[s.option, visibility === v.value && s.optionActive]}
              onPress={() => setVisibility(v.value)}
            >
              <Text style={[s.optionText, visibility === v.value && s.optionTextActive]}>
                {v.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Share with all toggle */}
        <View style={s.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>Share with all {eligibleMembers.length} crew members</Text>
            <Text style={s.toggleSub}>You can manage individual access in settings</Text>
          </View>
          <Switch
            value={shareWithAll}
            onValueChange={setShareWithAll}
            trackColor={{ true: color.signal }}
          />
        </View>

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable style={[s.cta, loading && s.ctaDisabled]} onPress={handleStart} disabled={loading}>
          {loading ? (
            <ActivityIndicator color={color.onInk} />
          ) : (
            <>
              <Navigation size={16} color={color.onInk} />
              <Text style={s.ctaText}>Start sharing</Text>
            </>
          )}
        </Pressable>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 34,
    paddingTop: space.sm,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  note: { ...t.small, color: color.mute, lineHeight: 18, marginBottom: space.md },
  sectionLabel: {
    ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10,
    letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: space.sm, marginTop: space.sm,
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paper,
  },
  optionActive: { backgroundColor: color.signal, borderColor: color.signal },
  optionText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  optionTextActive: { color: color.onInk },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze,
    marginTop: space.sm,
  },
  toggleLabel: { ...t.small, fontWeight: '600', color: color.ink },
  toggleSub: { ...t.small, color: color.mute, fontSize: 11, marginTop: 2 },
  error: { ...t.small, color: '#DC2626', marginBottom: space.sm },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 14, marginTop: space.md,
  },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { ...t.bodyStrong, color: color.onInk },
});
