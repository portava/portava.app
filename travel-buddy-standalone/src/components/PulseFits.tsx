import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { router } from 'expo-router';
import { MapPin, ChevronRight } from 'lucide-react-native';
import type { CityEvent } from '../types/models.ts';
import { color, space, radius, type as t, shadow, icon } from '../theme/tokens.ts';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { eventHref } from '../lib/feedAttribution.ts';

/* avatar stack for attendees — shows count without fixture data */
function AvatarStack({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <View style={styles.stack}>
      <View style={styles.plus}>
        <Text style={styles.plusText}>{count > 99 ? '99+' : count}</Text>
      </View>
    </View>
  );
}

const VIBE: Partial<Record<string, string>> = {
  food: 'Food', nightlife: 'Nightlife', beach: 'Beach', adventure: 'Adventure',
  culture: 'Culture', wellness: 'Wellness', events: 'Live Music',
};

/** Host avatar with HighlightRing support. */
function HostAvatar({ host }: { host: NonNullable<CityEvent['host']> }) {
  const ringState = useHighlightRingState(host.id);
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <>
      <HighlightRing
        hasActive={ringState?.hasActive ?? false}
        allViewed={ringState?.allViewed ?? false}
        size={20}
        ringWidth={1.5}
        gap={1.5}
        onPress={ringState?.hasActive ? () => setViewerOpen(true) : undefined}
      >
        <Avatar uri={host.avatarUrl} name={host.name} size={20} />
      </HighlightRing>
      {ringState?.highlights && (
        <HighlightViewer
          visible={viewerOpen}
          highlights={ringState.highlights}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

/** Rich media plan card for "Fits your time". Horizontal-scroll width. */
export function FitsCard({
  ev,
  sessionId,
}: {
  ev: CityEvent;
  /**
   * Feed session from useCityPulse, threaded onto the event route so an RSVP
   * on the destination screen attributes back to this impression
   * (signal-audit §3a). Undefined when there is no session — the outcome then
   * records unattributed rather than wrongly attributed.
   */
  sessionId?: string | null;
}) {
  const time = new Date(ev.startAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const joinLabel = (ev.attendeeCount ?? 0) >= (ev.capacity ?? 99) ? 'Full' : ev.kind === 'meetup' ? 'Request to Join' : 'Join Plan';
  return (
    <Pressable style={styles.card} onPress={() => router.push(eventHref(ev.id, sessionId) as any)}>
      <View style={styles.media}>
        <View style={styles.timePill}><Text style={styles.timeText}>{time}</Text></View>
        <View style={styles.matchPill}><Text style={styles.matchText}>Great match</Text></View>
      </View>
      <View style={styles.body}>
        <View style={styles.locRow}>
          <MapPin size={12} color={color.mute} />
          <Text style={styles.loc} numberOfLines={1}>{ev.city}</Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>{ev.title}</Text>
        {ev.host && (
          <View style={styles.hostRow}>
            <HostAvatar host={ev.host} />
            <Text style={styles.host}>Hosted by {ev.host.name.split(' ')[0]}</Text>
          </View>
        )}
        <View style={styles.metaRow}>
          <AvatarStack count={ev.attendeeCount ?? 0} />
          <View style={{ flex: 1 }} />
          <Text style={styles.going}>{ev.attendeeCount ?? 0} going</Text>
        </View>
        <View style={styles.vibes}>
          <View style={styles.vibe}><Text style={styles.vibeText}>{VIBE[ev.category] ?? ev.category}</Text></View>
        </View>
        <Pressable
          style={[styles.joinBtn, joinLabel === 'Full' && styles.joinBtnFull]}
          onPress={joinLabel !== 'Full' ? () => router.push(eventHref(ev.id, sessionId) as any) : undefined}
        >
          <Text style={[styles.joinText, joinLabel === 'Full' && styles.joinTextFull]}>{joinLabel}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

/** Horizontal "When you're flexible" buckets (Tonight/Tomorrow/...). */
export function FlexibleStrip({ events }: { events: CityEvent[] }) {
  const [open, setOpen] = useState(true);
  if (!events.length) return null;
  const buckets = [
    { label: 'Tonight', n: events.filter((e) => e.block === 'evening' || e.block === 'late').length },
    { label: 'Tomorrow', n: Math.min(2, events.length) },
    { label: 'This Week', n: events.length },
    { label: 'This Weekend', n: Math.max(1, events.length - 1) },
  ].filter((b) => b.n > 0);

  return (
    <View style={fx.wrap}>
      <View style={fx.head}>
        <Text style={fx.title}>When you're flexible</Text>
        <View style={fx.badge}><Text style={fx.badgeText}>Outside your availability</Text></View>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.push('/(tabs)/trips')} style={fx.viewAll}>
          <Text style={fx.viewAllText}>View all ({events.length})</Text>
          <ChevronRight size={14} color={color.deep} />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={fx.strip}>
        {buckets.map((b) => (
          <Pressable key={b.label} style={fx.bucket} onPress={() => router.push('/(tabs)/trips')}>
            <View style={fx.bucketThumb} />
            <View>
              <Text style={fx.bucketLabel}>{b.label}</Text>
              <Text style={fx.bucketCount}>{b.n} plans</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: 240, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 130, backgroundColor: color.deep, justifyContent: 'space-between', flexDirection: 'row', padding: space.sm },
  timePill: { alignSelf: 'flex-start', backgroundColor: 'rgba(17,17,15,0.6)', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  timeText: { ...t.stamp, fontFamily: 'Courier', color: color.onInk },
  matchPill: { alignSelf: 'flex-start', backgroundColor: color.success, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  matchText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  body: { padding: space.md, gap: 6 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  loc: { ...t.small, color: color.mute },
  title: { ...t.heading, color: color.ink, fontSize: 16 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  host: { ...t.small, color: color.mute },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  stack: { flexDirection: 'row', alignItems: 'center' },
  stackImg: { width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2, borderWidth: 2, borderColor: color.paperRaised, backgroundColor: color.haze },
  plus: { width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: color.paperRaised },
  plusText: { fontSize: 9, fontWeight: '700', color: color.mute },
  going: { ...t.small, color: color.mute },
  vibes: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  vibe: { backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  vibeText: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 11 },
  joinBtn: { marginTop: 4, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  joinBtnFull: { borderColor: color.haze },
  joinText: { ...t.small, fontWeight: '800', color: color.signal },
  joinTextFull: { color: color.mute },
});

const fx = StyleSheet.create({
  wrap: { marginTop: space.xl },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, marginBottom: space.md, flexWrap: 'wrap' },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  badge: { backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  badgeText: { ...t.small, color: color.mute, fontSize: 11 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  viewAllText: { ...t.small, color: color.deep, fontWeight: '700' },
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  bucket: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.sm, paddingRight: space.lg },
  bucketThumb: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: color.deep },
  bucketLabel: { ...t.bodyStrong, color: color.ink },
  bucketCount: { ...t.small, color: color.mute },
});
