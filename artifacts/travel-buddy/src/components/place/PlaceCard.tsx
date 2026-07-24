/**
 * PlaceCard — full canonical place card for the /place/[id] detail screen.
 *
 * Renders:
 *   - Header image via DisplayMediaImage (category artwork / MediaFallback — never blank)
 *   - Name, neighborhood, address
 *   - Status badge when status !== 'active'
 *   - Provider rating and Portava traveler score as TWO separate labeled rows
 *     when both are present — never merged into one number
 *   - Attribution footer: one Text per entry in attribution[]
 *
 * When place is null, renders nothing.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin, Star } from 'lucide-react-native';
import { DisplayMediaImage, MediaFallback } from '../ui/DisplayMediaImage.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { CanonicalPlace, PlaceStatus } from '../../types/canonicalPlace.ts';

// ── Status badge helpers ──────────────────────────────────────────────────────

const STATUS_LABELS: Record<Exclude<PlaceStatus, 'active'>, string> = {
  closed:             'Closed',
  temporarily_closed: 'Temporarily closed',
  moved:              'Moved',
};

const STATUS_COLORS: Record<Exclude<PlaceStatus, 'active'>, string> = {
  closed:             '#DC2626',
  temporarily_closed: '#F59E0B',
  moved:              '#6B7280',
};

function StatusBadge({ status }: { status: Exclude<PlaceStatus, 'active'> }) {
  const label = STATUS_LABELS[status];
  const badgeColor = STATUS_COLORS[status];
  return (
    <View style={[pc.statusBadge, { backgroundColor: badgeColor + '18', borderColor: badgeColor + '44' }]}>
      <Text style={[pc.statusText, { color: badgeColor }]}>{label}</Text>
    </View>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlaceCardProps {
  place: CanonicalPlace | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlaceCard({ place }: PlaceCardProps) {
  if (!place) return null;

  const hasBothRatings =
    place.rating != null && place.travelerScore != null;

  return (
    <View style={pc.container}>
      {/* Header image */}
      <DisplayMediaImage
        uri={place.imageUrl ?? null}
        width={0}
        height={220}
        style={pc.headerImage}
        fallback={
          <MediaFallback
            icon={<MapPin size={32} color={color.mute} />}
            label={place.category.replace(/_/g, ' ')}
            style={pc.headerImageFallback}
          />
        }
        alt={place.name}
        resizeMode="cover"
      />

      {/* Content */}
      <View style={pc.content}>
        {/* Status badge — only when not active */}
        {place.status !== 'active' && (
          <StatusBadge status={place.status as Exclude<PlaceStatus, 'active'>} />
        )}

        {/* Name */}
        <Text style={pc.name}>{place.name}</Text>

        {/* Category chip */}
        <View style={pc.chipRow}>
          <View style={pc.chip}>
            <Text style={pc.chipText}>{place.category.replace(/_/g, ' ')}</Text>
          </View>
        </View>

        {/* Neighborhood + address */}
        {(place.neighborhood || place.address) && (
          <View style={pc.locationRow}>
            <MapPin size={13} color={color.mute} />
            <Text style={pc.locationText} numberOfLines={2}>
              {[place.neighborhood, place.address].filter(Boolean).join(' · ')}
            </Text>
          </View>
        )}

        {/* Ratings — rendered as separate labeled rows, never blended */}
        {place.rating != null && (
          <View style={pc.ratingRow}>
            <Star size={14} color="#F59E0B" fill="#F59E0B" />
            <Text style={pc.ratingLabel}>
              {hasBothRatings
                ? `${place.ratingProvider ?? 'Provider'} rating: `
                : 'Rating: '}
              <Text style={pc.ratingValue}>{place.rating.toFixed(1)}</Text>
            </Text>
          </View>
        )}
        {place.travelerScore != null && (
          <View style={pc.ratingRow}>
            <Star size={14} color={color.signal} fill={color.signal} />
            <Text style={pc.ratingLabel}>
              {'Traveler score: '}
              <Text style={pc.ratingValue}>{place.travelerScore.toFixed(1)}</Text>
            </Text>
          </View>
        )}
      </View>

      {/* Attribution footer — always rendered, one Text per entry */}
      {place.attribution.length > 0 && (
        <View style={pc.attributionFooter} testID="place-attribution-footer">
          {place.attribution.map((attr, i) => (
            <Text key={i} style={pc.attributionText} testID={`place-attribution-${i}`}>
              {attr}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pc = StyleSheet.create({
  container: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: space.md,
  },
  headerImage: {
    width: '100%' as any,
    height: 220,
  },
  headerImageFallback: {
    width: '100%' as any,
    height: 220,
    backgroundColor: color.haze,
  },

  content: {
    padding: space.md,
    gap: space.xs,
  },

  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    marginBottom: space.xs,
  },
  statusText: {
    ...t.small,
    fontWeight: '700',
    fontSize: 12,
  },

  name: {
    ...t.bodyStrong,
    fontSize: 20,
    fontWeight: '700',
    color: color.ink,
    marginBottom: 2,
  },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 2,
  },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  chipText: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
    textTransform: 'capitalize',
  },

  locationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    marginBottom: 2,
  },
  locationText: {
    ...t.small,
    color: color.mute,
    flex: 1,
    lineHeight: 18,
  },

  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  ratingLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 13,
  },
  ratingValue: {
    fontWeight: '700',
    color: color.ink,
  },

  attributionFooter: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
    gap: 2,
  },
  attributionText: {
    ...t.small,
    fontSize: 11,
    color: color.faint,
    fontStyle: 'italic',
  },
});
