/**
 * PlaceCard — full canonical place card for the /place/[id] detail screen.
 *
 * Renders:
 *   - Header image via DisplayMediaImage (category artwork / MediaFallback — never blank)
 *   - Name, neighborhood, address (tappable → opens map)
 *   - Status badge when status !== 'active'
 *   - Price level chip
 *   - Open/closed badge + today's hours
 *   - Phone row (tappable tel: link, or "Phone not available")
 *   - Website row (tappable)
 *   - Booking URL button (when present)
 *   - Gallery images horizontal scroll (from galleryImages)
 *   - Amenities list
 *   - Provider rating and Portava traveler score as TWO separate labeled rows
 *     when both are present — never merged into one number
 *   - Attribution footer: one Text per entry in attribution[]
 *
 * When place is null, renders nothing.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Linking } from 'react-native';
import { MapPin, Star, Phone, Globe, Clock, ExternalLink } from 'lucide-react-native';
import { DisplayMediaImage, MediaFallback } from '../ui/DisplayMediaImage.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { CanonicalPlace, PlaceStatus, NormalizedOpeningHours, PriceLevel } from '../../types/canonicalPlace.ts';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
import { resolveHeaderImage } from '../../lib/visuals/resolveHeaderImage.ts';
import type { HeaderCandidate } from '../../lib/visuals/resolveHeaderImage.ts';
import { AiRepresentationLabel } from '../visuals/AiRepresentationLabel.tsx';

// ── Price level labels ────────────────────────────────────────────────────────

const PRICE_LABELS: Record<PriceLevel, string> = {
  free:          'Free',
  inexpensive:   '$',
  moderate:      '$$',
  expensive:     '$$$',
  very_expensive:'$$$$',
};

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

// ── Hours helpers ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getTodayHours(hours: NormalizedOpeningHours | null | undefined): { open: string; close: string } | null {
  if (!hours || hours.length === 0) return null;
  const today = new Date().getDay();
  return hours.find((h) => h.dayOfWeek === today) ?? null;
}

function formatTodayHoursLabel(hours: NormalizedOpeningHours): string {
  const today = new Date().getDay();
  const entry = hours.find((h) => h.dayOfWeek === today);
  if (!entry) return 'Closed today';
  return `${DAY_NAMES[today]}: ${entry.open} – ${entry.close}`;
}

// ── Open map helper ───────────────────────────────────────────────────────────

function openInMap(place: CanonicalPlace) {
  if (place.coordinates.lat != null && place.coordinates.lng != null) {
    const url = `https://www.google.com/maps/search/?api=1&query=${place.coordinates.lat},${place.coordinates.lng}`;
    Linking.openURL(url).catch(() => {});
  } else if (place.formattedAddress || place.address) {
    const q = encodeURIComponent(place.formattedAddress ?? place.address ?? place.name);
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlaceCardProps {
  place: CanonicalPlace | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlaceCard({ place }: PlaceCardProps) {
  if (!place) return null;

  const hasBothRatings = place.rating != null && place.travelerScore != null;
  const todayHours = getTodayHours(place.openingHours);
  const fallbackDesc = getPlaceCategoryFallback(place.category);
  const displayAddress = place.formattedAddress ?? place.address;

  // Build candidates with real source metadata so isRepresentation is correct.
  const _canonicalCandidates: HeaderCandidate[] = [];
  if (place.headerImageUrl) {
    _canonicalCandidates.push({
      url: place.headerImageUrl,
      source: (place.headerImageSource as HeaderCandidate['source']) ?? 'provider',
    });
  }
  // Legacy imageUrl treated as provider (always a real photo, never AI).
  if (place.imageUrl && place.imageUrl !== place.headerImageUrl) {
    _canonicalCandidates.push({ url: place.imageUrl, source: 'provider' });
  }
  const resolvedCanonical = resolveHeaderImage(_canonicalCandidates, {
    entityType: 'place',
    category: place.category,
    fallbackUrlFor: () => null,
  });

  return (
    <View style={pc.container}>
      {/* Header image — category fallback when no real image available */}
      <View style={pc.headerImageWrap}>
        <DisplayMediaImage
          uri={resolvedCanonical?.url ?? null}
          width={0}
          height={220}
          style={pc.headerImage}
          resizeMode="cover"
          alt={place.name}
          fallback={
            <MediaFallback
              icon={<Text style={pc.fallbackEmoji}>{fallbackDesc.emoji}</Text>}
              label={fallbackDesc.label}
              bg={fallbackDesc.color + '33'}
              style={pc.headerImageFallback}
            />
          }
        />
        {resolvedCanonical?.isRepresentation && (
          <AiRepresentationLabel style={pc.aiLabel} testID="canonical-place-ai-label" />
        )}
      </View>

      {/* Content */}
      <View style={pc.content}>
        {/* Status badge — only when not active */}
        {place.status !== 'active' && (
          <StatusBadge status={place.status as Exclude<PlaceStatus, 'active'>} />
        )}

        {/* Name */}
        <Text style={pc.name}>{place.name}</Text>

        {/* Category chip + price level chip */}
        <View style={pc.chipRow}>
          <View style={pc.chip}>
            <Text style={pc.chipText}>{place.category.replace(/_/g, ' ')}</Text>
          </View>
          {place.priceLevel && (
            <View style={[pc.chip, pc.priceChip]}>
              <Text style={[pc.chipText, pc.priceChipText]}>
                {PRICE_LABELS[place.priceLevel]}
              </Text>
            </View>
          )}
          {/* Open/closed real-time badge */}
          {place.isOpenNow != null && (
            <View style={[pc.openBadge, place.isOpenNow ? pc.openBadgeOpen : pc.openBadgeClosed]}>
              <Text style={[pc.openBadgeText, { color: place.isOpenNow ? '#047857' : '#B91C1C' }]}>
                {place.isOpenNow ? 'Open now' : 'Closed now'}
              </Text>
            </View>
          )}
        </View>

        {/* Today's hours */}
        {place.openingHours && todayHours && (
          <View style={pc.infoRow}>
            <Clock size={13} color={color.mute} />
            <Text style={pc.infoText}>{formatTodayHoursLabel(place.openingHours)}</Text>
          </View>
        )}
        {place.openingHours && !todayHours && (
          <View style={pc.infoRow}>
            <Clock size={13} color={color.faint} />
            <Text style={[pc.infoText, pc.infoTextNA]}>Hours not available</Text>
          </View>
        )}

        {/* Neighborhood + full address — tappable → opens map */}
        {(place.neighborhood || displayAddress) && (
          <Pressable
            style={pc.infoRow}
            onPress={() => openInMap(place)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${displayAddress ?? place.neighborhood} in maps`}
          >
            <MapPin size={13} color={color.deep} />
            <Text style={[pc.infoText, pc.infoTextLink]} numberOfLines={3}>
              {[place.neighborhood, displayAddress].filter(Boolean).join('\n')}
            </Text>
          </Pressable>
        )}
        {!place.neighborhood && !displayAddress && (
          <View style={pc.infoRow}>
            <MapPin size={13} color={color.faint} />
            <Text style={[pc.infoText, pc.infoTextNA]}>Address unavailable</Text>
          </View>
        )}

        {/* Phone — tappable or "Phone not available" */}
        <Pressable
          style={pc.infoRow}
          onPress={place.phone ? () => Linking.openURL(`tel:${place.phone}`).catch(() => {}) : undefined}
          disabled={!place.phone}
          accessibilityRole={place.phone ? 'button' : 'text'}
          testID="place-card-phone"
        >
          <Phone size={13} color={place.phone ? color.deep : color.faint} />
          <Text style={[pc.infoText, place.phone ? pc.infoTextLink : pc.infoTextNA]}>
            {place.phone ?? 'Phone not available'}
          </Text>
        </Pressable>

        {/* Website */}
        {place.website && (
          <Pressable
            style={pc.infoRow}
            onPress={() => Linking.openURL(place.website!).catch(() => {})}
            accessibilityRole="button"
          >
            <Globe size={13} color={color.deep} />
            <Text style={[pc.infoText, pc.infoTextLink]} numberOfLines={1}>
              {place.website.replace(/^https?:\/\/(www\.)?/, '')}
            </Text>
          </Pressable>
        )}

        {/* Booking URL button */}
        {place.bookingUrl && (
          <Pressable
            style={pc.bookingBtn}
            onPress={() => Linking.openURL(place.bookingUrl!).catch(() => {})}
            accessibilityRole="button"
          >
            <ExternalLink size={14} color="#fff" />
            <Text style={pc.bookingBtnText}>Book Now</Text>
          </Pressable>
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
              {place.reviewCount != null && (
                <Text style={pc.ratingCount}> ({place.reviewCount.toLocaleString()})</Text>
              )}
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

      {/* Gallery — horizontal scroll of additional images */}
      {place.galleryImages && place.galleryImages.length > 0 && (
        <View style={pc.gallerySection}>
          <Text style={pc.galleryLabel}>Photos</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={pc.galleryRow}
          >
            {place.galleryImages.slice(0, 8).map((url, i) => (
              <DisplayMediaImage
                key={i}
                uri={url}
                width={110}
                height={80}
                style={pc.galleryThumb}
                resizeMode="cover"
                alt={`${place.name} photo ${i + 1}`}
              />
            ))}
          </ScrollView>
        </View>
      )}

      {/* Amenities */}
      {place.amenities && place.amenities.length > 0 && (
        <View style={pc.amenitiesSection}>
          <Text style={pc.galleryLabel}>Amenities</Text>
          <View style={pc.amenitiesRow}>
            {place.amenities.map((amenity) => (
              <View key={amenity} style={pc.amenityChip}>
                <Text style={pc.amenityText}>
                  {amenity.replace(/_/g, ' ')}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

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
  headerImageWrap: {
    width: '100%',
    position: 'relative',
  },
  aiLabel: {
    position: 'absolute',
    bottom: 8,
    left: 8,
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
  fallbackEmoji: {
    fontSize: 48,
    lineHeight: 58,
    textAlign: 'center',
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
  priceChip: {
    backgroundColor: '#ECFDF5',
  },
  priceChipText: {
    color: '#065F46',
    fontWeight: '700',
  },
  openBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  openBadgeOpen: {
    backgroundColor: '#04785712',
  },
  openBadgeClosed: {
    backgroundColor: '#B91C1C12',
  },
  openBadgeText: {
    ...t.small,
    fontSize: 11,
    fontWeight: '700',
  },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 2,
  },
  infoText: {
    ...t.small,
    color: color.mute,
    flex: 1,
    lineHeight: 18,
    fontSize: 13,
  },
  infoTextLink: {
    color: color.deep,
    textDecorationLine: 'underline',
  },
  infoTextNA: {
    color: color.faint,
    fontStyle: 'italic',
  },

  bookingBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    marginTop: space.xs,
  },
  bookingBtnText: {
    ...t.bodyStrong,
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
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
  ratingCount: {
    fontWeight: '400',
    color: color.faint,
    fontSize: 11,
  },

  // ── Gallery ───────────────────────────────────────────────────────────────
  gallerySection: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: space.sm,
  },
  galleryLabel: {
    ...t.stamp,
    color: color.faint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  galleryRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  galleryThumb: {
    borderRadius: radius.sm,
    overflow: 'hidden',
  },

  // ── Amenities ─────────────────────────────────────────────────────────────
  amenitiesSection: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: space.sm,
  },
  amenitiesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  amenityChip: {
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  amenityText: {
    ...t.stamp,
    fontSize: 11,
    color: color.mute,
    textTransform: 'capitalize',
  },

  // ── Attribution footer ─────────────────────────────────────────────────────
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
