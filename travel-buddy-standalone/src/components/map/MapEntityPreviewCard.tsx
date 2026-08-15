/**
 * MapEntityPreviewCard — unified bottom overlay card shown when a non-traveler
 * entity marker is tapped on the full-screen map.
 *
 * Renders entity-type-specific fields while sharing layout with
 * TravelerPreviewCard for visual consistency. Lays the foundation for the
 * Task map3 carousel (bi-directional card ↔ marker sync).
 *
 * Privacy note (Friends): only area-level location is shown — never exact
 * coordinates. The display reads the `approximateLabel` from the server
 * payload when available.
 */
import React from 'react';
import { useFsqPhoto } from '../../hooks/useFsqPhoto.ts';
import { resolveHeaderImage } from '../../lib/visuals/resolveHeaderImage.ts';
import type { HeaderCandidate } from '../../lib/visuals/resolveHeaderImage.ts';
import { fallbackUriFor } from '../../lib/visuals/fallbackAssets.ts';
import { AiRepresentationLabel } from '../visuals/AiRepresentationLabel.tsx';
import { ImageSourceBadge } from '../visuals/ImageSourceBadge.tsx';
import { usePlaceImage } from '../../hooks/usePlaceImage.ts';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { closeThenNavigate } from '../../lib/deferredNavigate.ts';
import {
  X,
  ArrowRight,
  CalendarDays,
  Sparkles,
  Plane,
  Heart,
  Users,
  MapPin,
  Star,
  Stamp,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, avatar, icon } from '../../theme/tokens.ts';
import { MAP_LAYER_CONFIG } from '../../types/mapTypes.ts';
import { AvatarImage, DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';
import type { MapEntity, PassportCountryPayload } from '../../types/mapTypes.ts';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
import { MapEntityActionRow } from './MapEntityActionRow.tsx';
import type { BuddyProfile } from '../../services/rentABuddy.ts';
import type { EventListItem } from '../../services/events.ts';
import type { HiddenGem } from '../../services/hiddenGems.ts';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { openDirectThread } from '../../services/messaging.ts';
import type { TripRow } from '../../services/trips.ts';
import type { CircleMemberLocation } from '../../services/map.ts';

// ── Per-type card bodies ───────────────────────────────────────────────────────

function BuddyCard({ entity, onClose }: { entity: MapEntity<BuddyProfile>; onClose: () => void }) {
  const buddy = entity.payload;
  const cfg = MAP_LAYER_CONFIG.buddies;
  const cats = buddy.categories.slice(0, 2).join(' · ');
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {buddy.coverPhotoUrl
            ? <DisplayMediaImage uri={buddy.coverPhotoUrl} width={46} height={46} style={s.iconImg} fallbackIcon={<Users size={20} color="#fff" />} fallbackBg={cfg.color} />
            : <Users size={20} color="#fff" />}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>
            {buddy.displayName ?? 'Local Buddy'}
          </Text>
          {cats ? <Text style={s.secondaryText} numberOfLines={1}>{cats}</Text> : null}
        </View>
      </View>
      <View style={s.chipRow}>
        {buddy.averageRating != null && (
          <View style={s.chip}>
            <Star size={10} color="#F59E0B" fill="#F59E0B" />
            <Text style={s.chipText}>{buddy.averageRating.toFixed(1)} ({buddy.reviewCount})</Text>
          </View>
        )}
        <View style={s.chip}>
          <MapPin size={10} color={color.mute} />
          <Text style={s.chipText} numberOfLines={1}>{buddy.city}</Text>
        </View>
        {buddy.hourlyRateUsd != null && (
          <View style={s.chip}>
            <Text style={s.chipText}>${buddy.hourlyRateUsd}/hr</Text>
          </View>
        )}
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => closeThenNavigate(onClose, `/(rent-a-buddy)/buddy/${buddy.id}`)}
      >
        <Text style={s.ctaText}>View Buddy Profile</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

function EventCard({ entity, onClose }: { entity: MapEntity<EventListItem>; onClose: () => void }) {
  const ev = entity.payload;
  const cfg = MAP_LAYER_CONFIG.events;
  const dateLabel = ev.startsAt
    ? new Date(ev.startsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  // myWaitlistPosition is now included in EventListItem responses so the chip
  // appears on the map without requiring a detail fetch.
  const waitlistPosition: number | null | undefined = ev.myWaitlistPosition;
  const showWaitlist = waitlistPosition != null && waitlistPosition > 0;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          <DisplayMediaImage
            uri={ev.coverUrl ?? null}
            width={46}
            height={46}
            style={s.iconImg}
            fallbackIcon={<CalendarDays size={20} color="#fff" />}
            fallbackBg={cfg.color}
          />
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={2}>{ev.title}</Text>
          {ev.hostName ? <Text style={s.secondaryText} numberOfLines={1}>by {ev.hostName}</Text> : null}
        </View>
      </View>
      <View style={s.chipRow}>
        {dateLabel && (
          <View style={s.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={s.chipText} numberOfLines={1}>{dateLabel}</Text>
          </View>
        )}
        {ev.goingCount > 0 && (
          <View style={s.chip}>
            <Users size={10} color={color.mute} />
            <Text style={s.chipText}>{ev.goingCount} going</Text>
          </View>
        )}
        {ev.priceType === 'free' && (
          <View style={[s.chip, s.greenChip]}>
            <Text style={[s.chipText, { color: color.success }]}>Free</Text>
          </View>
        )}
        {showWaitlist && (
          <View style={[s.chip, s.waitlistChip]} testID="event-waitlist-position-chip">
            <Text style={[s.chipText, s.waitlistChipText]}>Waitlisted — #{waitlistPosition}</Text>
          </View>
        )}
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => closeThenNavigate(onClose, `/event/${ev.id}`)}
      >
        <Text style={s.ctaText}>View Event</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

function GemCard({ entity, onClose }: { entity: MapEntity<HiddenGem>; onClose: () => void }) {
  const gem = entity.payload;
  const cfg = MAP_LAYER_CONFIG.gems;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {gem.imageUrl
            ? <DisplayMediaImage uri={gem.imageUrl} width={46} height={46} style={s.iconImg} fallbackIcon={<Sparkles size={20} color="#fff" />} fallbackBg={cfg.color} />
            : <Sparkles size={20} color="#fff" />}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{gem.name}</Text>
          <Text style={s.secondaryText} numberOfLines={1}>
            {gem.category.replace('_', ' ')} · {gem.city}
          </Text>
        </View>
      </View>
      {gem.description ? (
        <Text style={s.bodyText} numberOfLines={2}>{gem.description}</Text>
      ) : null}
      <View style={s.chipRow}>
        {gem.vibeTags.slice(0, 3).map((tag) => (
          <View key={tag} style={s.chip}>
            <Text style={s.chipText}>#{tag}</Text>
          </View>
        ))}
        {gem.layoverSafe && (
          <View style={[s.chip, s.greenChip]}>
            <Text style={[s.chipText, { color: color.success }]}>Layover safe</Text>
          </View>
        )}
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => closeThenNavigate(onClose, `/gems/${gem.id}`)}
      >
        <Text style={s.ctaText}>View Hidden Gem</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

function TripCard({ entity, onClose }: { entity: MapEntity<TripRow>; onClose: () => void }) {
  const trip = entity.payload;
  const cfg = MAP_LAYER_CONFIG.trips;
  const dateRange = [trip.startDate, trip.endDate]
    .filter(Boolean)
    .map((d) => new Date(d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    .join(' – ');
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {trip.coverUrl
            ? <DisplayMediaImage uri={trip.coverUrl} width={46} height={46} style={s.iconImg} fallbackIcon={<Plane size={20} color="#fff" />} fallbackBg={cfg.color} />
            : <Plane size={20} color="#fff" />}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{trip.title}</Text>
          <Text style={s.secondaryText} numberOfLines={1}>
            {trip.destinationCity}
            {trip.destinationCountry ? `, ${trip.destinationCountry}` : ''}
          </Text>
        </View>
      </View>
      <View style={s.chipRow}>
        {dateRange ? (
          <View style={s.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={s.chipText}>{dateRange}</Text>
          </View>
        ) : null}
        <View style={s.chip}>
          <Text style={s.chipText}>{trip.visibility.replace('_', ' ')}</Text>
        </View>
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => closeThenNavigate(onClose, `/trip/${trip.id}`)}
      >
        <Text style={s.ctaText}>View Trip</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

function FriendCard({ entity, onClose }: { entity: MapEntity<CircleMemberLocation>; onClose: () => void }) {
  const loc = entity.payload;
  const cfg = MAP_LAYER_CONFIG.friends;
  const displayName = loc.name ?? 'Circle member';
  const locationLabel = loc.city ?? 'Area location shared';
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.avatarWrap, { borderColor: cfg.color }]}>
          {loc.avatarUrl
            ? <AvatarImage uri={loc.avatarUrl} user={{ displayName: loc.name }} size={44} style={s.avatarImg} bg={cfg.color} />
            : (
              <View style={[s.avatarFallback, { backgroundColor: cfg.color }]}>
                <Heart size={16} color="#fff" />
              </View>
            )}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{displayName}</Text>
          {/* Privacy: never show exact coordinates — show area label only */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <MapPin size={11} color={color.mute} />
            <Text style={s.secondaryText} numberOfLines={1}>Near {locationLabel}</Text>
          </View>
        </View>
      </View>
      <View style={s.privacyNotice}>
        <Text style={s.privacyText}>📍 Approximate location — area level only</Text>
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={async () => {
          onClose();
          // Resolve the direct thread first — /messages/[id] takes a THREAD id, not a user id.
          const res = await openDirectThread(loc.userId);
          if (res.ok && res.data?.threadId) {
            // Defer past the sheet's close animation — see closeThenNavigate for why.
            setTimeout(() => router.push(`/messages/${res.data!.threadId}?threadType=direct&otherUserId=${encodeURIComponent(loc.userId)}` as any), 320);
          } else {
            Alert.alert('Could not open conversation', 'Please try again.');
          }
        }}
      >
        <Text style={s.ctaText}>Message</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

// ── Place card body ────────────────────────────────────────────────────────────

function PlaceCard({ entity, onClose }: { entity: MapEntity<DiscoveryPlace>; onClose: () => void }) {
  const place = entity.payload;
  const cfg = MAP_LAYER_CONFIG.places;
  // attribution may be an array (canonical) or a single string/null (discovery).
  const attributionList: string[] = Array.isArray((place as any).attribution)
    ? (place as any).attribution as string[]
    : [];
  const detailRoute = entity.detailRoute ?? '/(tabs)/discovery';

  // Category fallback descriptor — used when no real cover image is available.
  const fallbackDesc = getPlaceCategoryFallback(place.category);
  // Use specific sub-type label (e.g. "café") if available, otherwise category.
  const typeLabel = (place.type ?? place.category).replace(/_/g, ' ');
  // When AI-generated, fetch FSQ independently — a real photo can override the AI candidate.
  const _previewHeaderSource = (place as any).headerImageSource as string | null | undefined;
  const _previewFsqPassthrough = _previewHeaderSource === 'ai_generated'
    ? undefined
    : ((place as any).headerImageUrl as string | undefined ?? undefined);
  const photoUrl = useFsqPhoto(place.name, place.lat, place.lng, _previewFsqPassthrough, place.id);

  // Build candidates with real source metadata so isRepresentation is correct.
  const _previewCandidates: HeaderCandidate[] = [];
  const _headerSource = _previewHeaderSource;
  if ((place as any).headerImageUrl) {
    _previewCandidates.push({
      url: (place as any).headerImageUrl as string,
      source: (_headerSource as HeaderCandidate['source']) ?? 'provider',
      imageSourceType: place.imageSourceType ?? null,
      disclaimerRequired: place.disclaimerRequired ?? null,
      disclaimerText: place.disclaimerText ?? null,
    });
  }
  if (photoUrl && photoUrl !== (place as any).headerImageUrl) {
    _previewCandidates.push({ url: photoUrl, source: 'provider' });
  }
  const resolvedPreview = resolveHeaderImage(_previewCandidates, {
    entityType: 'place',
    category: place.category,
    fallbackUrlFor: fallbackUriFor,
  });

  const placeImage = usePlaceImage({
    url: resolvedPreview?.url ?? null,
    imageSourceType: resolvedPreview?.imageSourceType ?? place.imageSourceType,
    accuracyStatus: place.accuracyStatus,
    disclaimerRequired: resolvedPreview?.disclaimerRequired ?? place.disclaimerRequired,
    disclaimerText: resolvedPreview?.disclaimerText ?? place.disclaimerText,
    isRepresentation: resolvedPreview?.isRepresentation,
    altText: place.name,
  });

  return (
    <>
      <View style={s.topRow}>
        {/* Image circle — shows cover if available, category fallback otherwise */}
        <View style={[s.iconCircle, { backgroundColor: fallbackDesc.color + '22' }]}>
          <DisplayMediaImage
            uri={resolvedPreview?.url ?? null}
            width={46}
            height={46}
            style={s.iconImg}
            resizeMode="cover"
            alt={placeImage.accessibilityLabel ?? place.name}
            fallback={
              <View
                testID="map-preview-fallback"
                style={[s.iconCircle, { backgroundColor: fallbackDesc.color + '33' }]}
              >
                <Text style={s.fallbackEmoji}>{fallbackDesc.emoji}</Text>
              </View>
            }
          />
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{place.name}</Text>
          {/* Specific type label — never just raw category */}
          <Text style={s.secondaryText} numberOfLines={1} testID="place-preview-type">
            {typeLabel}
          </Text>
        </View>
      </View>
      <View style={s.chipRow}>
        {/* Address or neighborhood on a chip */}
        {(place.address || (place as any).neighborhood) ? (
          <View style={s.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={s.chipText} numberOfLines={1}>
              {(place as any).neighborhood ?? place.address}
            </Text>
          </View>
        ) : null}
        {place.rating != null && (
          <View style={s.chip}>
            <Star size={10} color="#F59E0B" fill="#F59E0B" />
            <Text style={s.chipText}>{place.rating.toFixed(1)}</Text>
          </View>
        )}
      </View>
      {/* Attribution — canonical place sources (OSM / Foursquare etc.) */}
      {attributionList.length > 0 && (
        <View style={s.placeAttributionRow}>
          {attributionList.map((attr, i) => (
            <Text key={i} style={s.placeAttributionText}>{attr}</Text>
          ))}
        </View>
      )}
      {/* Image source badge — accuracy pipeline labels; falls back to legacy AI representation */}
      {placeImage.sourceLabel !== null ? (
        <ImageSourceBadge
          sourceLabel={placeImage.sourceLabel}
          disclaimerRequired={placeImage.disclaimerRequired}
          disclaimerText={placeImage.disclaimerText}
          placeId={place.id}
          imageUrl={resolvedPreview?.url ?? undefined}
          testID={`map-preview-image-source-badge-${place.id}`}
        />
      ) : resolvedPreview?.isRepresentation ? (
        <AiRepresentationLabel testID={`map-preview-ai-label-${place.id}`} />
      ) : null}
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => closeThenNavigate(onClose, detailRoute)}
      >
        <Text style={s.ctaText}>View details</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

// ── Stamp card body ────────────────────────────────────────────────────────────

function StampCountryCardBody({
  entity,
  onClose,
}: {
  entity: MapEntity<PassportCountryPayload>;
  onClose: () => void;
}) {
  const { country, stampCount, cities } = entity.payload;
  const cfg = MAP_LAYER_CONFIG.stamps;
  const cityLabel = cities.slice(0, 3).join(' · ');
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          <Stamp size={20} color="#fff" />
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{country}</Text>
          {cityLabel ? (
            <Text style={s.secondaryText} numberOfLines={1}>{cityLabel}</Text>
          ) : null}
        </View>
      </View>
      <View style={s.chipRow}>
        <View style={s.chip}>
          <Stamp size={10} color={cfg.color} />
          <Text style={[s.chipText, { color: cfg.color }]}>
            {stampCount} {stampCount === 1 ? 'stamp' : 'stamps'}
          </Text>
        </View>
        {cities.length > 0 && (
          <View style={s.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={s.chipText}>
              {cities.length} {cities.length === 1 ? 'city' : 'cities'}
            </Text>
          </View>
        )}
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => closeThenNavigate(onClose, `/passport/country/${encodeURIComponent(country)}`)}
      >
        <Text style={s.ctaText}>View Stamps</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </>
  );
}

// ── Wrapper ────────────────────────────────────────────────────────────────────

export function MapEntityPreviewCard({
  entity,
  onClose,
}: {
  entity: MapEntity;
  onClose: () => void;
}) {
  const renderBody = () => {
    switch (entity.type) {
      case 'buddies':
        return <BuddyCard entity={entity as MapEntity<BuddyProfile>} onClose={onClose} />;
      case 'events':
        return <EventCard entity={entity as MapEntity<EventListItem>} onClose={onClose} />;
      case 'gems':
        return <GemCard entity={entity as MapEntity<HiddenGem>} onClose={onClose} />;
      case 'trips':
        return <TripCard entity={entity as MapEntity<TripRow>} onClose={onClose} />;
      case 'friends':
        return <FriendCard entity={entity as MapEntity<CircleMemberLocation>} onClose={onClose} />;
      case 'stamps':
        return <StampCountryCardBody entity={entity as MapEntity<PassportCountryPayload>} onClose={onClose} />;
      case 'places':
        return <PlaceCard entity={entity as MapEntity<DiscoveryPlace>} onClose={onClose} />;
      default:
        return null;
    }
  };

  return (
    <View style={s.card}>
      <Pressable style={s.closeBtn} onPress={onClose} hitSlop={8}>
        <X size={16} color={color.mute} />
      </Pressable>
      {renderBody()}
      <MapEntityActionRow entity={entity} />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 58,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
    ...shadow.card,
    elevation: 8,
  },
  closeBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 2,
    width: icon.s26, height: icon.s26,
    borderRadius: icon.s26 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingRight: 30,
  },
  iconCircle: {
    width: avatar.s46, height: avatar.s46,
    borderRadius: avatar.s46 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  iconImg: {
    width: avatar.s46, height: avatar.s46,
    borderRadius: avatar.s46 / 2,
  },
  topText: {
    flex: 1,
    minWidth: 0,
  },
  primaryText: {
    ...t.bodyStrong,
    fontSize: 15,
    color: color.ink,
  },
  secondaryText: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
    marginTop: 2,
    textTransform: 'capitalize',
  },
  bodyText: {
    ...t.body,
    fontSize: 13,
    color: color.mute,
    lineHeight: 18,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: 200,
  },
  greenChip: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  waitlistChip: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  waitlistChipText: {
    color: '#92400E',
    textTransform: 'none',
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
    textTransform: 'capitalize',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.md,
    paddingVertical: 10,
  },
  ctaText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  // Friend-specific
  avatarWrap: {
    width: avatar.s46, height: avatar.s46,
    borderRadius: avatar.s46 / 2,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    flexShrink: 0,
  },
  avatarImg: {
    width: avatar.s40, height: avatar.s40,
    borderRadius: avatar.s40 / 2,
  },
  avatarFallback: {
    width: avatar.s40, height: avatar.s40,
    borderRadius: avatar.s40 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyNotice: {
    backgroundColor: '#FFF7ED',
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#FED7AA',
  },
  privacyText: {
    fontSize: 11,
    color: '#92400E',
    fontWeight: '500',
  },
  // Place attribution footer (canonical sources)
  placeAttributionRow: {
    marginTop: 4,
    gap: 2,
  },
  fallbackEmoji: {
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
  },
  placeAttributionText: {
    fontSize: 10,
    color: color.faint,
    fontStyle: 'italic',
    lineHeight: 14,
  },
});
