/**
 * EventCard — shared card for event discovery surfaces.
 * Cover image, title, date, location, RSVP count, primary CTA.
 *
 * Image priority: coverUrl → event-category fallback asset (concert, meetup,
 * festival, food-event, sports-event, generic-event, …).
 * The card is NEVER a blank grey rectangle.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CalendarClock, MapPin, Users, Bookmark } from 'lucide-react-native';
import { CachedImage, withStorageParams } from '../CachedImage.tsx';
import { useEntityHeaderImage } from '../../hooks/useEntityHeaderImage.ts';
import { useHydratedMedia } from '../../services/mediaUrl.ts';
import { usePlaceImage } from '../../hooks/usePlaceImage.ts';
import { ImageSourceBadge } from '../visuals/ImageSourceBadge.tsx';
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
  isSaved?: boolean;
  /** Whether the cover image requires a provenance disclaimer (AI/illustrative) */
  coverDisclaimerRequired?: boolean | null;
  /** Disclaimer copy to show when coverDisclaimerRequired is true */
  coverDisclaimerText?: string | null;
  onPress: () => void;
  onRsvp?: () => void;
  onToggleSave?: () => void;
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
  category, state, myRsvp, isSaved, coverDisclaimerRequired, coverDisclaimerText,
  onPress, onRsvp, onToggleSave,
}: EventCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const stateColor = (state && STATE_COLOR[state]) ?? color.signal;
  const isOpen = state === 'open' || state === 'started';
  const location = locationName ?? city ?? null;

  // Signed-URL hydration: ensures cover images still render when the
  // media_private_buckets_enabled flag is toggled ON (SEC-02 gate).
  const { resolved: coverResolved } = useHydratedMedia([coverUrl ?? null]);
  const hydratedCoverUrl = (coverUrl && coverResolved[coverUrl]) ?? coverUrl ?? undefined;

  // Resolves: hydratedCoverUrl → event-category fallback (concert, meetup, …)
  // → generic-event. Never returns null.
  const resolvedImageUrl = useEntityHeaderImage({
    url: hydratedCoverUrl,
    entityType: 'event',
    category: category ?? undefined,
  });

  // Provenance metadata — drives ImageSourceBadge and disclaimer display.
  const coverPlaceImage = usePlaceImage({
    url: hydratedCoverUrl ?? null,
    disclaimerRequired: coverDisclaimerRequired ?? null,
    disclaimerText: coverDisclaimerText ?? null,
  });

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}${location ? `, ${location}` : ''}`}
    >
      {/* Left accent stripe */}
      <View style={[styles.stripe, { backgroundColor: stateColor }]} />

      {/* Cover thumbnail — always shown; falls through to bundled fallback asset */}
      {resolvedImageUrl && !imgFailed ? (
        <View style={styles.thumbWrap}>
          <CachedImage
            source={{ uri: withStorageParams(resolvedImageUrl, 'width=600&quality=80') }}
            style={styles.thumb}
            resizeMode="cover"
            onError={() => setImgFailed(true)}
          />
          <ImageSourceBadge
            sourceLabel={coverPlaceImage.sourceLabel}
            disclaimerRequired={coverPlaceImage.disclaimerRequired}
            disclaimerText={coverPlaceImage.disclaimerText}
          />
        </View>
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
          {onToggleSave ? (
            <Pressable
              style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.6 }]}
              onPress={(e) => { e.stopPropagation?.(); onToggleSave(); }}
              accessibilityRole="button"
              accessibilityLabel={isSaved ? 'Unsave event' : 'Save event'}
              hitSlop={8}
            >
              <Bookmark
                size={16}
                color={isSaved ? color.signal : color.mute}
                fill={isSaved ? color.signal : 'transparent'}
              />
            </Pressable>
          ) : null}
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
  thumbWrap: { width: 80, alignSelf: 'stretch', position: 'relative' },
  thumb: { width: 80, flex: 1 },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, padding: space.md, gap: 4 },
  category: { ...typography.metadata, color: color.mute, textTransform: 'uppercase' },
  title: { ...typography.cardTitle, color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { ...typography.caption, color: color.mute, flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  saveBtn: {
    padding: 2,
    marginRight: 4,
  },
  rsvpBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
  },
  rsvpBtnText: { ...typography.button, color: color.onInk, fontSize: 12 },
});
