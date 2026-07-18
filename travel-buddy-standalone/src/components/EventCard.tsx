import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Clock, Users, ChevronDown, ChevronUp, CalendarClock, MapPin } from 'lucide-react-native';
import type { CityEvent } from '../types/models.ts';
import { Stamp, Avatar } from './ui.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { SaveButton } from './SaveButton.tsx';
import { CITY_CENTROIDS } from '../lib/cityCentroids.ts';

function timeLabel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Compact, utility event/plan card — visually distinct from editorial posts. */
export function EventCard({ ev, dim, initialSaved }: {
  ev: CityEvent;
  dim?: boolean;
  initialSaved?: boolean;
}) {
  return (
    <Pressable
      style={[styles.card, dim && styles.dim]}
      onPress={() => router.push('/(tabs)/trips')}
    >
      <View style={styles.left}>
        <Stamp label={ev.category} tone="deep" rotate={0} />
        <Text style={styles.title} numberOfLines={1}>{ev.title}</Text>
        <View style={styles.metaRow}>
          <Clock size={12} color={color.mute} />
          <Text style={styles.meta}>{timeLabel(ev.startAt)} · {ev.city}</Text>
        </View>
        {ev.attendeeCount != null && (
          <View style={styles.metaRow}>
            <Users size={12} color={color.mute} />
            <Text style={styles.meta}>{ev.attendeeCount}{ev.capacity ? `/${ev.capacity}` : ''} going</Text>
          </View>
        )}
        <Pressable
          style={styles.viewOnMapBtn}
          onPress={(e) => {
            e.stopPropagation?.();
            // Entity IDs in useMapEntities are prefixed (e.g. "event:<uuid>").
            // Pass the prefixed form so the focusId snap matches exactly.
            // Also include the city's centroid coords so the map camera has an
            // immediate starting position while useMapEntities is still loading.
            const cityCoords = CITY_CENTROIDS[ev.city];
            const coordParams = cityCoords
              ? `&lat=${cityCoords[0]}&lng=${cityCoords[1]}`
              : '';
            router.push(
              `/map?entityTypes=events&focusId=${encodeURIComponent(`event:${ev.id}`)}${coordParams}` as any,
            );
          }}
          hitSlop={4}
        >
          <MapPin size={10} color={color.signal} />
          <Text style={styles.viewOnMapText}>View on map</Text>
        </Pressable>
      </View>
      {ev.host && <Avatar uri={ev.host.avatarUrl} size={36} />}
      <SaveButton entityType="event" entityId={ev.id} initialSaved={initialSaved} />
    </Pressable>
  );
}

/** Collapsed "When you're flexible · N" — dimmed, labeled with why. */
export function FlexibleSection({ events }: { events: CityEvent[] }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return (
    <View style={styles.flexWrap}>
      <Pressable style={styles.flexHead} onPress={() => setOpen((o) => !o)}>
        <CalendarClock size={16} color={color.mute} />
        <Text style={styles.flexTitle}>When you're flexible</Text>
        <Text style={styles.flexCount}>· {events.length} plans</Text>
        <View style={{ flex: 1 }} />
        {open ? <ChevronUp size={18} color={color.mute} /> : <ChevronDown size={18} color={color.mute} />}
      </Pressable>
      {open && (
        <View style={styles.flexBody}>
          <Text style={styles.flexNote}>Outside your set availability — shown in case your plans flex.</Text>
          {events.map((e) => <EventCard key={e.id} ev={e} dim />)}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  dim: { opacity: 0.6 },
  left: { flex: 1, gap: 4 },
  title: { ...t.bodyStrong, color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  meta: { ...t.small, color: color.mute },
  saveBtn: { padding: 4 },

  viewOnMapBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2,
  },
  viewOnMapText: { ...t.small, color: color.signal, fontSize: 10 },

  flexWrap: { marginHorizontal: space.lg, marginTop: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, overflow: 'hidden' },
  flexHead: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: space.md },
  flexTitle: { ...t.bodyStrong, color: color.mute },
  flexCount: { ...t.small, color: color.faint, fontFamily: 'Courier' },
  flexBody: { padding: space.md, paddingTop: 0, gap: space.sm },
  flexNote: { ...t.small, color: color.faint, marginBottom: 4 },
});
