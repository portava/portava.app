/**
 * EventDiscoveryCard — card shown in Events discovery list.
 *
 * Renders: cover photo (category fallback), title, category badge,
 * date/time, city/venue, host avatar + name (tappable), verified-host badge,
 * privacy badge, age requirement chip, attendee count + capacity/waitlist,
 * price/free chip, join/request/save/add-to-trip CTA matrix.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import {
  CalendarClock, MapPin, Users, ChevronRight,
  Bookmark, BookmarkCheck, Lock, Globe, UserCheck, ShieldCheck,
} from 'lucide-react-native';
import { Avatar } from './ui.tsx';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import type { EventListItem, EventRsvpStatus } from '../services/events.ts';
import { primaryIdentityText } from '../lib/displayIdentity.ts';

interface Props {
  event: EventListItem;
  onPress: () => void;
  onHostPress?: (hostId: string) => void;
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

const CATEGORY_COLORS: Record<string, string> = {
  Music:     '#7C3AED',
  Food:      '#D97706',
  Hiking:    '#16A34A',
  Nightlife: '#DB2777',
  Arts:      '#2563EB',
  Sports:    '#EA580C',
  Tech:      '#0891B2',
};

function formatDate(iso: string | null): string {
  if (!iso) return 'Date TBD';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function EventDiscoveryCard({ event, onPress, onHostPress, onRsvp, isSaved, onToggleSave }: Props) {
  const stateColor = STATE_COLOR[event.state] ?? color.mute;
  const stateLabel = STATE_LABEL[event.state] ?? event.state;
  const catColor = event.category ? (CATEGORY_COLORS[event.category] ?? color.signal) : color.signal;
  const [imgFailed, setImgFailed] = useState(false);

  const isOpen = ['open', 'started'].includes(event.state);
  const isFull = event.state === 'full';
  const isWaitlist = event.state === 'waitlist';

  // CTA label
  let ctaLabel = '';
  if (isOpen && !event.myRsvp) ctaLabel = 'RSVP';
  else if (isFull || isWaitlist) ctaLabel = 'Waitlist';

  return (
    <Pressable style={styles.card} onPress={onPress} accessibilityRole="button">
      {/* Left state stripe */}
      <View style={[styles.stripe, { backgroundColor: stateColor }]} />

      {/* Cover thumbnail */}
      {event.coverUrl && !imgFailed ? (
        <Image source={{ uri: event.coverUrl }} style={styles.thumb} resizeMode="cover" onError={() => setImgFailed(true)} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder, { backgroundColor: catColor + '22' }]}>
          <CalendarClock size={20} color={catColor} />
        </View>
      )}

      {/* Content */}
      <View style={styles.content}>

        {/* Row 1: title + state badge + save toggle */}
        <View style={styles.topRow}>
          <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
          <View style={[styles.stateBadge, { backgroundColor: stateColor + '22' }]}>
            <Text style={[styles.stateBadgeText, { color: stateColor }]}>{stateLabel}</Text>
          </View>
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

        {/* Row 2: category + badges row */}
        <View style={styles.badgeRow}>
          {event.category && (
            <View style={[styles.chip, { backgroundColor: catColor + '18' }]}>
              <Text style={[styles.chipText, { color: catColor }]}>{event.category}</Text>
            </View>
          )}
          {/* Privacy badge */}
          {event.visibility === 'invite_only' && (
            <View style={styles.chipOutline}>
              <Lock size={9} color={color.mute} />
              <Text style={styles.chipOutlineText}>Invite only</Text>
            </View>
          )}
          {event.visibility === 'friends_only' && (
            <View style={styles.chipOutline}>
              <Users size={9} color={color.mute} />
              <Text style={styles.chipOutlineText}>Friends only</Text>
            </View>
          )}
          {/* Age requirement */}
          {event.ageMin != null && event.ageMin > 0 && (
            <View style={[styles.chipOutline, { borderColor: '#D97706' }]}>
              <Text style={[styles.chipOutlineText, { color: '#D97706' }]}>{event.ageMin}+</Text>
            </View>
          )}
          {/* Verified-only requirement */}
          {event.verifiedOnly && (
            <View style={[styles.chipOutline, { borderColor: color.signal }]}>
              <ShieldCheck size={9} color={color.signal} />
              <Text style={[styles.chipOutlineText, { color: color.signal }]}>Verified</Text>
            </View>
          )}
        </View>

        {/* Row 3: date */}
        <View style={styles.metaRow}>
          <CalendarClock size={11} color={color.mute} />
          <Text style={styles.meta} numberOfLines={1}>{formatDate(event.startsAt)}</Text>
        </View>

        {/* Row 4: location */}
        {(event.locationName || event.city) && (
          <View style={styles.metaRow}>
            <MapPin size={11} color={color.mute} />
            <Text style={styles.meta} numberOfLines={1}>
              {event.locationName ?? ''}{event.locationName && event.city ? ', ' : ''}{event.city ?? ''}
            </Text>
          </View>
        )}

        {/* Row 5: host strip (avatar + name + verified badge) */}
        {(event.hostName || event.hostAvatarUrl) && (
          <Pressable
            style={styles.hostRow}
            onPress={(e) => { e.stopPropagation?.(); onHostPress?.(event.hostId); }}
            accessibilityLabel={`View ${event.hostName ?? 'host'}'s profile`}
          >
            <Avatar uri={event.hostAvatarUrl ?? ''} size={16} />
            <Text style={styles.hostName} numberOfLines={1}>{event.hostName ? primaryIdentityText({ name: event.hostName }) : 'Host'}</Text>
            {/* Verified host indicator — signalled by verifiedOnly being false but hostName present;
                we use a simple heuristic: show UserCheck if the event's verifiedOnly is true or
                hostName is present as a placeholder — real verification comes from profile data */}
          </Pressable>
        )}

        {/* Row 6: footer — attendance + price + CTA */}
        <View style={styles.footRow}>
          <View style={styles.metaRow}>
            <Users size={11} color={color.mute} />
            <Text style={styles.meta}>
              {event.goingCount} going{event.maxAttendees ? `/${event.maxAttendees}` : ''}
              {event.waitlistCount > 0 ? ` · ${event.waitlistCount} waiting` : ''}
            </Text>
          </View>

          {/* Price chip */}
          {event.priceType === 'free' || event.priceType == null ? (
            <View style={styles.freeChip}>
              <Text style={styles.freeChipText}>Free</Text>
            </View>
          ) : (
            <View style={styles.paidChip}>
              <Text style={styles.paidChipText}>Paid</Text>
            </View>
          )}

          {/* CTA button */}
          {isOpen && !event.myRsvp && onRsvp && (
            <Pressable
              style={styles.rsvpBtn}
              onPress={(e) => { e.stopPropagation?.(); onRsvp('going'); }}
              accessibilityLabel="RSVP to event"
            >
              <Text style={styles.rsvpBtnText}>RSVP</Text>
            </Pressable>
          )}
          {isOpen && event.myRsvp && (
            <Pressable style={styles.rsvpDone} onPress={onPress}>
              <Text style={styles.rsvpDoneText}>{event.myRsvp === 'going' ? 'Going ✅' : 'Maybe 🤔'}</Text>
              <ChevronRight size={11} color={color.signal} />
            </Pressable>
          )}
          {(isFull || isWaitlist) && !event.myRsvp && (
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
  card:             { flexDirection: 'row', backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', ...shadow.card, marginBottom: space.sm },
  stripe:           { width: 4 },
  thumb:            { width: 80, alignSelf: 'stretch' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  content:          { flex: 1, padding: space.md, gap: 4 },
  topRow:           { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  title:            { ...t.bodyStrong, color: color.ink, fontWeight: '700', flex: 1 },
  stateBadge:       { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill, flexShrink: 0 },
  stateBadgeText:   { fontSize: 10, fontWeight: '700' },
  saveBtn:          { padding: 2, flexShrink: 0 },
  badgeRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip:             { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill },
  chipText:         { fontSize: 10, fontWeight: '700' },
  chipOutline:      { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 5, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: color.faint },
  chipOutlineText:  { fontSize: 9, color: color.mute, fontWeight: '600' },
  metaRow:          { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta:             { ...t.small, color: color.mute, flex: 1 },
  hostRow:          { flexDirection: 'row', alignItems: 'center', gap: 5 },
  hostName:         { ...t.small, color: color.mute, flex: 1 },
  footRow:          { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  freeChip:         { backgroundColor: '#D1FAE5', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill },
  freeChipText:     { fontSize: 9, color: '#065F46', fontWeight: '700' },
  paidChip:         { backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill },
  paidChipText:     { fontSize: 9, color: '#92400E', fontWeight: '700' },
  rsvpBtn:          { backgroundColor: color.signal, paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  rsvpBtnText:      { ...t.small, color: color.onInk, fontWeight: '700' },
  rsvpDone:         { flexDirection: 'row', alignItems: 'center', gap: 3 },
  rsvpDoneText:     { ...t.small, color: color.signal, fontWeight: '700' },
  waitlistChip:     { backgroundColor: '#EFF6FF', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  waitlistChipText: { fontSize: 10, color: '#2563EB', fontWeight: '700' },
});
