/**
 * EventCard — shared card for event discovery surfaces.
 * Cover image, title, date, location, RSVP count, primary CTA.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CalendarClock, MapPin, Users } from 'lucide-react-native';
import { CachedImage } from '../CachedImage.tsx';
import { color, space, radius, shadow, typography, layout } from '../../theme/tokens.ts';

export interface EventCardProps {
  id: string;
  title: string;
  startsAt: string | null;
  locationName?: string | null;
  city?: string | null;
  coverUrl?: string | null;
  goingCount: number;
  maxAttendees?: number | null;
  category?: string | null;
  state?: string;
  myRsvp?: string | null;
  onPress: () => void;
  onRsvp?: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Date TBD';
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

const STATE_COLOR: Record<string, string> = {
  open:      '#16A34A',
  full:      '#D97706',
  waitlist:  '#2563EB',
  started:   '#16A34A',
  completed: '#6B6862',
  cancelled: '#DC2626',
};

export function EventCard({
  title, startsAt, locationName, city, coverUrl, goingCount, maxAttendees,
  category, state, myRsvp, onPress, onRsvp,
}: EventCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const stateColor = (state && STATE_COLOR[state]) ?? color.signal;
  const isOpen = state === 'open' || state === 'started';
  const location = locationName ?? city ?? null;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}${location ? `, ${location}` : ''}`}
    >
      {/* Left accent stripe */}
      <View style={[styles.stripe, { backgroundColor: stateColor }]} />

      {/* Cover thumbnail */}
      {coverUrl && !imgFailed ? (
        <CachedImage
          source={{ uri: coverUrl }}
          style={styles.thumb}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: stateColor + '22' }]}>
          <CalendarClock size={18} color={stateColor} />
        </View>
      )}

      {/* Content */}
      <View style={styles.content}>
        {category ? (
          <Text style={styles.category} numberOfLines={1}>{category}</Text>
        ) : null}
        <Text style={styles.title} numberOfLines={2}>{title}</Text>

        <View style={styles.metaRow}>
          <CalendarClock size={11} color={color.mute} />
          <Text style={styles.meta} numberOfLines={1}>{formatDate(startsAt)}</Text>
        </View>

        {location ? (
          <View style={styles.metaRow}>
            <MapPin size={11} color={color.mute} />
            <Text style={styles.meta} numberOfLines={1}>{location}</Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          <View style={styles.metaRow}>
            <Users size={11} color={color.mute} />
            <Text style={styles.meta}>
              {goingCount} going{maxAttendees ? `/${maxAttendees}` : ''}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          {isOpen && !myRsvp && onRsvp ? (
            <Pressable
              style={({ pressed }) => [styles.rsvpBtn, pressed && { opacity: 0.7 }]}
              onPress={(e) => { e.stopPropagation?.(); onRsvp(); }}
              accessibilityRole="button"
              accessibilityLabel="RSVP to event"
            >
              <Text style={styles.rsvpBtnText}>RSVP</Text>
            </Pressable>
          ) : isOpen && myRsvp ? (
            <Text style={[styles.meta, { color: stateColor, fontWeight: '700' }]}>
              {myRsvp === 'going' ? 'Going ✅' : 'Maybe 🤔'}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
    marginBottom: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
  },
  stripe: { width: 4 },
  thumb: { width: 80, alignSelf: 'stretch' },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, padding: space.md, gap: 4 },
  category: { ...typography.metadata, color: color.mute, textTransform: 'uppercase' },
  title: { ...typography.cardTitle, color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { ...typography.caption, color: color.mute, flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  rsvpBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
  },
  rsvpBtnText: { ...typography.button, color: color.onInk, fontSize: 12 },
});
