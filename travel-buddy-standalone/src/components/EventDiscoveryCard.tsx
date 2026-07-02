/**
 * EventDiscoveryCard — card shown in Events discovery list.
 * Displays cover photo thumbnail, title, date, location, attendance,
 * an inline RSVP button, and a save/bookmark toggle.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { CalendarClock, MapPin, Users, ChevronRight, Bookmark, BookmarkCheck } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import type { EventListItem, EventRsvpStatus } from '../services/events';

interface Props {
  event: EventListItem;
  onPress: () => void;
  onRsvp?: (status: EventRsvpStatus) => void;
  isSaved?: boolean;
  onToggleSave?: () => void;
}

const STATE_COLOR: Record<string, string> = {
  open:      '#16A34A',
  full:      '#D97706',
  waitlist:  '#2563EB',
  started:   '#16A34A',
  completed: color.mute,
  cancelled: '#DC2626',
  draft:     color.faint,
};

const STATE_LABEL: Record<string, string> = {
  open:      'Open',
  full:      'Full',
  waitlist:  'Waitlist',
  started:   'Happening now',
  completed: 'Completed',
  cancelled: 'Cancelled',
  draft:     'Draft',
};

const RSVP_OPTIONS: { key: EventRsvpStatus; label: string }[] = [
  { key: 'going',      label: 'Going ✅' },
  { key: 'maybe',      label: 'Maybe 🤔' },
];

function formatDate(iso: string | null): string {
  if (!iso) return 'Date TBD';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function EventDiscoveryCard({ event, onPress, onRsvp, isSaved, onToggleSave }: Props) {
  const stateColor = STATE_COLOR[event.state] ?? color.mute;
  const stateLabel = STATE_LABEL[event.state] ?? event.state;

  return (
    <Pressable style={styles.card} onPress={onPress}>
      {/* Stripe */}
      <View style={[styles.stripe, { backgroundColor: stateColor }]} />

      {/* Cover thumbnail */}
      {event.coverUrl ? (
        <Image source={{ uri: event.coverUrl }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <CalendarClock size={20} color={color.faint} />
        </View>
      )}

      {/* Content */}
      <View style={styles.content}>
        <View style={styles.topRow}>
          <Text style={styles.title} numberOfLines={1}>{event.title}</Text>
          <View style={[styles.stateBadge, { backgroundColor: stateColor + '22' }]}>
            <Text style={[styles.stateBadgeText, { color: stateColor }]}>{stateLabel}</Text>
          </View>
          {/* Save / bookmark toggle */}
          {onToggleSave && (
            <Pressable
              hitSlop={10}
              onPress={(e) => { e.stopPropagation?.(); onToggleSave(); }}
              style={styles.saveBtn}
              accessibilityLabel={isSaved ? 'Remove from saved' : 'Save event'}
            >
              {isSaved
                ? <BookmarkCheck size={16} color={color.signal} />
                : <Bookmark size={16} color={color.mute} />}
            </Pressable>
          )}
        </View>

        {event.category && (
          <Text style={styles.category}>{event.category}</Text>
        )}

        <View style={styles.metaRow}>
          <CalendarClock size={12} color={color.mute} />
          <Text style={styles.meta} numberOfLines={1}>{formatDate(event.startsAt)}</Text>
        </View>

        {event.locationName && (
          <View style={styles.metaRow}>
            <MapPin size={12} color={color.mute} />
            <Text style={styles.meta} numberOfLines={1}>
              {event.locationName}{event.city ? `, ${event.city}` : ''}
            </Text>
          </View>
        )}

        <View style={styles.footRow}>
          <View style={styles.metaRow}>
            <Users size={12} color={color.mute} />
            <Text style={styles.meta}>
              {event.goingCount} going{event.maxAttendees ? `/${event.maxAttendees}` : ''}
              {event.waitlistCount > 0 ? ` · ${event.waitlistCount} waiting` : ''}
            </Text>
          </View>

          {/* Inline RSVP */}
          {onRsvp && ['open', 'started'].includes(event.state) && (
            event.myRsvp ? (
              <Pressable style={styles.rsvpDone} onPress={onPress}>
                <Text style={styles.rsvpDoneText}>{event.myRsvp === 'going' ? 'Going ✅' : 'Maybe 🤔'}</Text>
                <ChevronRight size={12} color={color.signal} />
              </Pressable>
            ) : (
              <Pressable style={styles.rsvpBtn} onPress={() => onRsvp('going')}>
                <Text style={styles.rsvpBtnText}>RSVP</Text>
              </Pressable>
            )
          )}

          {['full', 'waitlist'].includes(event.state) && !event.myRsvp && (
            <View style={styles.waitlistChip}>
              <Text style={styles.waitlistChipText}>Waitlist</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card:         { flexDirection: 'row', backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', ...shadow.card },
  stripe:       { width: 4 },
  thumb:        { width: 80, height: 80, alignSelf: 'stretch' },
  thumbPlaceholder: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  content:      { flex: 1, padding: space.md, gap: 4 },
  topRow:       { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  title:        { ...t.bodyStrong, color: color.ink, fontWeight: '700', flex: 1 },
  stateBadge:   { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill },
  stateBadgeText:{ fontSize: 10, fontWeight: '700' },
  saveBtn:      { padding: 2 },
  category:     { ...t.small, color: color.mute, fontStyle: 'italic' },
  metaRow:      { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta:         { ...t.small, color: color.mute, flex: 1 },
  footRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  rsvpBtn:      { backgroundColor: color.signal, paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  rsvpBtnText:  { ...t.small, color: color.onInk, fontWeight: '700' },
  rsvpDone:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rsvpDoneText: { ...t.small, color: color.signal, fontWeight: '700' },
  waitlistChip: { backgroundColor: '#EFF6FF', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  waitlistChipText: { fontSize: 10, color: '#2563EB', fontWeight: '700' },
});
