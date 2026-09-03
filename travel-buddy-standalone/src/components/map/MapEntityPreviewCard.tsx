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
import type { MapEntity, MapEntityType, PassportCountryPayload } from '../../types/mapTypes.ts';
import {
  isForecastKind,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../types/mapObjects.ts';
import {
  describeMapObject,
  emitMapEvent,
  type MapObjectRef,
} from '../../features/map/telemetry/mapTelemetry.ts';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
import { MapEntityActionRow } from './MapEntityActionRow.tsx';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { openDirectThread } from '../../services/messaging.ts';
import {
  buddyCardPayload,
  eventCardPayload,
  friendCardPayload,
  gemCardPayload,
  isMapObject,
  objectOf,
  passportCardPayload,
  tripCardPayload,
} from '../../types/mapCardPayloads.ts';

// ── §35 telemetry ─────────────────────────────────────────────────────────────
//
// `describeMapObject` is the only sanctioned way to put an object into a §35
// payload; it takes a contract `MapObject`, so one is recovered from the legacy
// envelope first. See the fuller note in MapEntityActionRow.tsx — this copy
// exists because every candidate shared host (MapEntityActionRow included) is
// wholesale `jest.mock`ed by one of the existing component tests, and this lane
// may not add files.

const TELEMETRY_KIND_BY_TYPE: Record<MapEntityType, MapObjectKind> = {
  places: 'place',
  events: 'event',
  gems: 'hidden_gem',
  trips: 'trip_stop',
  friends: 'crew_member',
  buddies: 'buddy_zone',
  travelers: 'social_zone',
  stamps: 'memory',
};

/** DERIVED §23 rung — legacy envelopes record none. See MapEntityActionRow.tsx. */
const TELEMETRY_PRIVACY_BY_TYPE: Record<MapEntityType, PrivacyClass> = {
  places: 'place_level',
  events: 'place_level',
  gems: 'place_level',
  trips: 'place_level',
  friends: 'approximate',
  buddies: 'approximate',
  travelers: 'aggregate_only',
  stamps: 'aggregate_only',
};

const TELEMETRY_ZONE_KINDS: readonly MapObjectKind[] = [
  'activity_zone',
  'crowd_flow',
  'social_zone',
  'prediction',
];

function entityTelemetryRef(entity: MapEntity): MapObjectRef {
  if (isMapObject(entity.payload)) return describeMapObject(entity.payload);
  return describeMapObject({
    id: entity.id,
    kind: TELEMETRY_KIND_BY_TYPE[entity.type],
    geometry: { type: 'Point', coordinates: [entity.lng, entity.lat] },
    title: '',
    privacyClass: TELEMETRY_PRIVACY_BY_TYPE[entity.type],
    renderingPriority: 0,
  });
}

function entityKind(entity: MapEntity): MapObjectKind {
  return isMapObject(entity.payload)
    ? entity.payload.kind
    : TELEMETRY_KIND_BY_TYPE[entity.type];
}

/**
 * The card's "View →" CTA: §35 `place_opened` (or `zone_selected` when the
 * object is a zone/forecast kind), then the existing navigation, unchanged.
 * Telemetry is fire-and-forget — it may never block or break the push.
 */
function openEntityDetail(entity: MapEntity, onClose: () => void, route: string): void {
  try {
    const kind = entityKind(entity);
    if (TELEMETRY_ZONE_KINDS.includes(kind)) {
      emitMapEvent('zone_selected', {
        ref: entityTelemetryRef(entity),
        source: 'marker',
        forecast: isForecastKind(kind),
      });
    } else {
      emitMapEvent('place_opened', {
        ref: entityTelemetryRef(entity),
        // This component IS the §35 'preview_card' surface — the card shown for
        // a tapped marker. There is no list position here, so `rank` is omitted.
        source: 'preview_card',
      });
    }
  } catch {
    // Deliberately swallowed.
  }
  closeThenNavigate(onClose, route);
}

// ── Per-type card bodies ───────────────────────────────────────────────────────

function BuddyCard({
  entity,
  obj,
  onClose,
}: { entity: MapEntity; obj: MapObject; onClose: () => void }) {
  const cfg = MAP_LAYER_CONFIG.buddies;
  const p = buddyCardPayload(obj);
  // `p.categories` is always an array — the projector enumerates it. This read
  // used to be `(entity.payload as BuddyProfile).categories.slice(0, 2)`, which
  // threw the moment `payload` became a MapObject and `categories` came back
  // undefined.
  const cats = (p?.categories ?? []).slice(0, 2).join(' · ');
  const detailRoute = obj.interaction?.detailRoute ?? entity.detailRoute;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {p?.coverPhotoUrl
            ? <DisplayMediaImage uri={p.coverPhotoUrl} width={46} height={46} style={s.iconImg} fallbackIcon={<Users size={20} color="#fff" />} fallbackBg={cfg.color} />
            : <Users size={20} color="#fff" />}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{obj.title}</Text>
          {cats ? <Text style={s.secondaryText} numberOfLines={1}>{cats}</Text> : null}
        </View>
      </View>
      <View style={s.chipRow}>
        {p?.averageRating != null && (
          <View style={s.chip}>
            <Star size={10} color="#F59E0B" fill="#F59E0B" />
            <Text style={s.chipText}>
              {p.averageRating.toFixed(1)}{p.reviewCount != null ? ` (${p.reviewCount})` : ''}
            </Text>
          </View>
        )}
        {p?.city ? (
          <View style={s.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={s.chipText} numberOfLines={1}>{p.city}</Text>
          </View>
        ) : null}
        {p?.hourlyRateUsd != null && (
          <View style={s.chip}>
            <Text style={s.chipText}>${p.hourlyRateUsd}/hr</Text>
          </View>
        )}
      </View>
      {detailRoute ? (
        <Pressable
          style={[s.cta, { backgroundColor: cfg.color }]}
          onPress={() => openEntityDetail(entity, onClose, detailRoute)}
        >
          <Text style={s.ctaText}>View Buddy Profile</Text>
          <ArrowRight size={15} color="#fff" />
        </Pressable>
      ) : null}
    </>
  );
}

function EventCard({
  entity,
  obj,
  onClose,
}: { entity: MapEntity; obj: MapObject; onClose: () => void }) {
  const cfg = MAP_LAYER_CONFIG.events;
  const p = eventCardPayload(obj);
  const dateLabel = p?.startsAt
    ? new Date(p.startsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const detailRoute = obj.interaction?.detailRoute ?? entity.detailRoute;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          <DisplayMediaImage
            uri={p?.coverUrl ?? null}
            width={46}
            height={46}
            style={s.iconImg}
            fallbackIcon={<CalendarDays size={20} color="#fff" />}
            fallbackBg={cfg.color}
          />
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={2}>{obj.title}</Text>
          {p?.locationName ? (
            <Text style={s.secondaryText} numberOfLines={1}>{p.locationName}</Text>
          ) : null}
        </View>
      </View>
      <View style={s.chipRow}>
        {dateLabel && (
          <View style={s.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={s.chipText} numberOfLines={1}>{dateLabel}</Text>
          </View>
        )}
        {p?.hasStarted === true && (
          <View style={[s.chip, s.greenChip]}>
            <Text style={[s.chipText, { color: color.success }]}>Happening now</Text>
          </View>
        )}
      </View>
      {detailRoute ? (
        <Pressable
          style={[s.cta, { backgroundColor: cfg.color }]}
          onPress={() => openEntityDetail(entity, onClose, detailRoute)}
        >
          <Text style={s.ctaText}>View Event</Text>
          <ArrowRight size={15} color="#fff" />
        </Pressable>
      ) : null}
    </>
  );
}

function GemCard({
  entity,
  obj,
  onClose,
}: { entity: MapEntity; obj: MapObject; onClose: () => void }) {
  const cfg = MAP_LAYER_CONFIG.gems;
  const p = gemCardPayload(obj);
  const detailRoute = obj.interaction?.detailRoute ?? entity.detailRoute;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {p?.thumbnailUrl
            ? <DisplayMediaImage uri={p.thumbnailUrl} width={46} height={46} style={s.iconImg} fallbackIcon={<Sparkles size={20} color="#fff" />} fallbackBg={cfg.color} />
            : <Sparkles size={20} color="#fff" />}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{obj.title}</Text>
          {/* `subtitle` is the projector's "category · city" line. The card used
              to build its own from `gem.category.replace('_', ' ')`, which threw
              once `category` was no longer on the payload the producer emits. */}
          {obj.subtitle ? (
            <Text style={s.secondaryText} numberOfLines={1}>{obj.subtitle}</Text>
          ) : null}
        </View>
      </View>
      {detailRoute ? (
        <Pressable
          style={[s.cta, { backgroundColor: cfg.color }]}
          onPress={() => openEntityDetail(entity, onClose, detailRoute)}
        >
          <Text style={s.ctaText}>View Hidden Gem</Text>
          <ArrowRight size={15} color="#fff" />
        </Pressable>
      ) : null}
    </>
  );
}

function TripCard({
  entity,
  obj,
  onClose,
}: { entity: MapEntity; obj: MapObject; onClose: () => void }) {
  const cfg = MAP_LAYER_CONFIG.trips;
  const p = tripCardPayload(obj);
  const dateRange = [p?.startDate, p?.endDate]
    .filter((d): d is string => !!d)
    .map((d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    .join(' – ');
  const where = p?.destinationCity
    ? `${p.destinationCity}${p.destinationCountry ? `, ${p.destinationCountry}` : ''}`
    : null;
  const detailRoute = obj.interaction?.detailRoute ?? entity.detailRoute;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {p?.coverUrl
            ? <DisplayMediaImage uri={p.coverUrl} width={46} height={46} style={s.iconImg} fallbackIcon={<Plane size={20} color="#fff" />} fallbackBg={cfg.color} />
            : <Plane size={20} color="#fff" />}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{obj.title}</Text>
          {where ? (
            <Text style={s.secondaryText} numberOfLines={1}>{where}</Text>
          ) : null}
        </View>
      </View>
      <View style={s.chipRow}>
        {dateRange ? (
          <View style={s.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={s.chipText}>{dateRange}</Text>
          </View>
        ) : null}
        {/* No `.replace('_', ' ')`: no TripVisibility member is underscored, and
            the call threw outright once `visibility` was no longer on the
            payload the producer emits. */}
        {p?.visibility ? (
          <View style={s.chip}>
            <Text style={s.chipText}>{p.visibility}</Text>
          </View>
        ) : null}
      </View>
      {detailRoute ? (
        <Pressable
          style={[s.cta, { backgroundColor: cfg.color }]}
          onPress={() => openEntityDetail(entity, onClose, detailRoute)}
        >
          <Text style={s.ctaText}>View Trip</Text>
          <ArrowRight size={15} color="#fff" />
        </Pressable>
      ) : null}
    </>
  );
}

function FriendCard({ obj, onClose }: { obj: MapObject; onClose: () => void }) {
  const cfg = MAP_LAYER_CONFIG.friends;
  const p = friendCardPayload(obj);
  const locationLabel = p?.city ?? 'Area location shared';
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.avatarWrap, { borderColor: cfg.color }]}>
          {p?.avatarUrl
            ? <AvatarImage uri={p.avatarUrl} user={{ displayName: obj.title }} size={44} style={s.avatarImg} bg={cfg.color} />
            : (
              <View style={[s.avatarFallback, { backgroundColor: cfg.color }]}>
                <Heart size={16} color="#fff" />
              </View>
            )}
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={1}>{obj.title}</Text>
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
      {p ? (
        <Pressable
          style={[s.cta, { backgroundColor: cfg.color }]}
          onPress={async () => {
            onClose();
            // Resolve the direct thread first — /messages/[id] takes a THREAD id, not a user id.
            const res = await openDirectThread(p.userId);
            if (res.ok && res.data?.threadId) {
              // Defer past the sheet's close animation — see closeThenNavigate for why.
              setTimeout(() => router.push(`/messages/${res.data!.threadId}?threadType=direct&otherUserId=${encodeURIComponent(p.userId)}` as any), 320);
            } else {
              Alert.alert('Could not open conversation', 'Please try again.');
            }
          }}
        >
          <Text style={s.ctaText}>Message</Text>
          <ArrowRight size={15} color="#fff" />
        </Pressable>
      ) : null}
    </>
  );
}

/**
 * Fallback body for a projected object whose kind has no card of its own.
 * Renders the two fields every MapObject guarantees rather than nothing.
 */
function GenericObjectCard({
  entity,
  obj,
  onClose,
}: { entity: MapEntity; obj: MapObject; onClose: () => void }) {
  const detailRoute = obj.interaction?.detailRoute ?? entity.detailRoute;
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: color.haze }]}>
          <MapPin size={20} color={color.mute} />
        </View>
        <View style={s.topText}>
          <Text style={s.primaryText} numberOfLines={2}>{obj.title}</Text>
          {obj.subtitle ? (
            <Text style={s.secondaryText} numberOfLines={1}>{obj.subtitle}</Text>
          ) : null}
        </View>
      </View>
      {detailRoute ? (
        <Pressable
          style={[s.cta, { backgroundColor: MAP_LAYER_CONFIG.places.color }]}
          onPress={() => openEntityDetail(entity, onClose, detailRoute)}
        >
          <Text style={s.ctaText}>View details</Text>
          <ArrowRight size={15} color="#fff" />
        </Pressable>
      ) : null}
    </>
  );
}

/**
 * The 'places' layer is built directly in app/map/index.tsx from a
 * `DiscoveryPlace` and never goes through a projector, so this is the one place
 * a card still reads a service DTO — behind a guard, and only for that layer.
 */
function discoveryPlaceOf(entity: MapEntity): DiscoveryPlace | null {
  const p = entity.payload;
  if (p == null || typeof p !== 'object') return null;
  return typeof (p as { name?: unknown }).name === 'string' ? (p as DiscoveryPlace) : null;
}

// ── Place card body ────────────────────────────────────────────────────────────

function PlaceCard({ entity, place, onClose }: { entity: MapEntity; place: DiscoveryPlace; onClose: () => void }) {
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
        onPress={() => openEntityDetail(entity, onClose, detailRoute)}
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
  payload,
  onClose,
}: {
  entity: MapEntity;
  payload: PassportCountryPayload;
  onClose: () => void;
}) {
  const { country, stampCount, cities } = payload;
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
        onPress={() => openEntityDetail(entity, onClose, `/passport/country/${encodeURIComponent(country)}`)}
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
    const obj = objectOf(entity);
    if (obj) {
      switch (obj.kind) {
        case 'buddy_zone':  return <BuddyCard entity={entity} obj={obj} onClose={onClose} />;
        case 'event':       return <EventCard entity={entity} obj={obj} onClose={onClose} />;
        case 'hidden_gem':  return <GemCard entity={entity} obj={obj} onClose={onClose} />;
        case 'trip_stop':   return <TripCard entity={entity} obj={obj} onClose={onClose} />;
        case 'crew_member': return <FriendCard obj={obj} onClose={onClose} />;
        default:            return <GenericObjectCard entity={entity} obj={obj} onClose={onClose} />;
      }
    }
    // The two producers that do not project.
    if (entity.type === 'stamps') {
      const stamp = passportCardPayload(entity.payload);
      return stamp
        ? <StampCountryCardBody entity={entity} payload={stamp} onClose={onClose} />
        : null;
    }
    if (entity.type === 'places') {
      const place = discoveryPlaceOf(entity);
      return place ? <PlaceCard entity={entity} place={place} onClose={onClose} /> : null;
    }
    return null;
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
