/**
 * TripCard — shared card for the trips list.
 * Cover image, title, date range, crew count, status badge.
 *
 * Image priority: coverUrl (user/provider) → landmark category fallback asset.
 * The card is NEVER a blank grey rectangle.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, CalendarDays, Users } from 'lucide-react-native';
import { CachedImage } from '../CachedImage.tsx';
import { useEntityHeaderImage } from '../../hooks/useEntityHeaderImage.ts';
import { color, space, radius, shadow, typography, layout } from '../../theme/tokens.ts';

export interface TripCardProps {
  id: string;
  title: string;
  destinationCity: string;
  destinationCountry?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status: string;
  coverUrl?: string | null;
  memberCount?: number | null;
  onPress: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  planning:  color.deep,
  active:    color.success,
  completed: color.mute,
  cancelled: '#DC2626',
};

const STATUS_LABEL: Record<string, string> = {
  planning:  'Planning',
  active:    'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function TripCard({
  title, destinationCity, destinationCountry, startDate, endDate,
  status, coverUrl, memberCount, onPress,
}: TripCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const statusColor = STATUS_COLOR[status] ?? color.mute;
  const statusLabel = STATUS_LABEL[status] ?? status;
  const destination = destinationCountry
    ? `${destinationCity}, ${destinationCountry}`
    : destinationCity;
  const dateRange = startDate
    ? endDate ? `${startDate} – ${endDate}` : startDate
    : 'Dates TBD';

  // Resolves: coverUrl → landmark category fallback (bundled asset).
  // Never returns null — the category fallback ensures an image is always shown.
  const resolvedImageUrl = useEntityHeaderImage({
    url: coverUrl,
    entityType: 'trip',
    // Trips have no semantic category — 'landmark' gives an attractive travel image.
    category: 'landmark',
  });

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${destination}`}
    >
      {/* Cover image — always shown; falls through to bundled fallback asset */}
      {resolvedImageUrl && !imgFailed ? (
        <CachedImage
          source={{ uri: resolvedImageUrl }}
          style={styles.cover}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <MapPin size={22} color={color.onInk} strokeWidth={1.5} />
          <Text style={styles.coverFallbackText} numberOfLines={1}>{destinationCity}</Text>
        </View>
      )}

      {/* Status badge overlay */}
      <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
        <Text style={styles.statusText}>{statusLabel.toUpperCase()}</Text>
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>

        <View style={styles.metaRow}>
          <MapPin size={12} color={color.mute} />
          <Text style={styles.meta} numberOfLines={1}>{destination}</Text>
        </View>

        <View style={styles.metaRow}>
          <CalendarDays size={12} color={color.mute} />
          <Text style={styles.meta}>{dateRange}</Text>
        </View>

        {memberCount != null && memberCount > 0 ? (
          <View style={styles.metaRow}>
            <Users size={12} color={color.mute} />
            <Text style={styles.meta}>{memberCount} member{memberCount !== 1 ? 's' : ''}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  cover: {
    width: '100%',
    height: 140,
  },
  coverFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  coverFallbackText: {
    ...typography.label,
    color: color.onInk,
    opacity: 0.8,
  },
  statusBadge: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  statusText: {
    ...typography.metadata,
    color: '#fff',
  },
  body: {
    padding: space.md,
    gap: 5,
  },
  title: {
    ...typography.cardTitle,
    color: color.ink,
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  meta: {
    ...typography.caption,
    color: color.mute,
    flex: 1,
  },
});
