/**
 * MapCarousel — horizontally swipeable card strip that floats above the
 * bottom safe area on the full-screen map screen.
 *
 * Bi-directional sync:
 *   Card → Map:  onMomentumScrollEnd reads activeIndex → calls onIndexChange,
 *               which the parent uses to call cameraRef.setCamera.
 *   Map → Card:  parent calls scrollToIndex (via forwarded ref) when a marker
 *               is tapped.
 *
 * Animation:
 *   Active card is full scale + full opacity; adjacent cards are 96% scale +
 *   80% opacity, interpolated from the scroll offset via Reanimated.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  FlatList,
  PanResponder,
  View,
  Text,
  Pressable,
  StyleSheet,
  Dimensions,
  AccessibilityInfo,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  type SharedValue,
} from 'react-native-reanimated';
import { router } from 'expo-router';
import {
  CalendarDays,
  ChevronUp,
  Users,
  MapPin,
  Star,
  Sparkles,
  Plane,
  Heart,
  SlidersHorizontal,
  Stamp,
  AlertTriangle,
  RefreshCw,
  X,
} from 'lucide-react-native';
import { StampIcon } from '../stamps/StampIcon.tsx';
import { color, space, radius, type as t, shadow, avatar, dot} from '../../theme/tokens.ts';
import { useMapStore } from '../../stores/mapStore.tsx';
import type { PreviewDetent } from '../../stores/mapStore.tsx';
import { MapEntityActionRow } from './MapEntityActionRow.tsx';
import { MAP_LAYER_CONFIG } from '../../types/mapTypes.ts';
import type { MapEntity, MapEntityType, PassportCountryPayload } from '../../types/mapTypes.ts';
import {
  isForecastKind,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../types/mapObjects.ts';
import {
  currentDecisionId,
  describeMapObject,
  distanceBucket,
  emitMapEvent,
  type MapObjectRef,
} from '../../features/map/telemetry/mapTelemetry.ts';
import { DisplayMediaImage, MediaFallback } from '../ui/DisplayMediaImage.tsx';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
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
import { useFsqPhoto } from '../../hooks/useFsqPhoto.ts';
import { resolveHeaderImage } from '../../lib/visuals/resolveHeaderImage.ts';
import type { HeaderCandidate } from '../../lib/visuals/resolveHeaderImage.ts';
import { fallbackUriFor } from '../../lib/visuals/fallbackAssets.ts';
import { AiRepresentationLabel } from '../visuals/AiRepresentationLabel.tsx';

// ── §35 telemetry ─────────────────────────────────────────────────────────────
//
// `describeMapObject` is the only sanctioned way to put an object into a §35
// payload; it takes a contract `MapObject`, so one is recovered from the legacy
// envelope first. See the fuller note in MapEntityActionRow.tsx — this copy
// exists because every candidate shared host is wholesale `jest.mock`ed by one
// of the existing component tests, and this lane may not add files.

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

function entityDistanceKm(entity: MapEntity): number | null {
  if (!isMapObject(entity.payload)) return null;
  const d = entity.payload.distanceKm;
  return typeof d === 'number' ? d : null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;
const CARD_WIDTH = SCREEN_WIDTH - 48; // 24px padding each side
const CARD_MARGIN = 8; // gap between cards
const SNAP_INTERVAL = CARD_WIDTH + CARD_MARGIN * 2;
const CARD_OFFSET = (SCREEN_WIDTH - CARD_WIDTH) / 2; // center first card

// ── Peek-strip / collapse / detent constants ───────────────────────────────────

/** Height of the always-visible peek strip (handle bar + entity label row). */
const PEEK_HEIGHT = 52;
/**
 * Maximum height of the scrollable card area below the peek strip.
 * Sized to accommodate the tallest possible card body + action row.
 *
 * Worst-case breakdown (buddy card, 2-row chip strip, Book + Message buttons):
 *   paddingTop 12 + type badge ~20 + gap 8 + topRow 42 + gap 8
 *   + chipRow ×2 rows 45 + (gap 8 + actionRow marginTop 4) + actionRow 33
 *   + paddingBottom 12  ≈ 192 px → rounded to 200 for headroom.
 */
const CARD_AREA_HEIGHT = 200;
/** Spring config — snappy with a subtle settle. */
const SPRING_CFG = { damping: 18, stiffness: 220, mass: 0.9 } as const;

/**
 * Total container height for each of the three detent positions.
 *
 *  collapsed — only the peek strip (handle + label row)
 *  medium    — peek strip + card carousel (current default)
 *  full      — peek strip + cards + extended entity detail (~72% of screen)
 */
const SCREEN_HEIGHT = Dimensions.get('window').height;
const DETENT_COLLAPSED_H = PEEK_HEIGHT;                        // 52 px
const DETENT_MEDIUM_H    = PEEK_HEIGHT + CARD_AREA_HEIGHT;    // 216 px
const DETENT_FULL_H      = Math.round(SCREEN_HEIGHT * 0.72);  // ≈ 600 px

function detentToHeight(d: PreviewDetent): number {
  if (d === 'collapsed') return DETENT_COLLAPSED_H;
  if (d === 'full')      return DETENT_FULL_H;
  return DETENT_MEDIUM_H;
}

// ── Animated FlatList ─────────────────────────────────────────────────────────

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<MapEntity>);

// ── Peek-strip helpers ────────────────────────────────────────────────────────

/**
 * One-line display label for the peek strip.
 *
 * Every projected object carries a non-empty `title` (isRenderable drops the
 * ones that don't), so there is nothing to reach into `payload` for. The two
 * producers that do not project — the places layer and passport mode — are
 * read through their own guards.
 */
function getEntityPeekLabel(entity: MapEntity | undefined): string {
  if (!entity) return 'Nearby';
  const obj = objectOf(entity);
  if (obj) return obj.title;
  if (entity.type === 'stamps') {
    return passportCardPayload(entity.payload)?.country ?? 'Country';
  }
  if (entity.type === 'places') {
    return discoveryPlaceOf(entity)?.name ?? 'Place';
  }
  return 'Nearby';
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

/**
 * Always-visible strip at the top of the carousel container.
 * Shows the active entity's type badge + title, a drag handle, and a
 * detent toggle button.
 *
 * Three-detent behaviour:
 *   collapsed → ChevronUp → medium
 *   medium    → ChevronUp → full   (strip tap also expands)
 *   full      → X         → medium
 *
 * Receives the PanResponder's panHandlers so dragging anywhere on the strip
 * triggers the spring snap — a tap (dy < threshold) passes through to the
 * inner Pressable.
 */
function PeekStrip({
  entity,
  detent,
  onMoveToDetent,
  panHandlers,
}: {
  entity: MapEntity | undefined;
  detent: PreviewDetent;
  onMoveToDetent: (d: PreviewDetent) => void;
  panHandlers: Record<string, unknown>;
}) {
  const label = getEntityPeekLabel(entity);
  const cfg = entity ? MAP_LAYER_CONFIG[entity.type] : null;
  const isAtFull = detent === 'full';
  const isAtCollapsed = detent === 'collapsed';

  return (
    <View style={cs.peekStrip} {...panHandlers}>
      {/* Drag handle bar — visual affordance for the gesture */}
      <View style={cs.handleBar} />

      {/* Label row — tapping when collapsed → medium */}
      <Pressable
        style={cs.peekRow}
        onPress={isAtCollapsed ? () => onMoveToDetent('medium') : undefined}
        accessibilityRole="button"
        accessibilityLabel={isAtCollapsed ? 'Expand map card' : undefined}
        accessibilityHint={isAtCollapsed ? 'Double-tap to expand' : undefined}
      >
        {cfg ? (
          <View style={[cs.peekBadge, { backgroundColor: cfg.color + '22' }]}>
            <View style={[cs.peekDot, { backgroundColor: cfg.color }]} />
            <Text style={[cs.peekBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        ) : null}
        <Text style={cs.peekTitle} numberOfLines={1}>{label}</Text>
        <View style={cs.peekSpacer} />
        {/* Toggle: X collapses from full → medium; ChevronUp expands to next detent */}
        <Pressable
          onPress={() => {
            if (isAtFull) onMoveToDetent('medium');
            else if (isAtCollapsed) onMoveToDetent('medium');
            else onMoveToDetent('full');
          }}
          hitSlop={10}
          style={cs.peekActionBtn}
          accessibilityRole="button"
          accessibilityLabel={isAtFull ? 'Collapse card' : 'Expand card'}
          testID="peek-detent-btn"
        >
          {isAtFull
            ? <X size={14} color={color.mute} />
            : <ChevronUp size={17} color={color.signal} />
          }
        </Pressable>
      </Pressable>
    </View>
  );
}

// ── Per-type mini card bodies ─────────────────────────────────────────────────

function BuddyCardBody({ obj }: { obj: MapObject }) {
  const cfg = MAP_LAYER_CONFIG.buddies;
  const p = buddyCardPayload(obj);
  const cats = (p?.categories ?? []).slice(0, 2).join(' · ');
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: cfg.color }]}>
          {p?.coverPhotoUrl
            ? <CachedImage source={{ uri: p.coverPhotoUrl }} style={cs.iconImg} fallbackLabel="" />
            : <Users size={18} color="#fff" />}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{obj.title}</Text>
          {cats ? <Text style={cs.secondaryText} numberOfLines={1}>{cats}</Text> : null}
        </View>
      </View>
      <View style={cs.chipRow}>
        {p?.averageRating != null && (
          <View style={cs.chip}>
            <Star size={10} color="#F59E0B" fill="#F59E0B" />
            <Text style={cs.chipText}>{p.averageRating.toFixed(1)}</Text>
          </View>
        )}
        {p?.city ? (
          <View style={cs.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={cs.chipText} numberOfLines={1}>{p.city}</Text>
          </View>
        ) : null}
        {p?.hourlyRateUsd != null && (
          <View style={cs.chip}>
            <Text style={cs.chipText}>${p.hourlyRateUsd}/hr</Text>
          </View>
        )}
        <View style={[cs.chip, cs.statusChip]}>
          <View style={cs.statusDot} />
          <Text style={[cs.chipText, { color: color.success }]}>Available</Text>
        </View>
      </View>
    </>
  );
}

function EventCardBody({ obj }: { obj: MapObject }) {
  const cfg = MAP_LAYER_CONFIG.events;
  const p = eventCardPayload(obj);

  // LIVE is the PROJECTOR's call (`hasStarted`, decided against its own clock)
  // bounded by the object's own `expiresAt`. The card used to recompute both
  // from raw start/end timestamps — spec §19: "The mobile client should not
  // independently reconstruct Portava intelligence rules."
  const endsAtMs = obj.expiresAt ? new Date(obj.expiresAt).getTime() : NaN;
  const now = Date.now();
  const isLive = p?.hasStarted === true && (!Number.isFinite(endsAtMs) || now <= endsAtMs);
  const minutesLeft =
    isLive && Number.isFinite(endsAtMs) ? Math.round((endsAtMs - now) / 60000) : null;

  const dateLabel = p?.startsAt
    ? new Date(p.startsAt).toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
      })
    : null;

  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: cfg.color }]}>
          <DisplayMediaImage
            uri={p?.coverUrl ?? null}
            width={46}
            height={46}
            style={cs.iconImg}
            fallbackIcon={<CalendarDays size={18} color="#fff" />}
            fallbackBg={cfg.color}
          />
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={2}>{obj.title}</Text>
          {p?.locationName ? (
            <Text style={cs.secondaryText} numberOfLines={1}>{p.locationName}</Text>
          ) : null}
        </View>
      </View>
      <View style={cs.chipRow}>
        {isLive ? (
          <View style={[cs.chip, cs.liveChip]}>
            <View style={cs.liveDot} />
            <Text style={[cs.chipText, { color: '#DC2626' }]}>LIVE</Text>
          </View>
        ) : dateLabel ? (
          <View style={cs.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={cs.chipText}>{dateLabel}</Text>
          </View>
        ) : null}
        {minutesLeft != null && minutesLeft >= 0 && (
          <View style={cs.chip}>
            <Text style={cs.chipText}>Ends in {minutesLeft}m</Text>
          </View>
        )}
      </View>
    </>
  );
}

function GemCardBody({ obj }: { obj: MapObject }) {
  const cfg = MAP_LAYER_CONFIG.gems;
  const p = gemCardPayload(obj);
  const verification = verificationLabel(p?.verificationLevel);
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: cfg.color }]}>
          {p?.thumbnailUrl
            ? <CachedImage source={{ uri: p.thumbnailUrl }} style={cs.iconImg} fallbackLabel="" />
            : <Sparkles size={18} color="#fff" />}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{obj.title}</Text>
          {obj.subtitle ? (
            <Text style={cs.secondaryText} numberOfLines={1}>{obj.subtitle}</Text>
          ) : null}
        </View>
      </View>
      {verification ? (
        <View style={cs.chipRow}>
          <View style={cs.chip}>
            <StampIcon size={10} color={color.mute} />
            <Text style={cs.chipText}>{verification}</Text>
          </View>
        </View>
      ) : null}
    </>
  );
}

/**
 * The gem's verification level in the product's own words. `unverified` gets no
 * chip at all rather than a chip that says so — an absent claim is not a claim.
 */
function verificationLabel(level: string | null | undefined): string | null {
  switch (level) {
    case 'community':    return 'Community verified';
    case 'guide':        return 'Guide verified';
    case 'gps_verified': return 'GPS verified';
    case 'admin':        return 'Portava verified';
    default:             return null;
  }
}

function TripCardBody({ obj }: { obj: MapObject }) {
  const cfg = MAP_LAYER_CONFIG.trips;
  const p = tripCardPayload(obj);
  const dateRange = [p?.startDate, p?.endDate]
    .filter((d): d is string => !!d)
    .map((d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    .join(' – ');
  const where = p?.destinationCity
    ? `${p.destinationCity}${p.destinationCountry ? `, ${p.destinationCountry}` : ''}`
    : null;
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: cfg.color }]}>
          {/* No cover image: `projectTrip` emits six fields and `coverUrl` is
              not among them, on either path. See
              docs/map-card-projection-gaps.md. */}
          <Plane size={18} color="#fff" />
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{obj.title}</Text>
          {where ? (
            <Text style={cs.secondaryText} numberOfLines={1}>{where}</Text>
          ) : null}
        </View>
      </View>
      <View style={cs.chipRow}>
        {dateRange ? (
          <View style={cs.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={cs.chipText}>{dateRange}</Text>
          </View>
        ) : null}
        {/* No `.replace('_', ' ')` here: TripVisibility has no underscored
            member, and the call used to throw outright once `payload` became a
            MapObject and `visibility` came back undefined. */}
        {p?.visibility ? (
          <View style={cs.chip}>
            <Text style={cs.chipText}>{p.visibility}</Text>
          </View>
        ) : null}
      </View>
    </>
  );
}

function FriendCardBody({ obj }: { obj: MapObject }) {
  const cfg = MAP_LAYER_CONFIG.friends;
  const p = friendCardPayload(obj);
  const locationLabel = p?.city ?? 'Area location';
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.avatarWrap, { borderColor: cfg.color }]}>
          {p?.avatarUrl
            ? <CachedImage source={{ uri: p.avatarUrl }} style={cs.avatarImg} fallbackLabel="" />
            : (
              <View style={[cs.avatarFallback, { backgroundColor: cfg.color }]}>
                <Heart size={14} color="#fff" />
              </View>
            )}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{obj.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <MapPin size={10} color={color.mute} />
            <Text style={cs.secondaryText} numberOfLines={1}>Near {locationLabel}</Text>
          </View>
        </View>
      </View>
      <View style={[cs.chip, { alignSelf: 'flex-start' }]}>
        <View style={[cs.statusDot, { backgroundColor: cfg.color }]} />
        <Text style={[cs.chipText, { color: cfg.color }]}>Open to meet</Text>
      </View>
    </>
  );
}

/**
 * Fallback body for a projected object whose kind has no card of its own
 * (a Compass result for a zone kind, an aggregated activity zone). Renders the
 * two fields every MapObject guarantees rather than nothing.
 */
function GenericObjectCardBody({ obj }: { obj: MapObject }) {
  return (
    <View style={cs.topRow}>
      <View style={[cs.iconCircle, { backgroundColor: color.haze }]}>
        <MapPin size={18} color={color.mute} />
      </View>
      <View style={cs.topText}>
        <Text style={cs.primaryText} numberOfLines={2}>{obj.title}</Text>
        {obj.subtitle ? (
          <Text style={cs.secondaryText} numberOfLines={1}>{obj.subtitle}</Text>
        ) : null}
      </View>
    </View>
  );
}

function PlaceCardBody({ place }: { place: DiscoveryPlace }) {
  // attribution may be an array (canonical place) or a single string / null (discovery place).
  const attributionList: string[] = Array.isArray((place as any).attribution)
    ? (place as any).attribution as string[]
    : [];
  // Category fallback — never show a plain MapPin icon; use themed emoji instead.
  const fallbackDesc = getPlaceCategoryFallback(place.category);
  // Specific sub-type label (e.g. "café") if available, otherwise category.
  const typeLabel = (place.type ?? place.category).replace(/_/g, ' ');
  // When AI-generated, fetch FSQ independently — a real photo can override the AI candidate.
  const _carouselHeaderSource = (place as any).headerImageSource as string | null | undefined;
  const _carouselFsqPassthrough = _carouselHeaderSource === 'ai_generated'
    ? undefined
    : ((place as any).headerImageUrl as string | undefined ?? undefined);
  const photoUrl = useFsqPhoto(place.name, place.lat, place.lng, _carouselFsqPassthrough);

  // Build candidates with real source metadata so isRepresentation is correct.
  const _carouselCandidates: HeaderCandidate[] = [];
  if ((place as any).headerImageUrl) {
    _carouselCandidates.push({
      url: (place as any).headerImageUrl as string,
      source: (_carouselHeaderSource as HeaderCandidate['source']) ?? 'provider',
    });
  }
  if (photoUrl && photoUrl !== (place as any).headerImageUrl) {
    _carouselCandidates.push({ url: photoUrl, source: 'provider' });
  }
  const resolvedCarousel = resolveHeaderImage(_carouselCandidates, {
    entityType: 'place',
    category: place.category,
    fallbackUrlFor: fallbackUriFor,
  });

  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: fallbackDesc.color + '22' }]}>
          <DisplayMediaImage
            uri={resolvedCarousel?.url ?? null}
            width={46}
            height={46}
            style={cs.iconImg}
            resizeMode="cover"
            alt={place.name}
            fallback={
              <MediaFallback
                icon={<Text style={cs.placeEmoji}>{fallbackDesc.emoji}</Text>}
                bg={fallbackDesc.color + '33'}
                style={cs.iconImg}
              />
            }
          />
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{place.name}</Text>
          {/* Specific place type label — never text-only */}
          <Text style={cs.secondaryText} numberOfLines={1}>{typeLabel}</Text>
        </View>
      </View>
      <View style={cs.chipRow}>
        {/* Address / neighborhood chip */}
        {(place.address || (place as any).neighborhood) ? (
          <View style={cs.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={cs.chipText} numberOfLines={1}>
              {(place as any).neighborhood ?? place.address}
            </Text>
          </View>
        ) : null}
        {place.rating != null && (
          <View style={cs.chip}>
            <Star size={10} color="#F59E0B" fill="#F59E0B" />
            <Text style={cs.chipText}>{place.rating.toFixed(1)}</Text>
          </View>
        )}
        {place.distanceKm != null && (
          <View style={cs.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={cs.chipText}>
              {place.distanceKm < 1
                ? `${Math.round(place.distanceKm * 1000)}m`
                : `${place.distanceKm}km`}
            </Text>
          </View>
        )}
      </View>
      {/* Attribution — canonical place sources (OSM / Foursquare etc.) */}
      {attributionList.length > 0 && (
        <View style={cs.attributionRow}>
          {attributionList.map((attr, i) => (
            <Text key={i} style={cs.attributionText}>{attr}</Text>
          ))}
        </View>
      )}
      {/* AI-generated representation disclosure */}
      {resolvedCarousel?.isRepresentation && (
        <AiRepresentationLabel testID={`map-carousel-ai-label-${place.id}`} />
      )}
    </>
  );
}

function StampCardBody({ payload }: { payload: PassportCountryPayload }) {
  const { country, stampCount, cities } = payload;
  const cfg = MAP_LAYER_CONFIG.stamps;
  const cityLabel = cities.slice(0, 3).join(' · ');
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: cfg.color }]}>
          <Stamp size={18} color="#fff" />
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{country}</Text>
          {cityLabel ? (
            <Text style={cs.secondaryText} numberOfLines={1}>{cityLabel}</Text>
          ) : null}
        </View>
      </View>
      <View style={cs.chipRow}>
        <View style={cs.chip}>
          <Stamp size={10} color={cfg.color} />
          <Text style={[cs.chipText, { color: cfg.color }]}>
            {stampCount} {stampCount === 1 ? 'stamp' : 'stamps'}
          </Text>
        </View>
        {cities.length > 0 && (
          <View style={cs.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={cs.chipText}>{cities.length} {cities.length === 1 ? 'city' : 'cities'}</Text>
          </View>
        )}
      </View>
    </>
  );
}

// ── Empty state card ──────────────────────────────────────────────────────────

function EmptyCard({ onFiltersPress }: { onFiltersPress?: () => void }) {
  return (
    <View style={[cs.card, cs.emptyCard]} accessibilityRole="text">
      <SlidersHorizontal size={22} color={color.mute} />
      <Text style={cs.emptyTitle}>No results nearby</Text>
      <Text style={cs.emptyBody}>Try adjusting your filters to see more entities on the map.</Text>
      {onFiltersPress && (
        <Pressable style={cs.emptyBtn} onPress={onFiltersPress}>
          <Text style={cs.emptyBtnText}>Adjust filters</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Passport loading placeholder card ─────────────────────────────────────────

function PassportLoadingCard() {
  return (
    <View style={[cs.card, cs.emptyCard]} accessibilityRole="text">
      <Stamp size={22} color={color.mute} />
      <Text style={cs.emptyTitle}>Loading your stamps…</Text>
      <Text style={cs.emptyBody}>Fetching your passport map, hang tight.</Text>
    </View>
  );
}

// ── Passport error card ───────────────────────────────────────────────────────

function PassportErrorCard({
  onRetry,
}: {
  onRetry?: () => void;
}) {
  return (
    <View style={[cs.card, cs.emptyCard]} accessibilityRole="text">
      <View style={cs.errorIconCircle}>
        <AlertTriangle size={20} color="#B45309" />
      </View>
      <Text style={cs.emptyTitle}>Couldn't load your stamps</Text>
      <Text style={cs.emptyBody}>
        There was a problem fetching your passport map. Check your connection and try again.
      </Text>
      {onRetry && (
        <Pressable
          style={cs.retryBtn}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading passport stamps"
        >
          <RefreshCw size={13} color="#fff" />
          <Text style={cs.emptyBtnText}>Tap to retry</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Places loading placeholder card ──────────────────────────────────────────

function PlacesLoadingCard() {
  return (
    <View style={[cs.card, cs.emptyCard]} accessibilityRole="text">
      <MapPin size={22} color={color.mute} />
      <Text style={cs.emptyTitle}>Loading places…</Text>
      <Text style={cs.emptyBody}>Finding places nearby, hang tight.</Text>
    </View>
  );
}

// ── Places error card ─────────────────────────────────────────────────────────

function PlacesErrorCard({ onRetry }: { onRetry?: () => void }) {
  return (
    <View style={[cs.card, cs.emptyCard]} accessibilityRole="text">
      <View style={cs.errorIconCircle}>
        <AlertTriangle size={20} color="#B45309" />
      </View>
      <Text style={cs.emptyTitle}>Couldn't load places</Text>
      <Text style={cs.emptyBody}>
        There was a problem fetching nearby places. Check your connection and try again.
      </Text>
      {onRetry && (
        <Pressable
          style={cs.retryBtn}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading places"
        >
          <RefreshCw size={13} color="#fff" />
          <Text style={cs.emptyBtnText}>Tap to retry</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Places empty card ─────────────────────────────────────────────────────────

function PlacesEmptyCard({ onRetry }: { onRetry?: () => void }) {
  return (
    <View style={[cs.card, cs.emptyCard]} accessibilityRole="text">
      <MapPin size={22} color={color.mute} />
      <Text style={cs.emptyTitle}>No places found nearby</Text>
      <Text style={cs.emptyBody}>
        We couldn't find any places in this area. Try a different location or category.
      </Text>
      {onRetry && (
        <Pressable
          style={cs.emptyBtn}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Refresh places"
        >
          <Text style={cs.emptyBtnText}>Refresh</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Full-detent extended entity detail ───────────────────────────────────────
//
// Shown only when previewDetent === 'full'. Surfaces description, extra stats,
// and address-like fields that are already present in the payload but don't
// fit in the medium card area. No new data fetching required.

function EntityFullDetail({
  entity,
  onBeforeNavigate,
  isRecommendation,
}: {
  entity: MapEntity;
  onBeforeNavigate?: () => void;
  /** §35: this card is an option of the active Compass decision. */
  isRecommendation?: boolean;
}) {
  // Extended content, built ONLY from fields the projection emits.
  //
  // Gem description / best-time / price-range and event description / address
  // used to be read here off the raw service DTO. Neither projector emits them,
  // so on the gateway path they were always undefined and the block rendered
  // nothing — see docs/map-card-projection-gaps.md for the full list and how to
  // restore each one. Trip notes are likewise not projected.
  const typeContent = (() => {
    const obj = objectOf(entity);
    if (!obj) return null;
    switch (obj.kind) {
      case 'buddy_zone': {
        const p = buddyCardPayload(obj);
        if (!p) return null;
        const where = p.city
          ? `${p.city}${p.country ? `, ${p.country}` : ''}`
          : p.country;
        return (
          <>
            {p.bio ? (
              <Text style={cs.fullDetailText} numberOfLines={5}>{p.bio}</Text>
            ) : null}
            {p.languages.length > 0 && (
              <View style={cs.fullDetailRow}>
                <Text style={cs.fullDetailLabel}>Languages</Text>
                <Text style={cs.fullDetailValue}>{p.languages.join(', ')}</Text>
              </View>
            )}
            {p.responseTimeH != null && (
              <View style={cs.fullDetailRow}>
                <Text style={cs.fullDetailLabel}>Response time</Text>
                <Text style={cs.fullDetailValue}>~{p.responseTimeH}h</Text>
              </View>
            )}
            {where ? (
              <View style={cs.fullDetailRow}>
                <MapPin size={11} color={color.mute} />
                <Text style={cs.fullDetailValue}>{where}</Text>
              </View>
            ) : null}
          </>
        );
      }
      case 'event': {
        const p = eventCardPayload(obj);
        if (!p?.locationName) return null;
        return (
          <View style={cs.fullDetailRow}>
            <MapPin size={11} color={color.mute} />
            <Text style={cs.fullDetailValue}>{p.locationName}</Text>
          </View>
        );
      }
      default:
        return null;
    }
  })();

  const caps = entity.actionCapabilities ?? [];
  const hasActions = caps.length > 0;

  // Nothing to show — skip rendering entirely.
  if (!typeContent && !hasActions) return null;

  return (
    <View style={cs.fullDetail}>
      {typeContent}
      {/* Primary action buttons — reuse MapEntityActionRow so handlers and
          visibility rules (permissions, caps) are consistent with the card row. */}
      <MapEntityActionRow
        entity={entity}
        onBeforeNavigate={onBeforeNavigate}
        isRecommendation={isRecommendation}
      />
    </View>
  );
}

// ── Single animated card wrapper ──────────────────────────────────────────────

export function MapEntityCard({
  entity,
  index,
  scrollX,
  onBeforeNavigate,
  onPress,
  isRecommendation,
}: {
  entity: MapEntity;
  index: number;
  scrollX: SharedValue<number>;
  /** Called before any detail push so the map screen can record the nav origin. */
  onBeforeNavigate?: () => void;
  onPress: () => void;
  /** §35: this card is an option of the active Compass decision. */
  isRecommendation?: boolean;
}) {
  const { setSelectedEntityId, previewDetent } = useMapStore();
  const isExpanded = previewDetent !== 'collapsed';

  const animStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SNAP_INTERVAL,
      index * SNAP_INTERVAL,
      (index + 1) * SNAP_INTERVAL,
    ];
    const scale = interpolate(
      scrollX.value,
      inputRange,
      [0.96, 1, 0.96],
      Extrapolation.CLAMP,
    );
    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.8, 1, 0.8],
      Extrapolation.CLAMP,
    );
    return { transform: [{ scale }], opacity };
  });

  const cfg = MAP_LAYER_CONFIG[entity.type];

  const obj = objectOf(entity);

  const renderBody = () => {
    if (obj) {
      switch (obj.kind) {
        case 'buddy_zone':  return <BuddyCardBody obj={obj} />;
        case 'event':       return <EventCardBody obj={obj} />;
        case 'hidden_gem':  return <GemCardBody obj={obj} />;
        case 'trip_stop':   return <TripCardBody obj={obj} />;
        case 'crew_member': return <FriendCardBody obj={obj} />;
        default:            return <GenericObjectCardBody obj={obj} />;
      }
    }
    // The two producers that do not project.
    if (entity.type === 'stamps') {
      const stamp = passportCardPayload(entity.payload);
      return stamp ? <StampCardBody payload={stamp} /> : null;
    }
    if (entity.type === 'places') {
      const place = discoveryPlaceOf(entity);
      return place ? <PlaceCardBody place={place} /> : null;
    }
    return null;
  };

  const navigateToDetail = () => {
    // Capture selectedEntityId in the store BEFORE pushing so that when the
    // user navigates back, useFocusEffect can restore the map to this entity.
    setSelectedEntityId(entity.id);

    // Friends are the one asynchronous case: /messages/[id] takes a THREAD id,
    // which has to be resolved from the user id first. onBeforeNavigate fires
    // only inside the callback, after the push is confirmed, so a failed lookup
    // never sets the back-nav flag when no push actually occurs.
    if (obj?.kind === 'crew_member') {
      const p = friendCardPayload(obj);
      if (!p) return;
      void openDirectThread(p.userId).then((res) => {
        if (res.ok && res.data?.threadId) {
          onBeforeNavigate?.();
          router.push(`/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(p.userId)}` as any);
        }
      });
      return;
    }

    if (entity.type === 'stamps') {
      onBeforeNavigate?.();
      router.push('/(tabs)/passport' as any);
      return;
    }

    // Every projector already built this card's detail route — the card used to
    // rebuild it from `payload.id`, which on a MapObject is the PREFIXED map id
    // (`gem:abc`), not the domain id the route expects.
    const route = obj?.interaction?.detailRoute ?? entity.detailRoute;
    if (!route) return;
    onBeforeNavigate?.();
    router.push(route as any);
  };

  const typeLabel = cfg.label;

  return (
    <Animated.View style={[cs.cardWrapper, animStyle]}>
      <Pressable
        style={cs.card}
        onPress={() => { onPress(); navigateToDetail(); }}
        accessibilityRole="button"
        accessibilityLabel={`${typeLabel} card. Double-tap to view details.`}
        accessibilityHint="Swipe left or right to browse nearby entities"
      >
        {/* Type badge */}
        <View style={[cs.typeBadge, { backgroundColor: cfg.color + '22' }]}>
          <View style={[cs.typeDot, { backgroundColor: cfg.color }]} />
          <Text style={[cs.typeLabel, { color: cfg.color }]}>{typeLabel}</Text>
        </View>
        {renderBody()}
        {isExpanded && (
          <MapEntityActionRow
            entity={entity}
            onBeforeNavigate={onBeforeNavigate}
            isRecommendation={isRecommendation}
          />
        )}
      </Pressable>
    </Animated.View>
  );
}

// ── MapCarousel public ref ────────────────────────────────────────────────────

export interface MapCarouselRef {
  /**
   * Scroll the FlatList to the given index.
   * @param index  - zero-based card index
   * @param animated - whether to animate the scroll (default true).
   *                   Pass false for instant restoration (e.g. back-navigation).
   */
  scrollToIndex: (index: number, animated?: boolean) => void;
}

// ── Main component ────────────────────────────────────────────────────────────

interface MapCarouselProps {
  entities: MapEntity[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
  onFiltersPress?: () => void;
  /** Passport mode: true while the getPassportMap fetch is in-flight. */
  passportLoading?: boolean;
  /** Passport mode: non-null when getPassportMap returned ok:false. */
  passportError?: string | null;
  /** Passport mode: called when the user taps "Retry". */
  onPassportRetry?: () => void;
  /** Places layer: true while the getDiscoveryPlaces fetch is in-flight. */
  placesLoading?: boolean;
  /** Places layer: non-null when getDiscoveryPlaces returned ok:false or threw. */
  placesError?: string | null;
  /** Places layer: true when the fetch succeeded but returned zero results. */
  placesEmpty?: boolean;
  /** Places layer: called when the user taps "Retry" or "Refresh". */
  onPlacesRetry?: () => void;
  /**
   * Called immediately before any card detail push (router.push). The map
   * screen uses this to distinguish a back-nav re-focus from a tab-switch
   * re-focus so it can decide whether to restore or clear selectedEntityId.
   */
  onBeforeNavigate?: () => void;
  /**
   * §35: true when `entities` is the result list of an active Compass ask.
   *
   * The map screen is the only place that knows this (it swaps
   * `compassOverrideEntities` in for the default entity list), and the carousel
   * cannot infer it: a decisionId stays active across the whole
   * accept → route → arrive → contribute loop, so "a decision is open" is NOT
   * the same claim as "these cards are that decision's options". Without this
   * flag `compass_option_selected` and `recommendation_accepted` are not
   * sourceable honestly, so they are simply not emitted.
   */
  compassResults?: boolean;
  style?: any;
}

export const MapCarousel = forwardRef<MapCarouselRef, MapCarouselProps>(
  function MapCarousel(
    {
      entities,
      activeIndex,
      onIndexChange,
      onFiltersPress,
      passportLoading,
      passportError,
      onPassportRetry,
      placesLoading,
      placesError,
      placesEmpty,
      onPlacesRetry,
      onBeforeNavigate,
      compassResults,
      style,
    },
    ref,
  ) {
    const flatListRef = useRef<FlatList<MapEntity>>(null);
    const scrollX = useSharedValue(0);

    // ── Store integration ────────────────────────────────────────────────────
    // previewDetent is the single source of truth for the sheet height tier.
    // Phase 2D (back-navigation) will call setPreviewDetent from outside to
    // restore state; Phase 2C (this file) is the only writer of the animation.
    const { previewDetent, setPreviewDetent } = useMapStore();

    // ── Reduce-motion detection ──────────────────────────────────────────────
    // Mirror the pattern used by StampEarnedToast: read once on mount and
    // subscribe to changes so runtime accessibility changes are respected.
    const reduceMotionRef = useRef(false);
    useEffect(() => {
      AccessibilityInfo.isReduceMotionEnabled().then((v) => {
        reduceMotionRef.current = v;
      });
      const sub = AccessibilityInfo.addEventListener(
        'reduceMotionChanged',
        (v) => { reduceMotionRef.current = v; },
      );
      return () => sub.remove();
    }, []);

    // ── Animated height ──────────────────────────────────────────────────────
    // Total container height (not card area) so overflow:hidden clips cleanly.
    const animHeight = useSharedValue(detentToHeight(previewDetent));

    // isMounted guard — skip the animation on the very first effect run since
    // animHeight is already initialised to the correct value.
    const isMountedRef = useRef(false);
    useEffect(() => {
      if (!isMountedRef.current) {
        isMountedRef.current = true;
        return;
      }
      const target = detentToHeight(previewDetent);
      if (reduceMotionRef.current) {
        animHeight.value = withTiming(target, { duration: 0 });
      } else {
        animHeight.value = withSpring(target, SPRING_CFG);
      }
      // animHeight and reduceMotionRef are stable Reanimated / React refs.
    }, [previewDetent]); // eslint-disable-line react-hooks/exhaustive-deps

    const containerAnimStyle = useAnimatedStyle(() => ({
      height: animHeight.value,
    }));

    // ── PanResponder (three-detent) ──────────────────────────────────────────
    // Uses refs so the stable PanResponder always sees the latest state without
    // being recreated on every render.
    const setPreviewDetentRef = useRef(setPreviewDetent);
    setPreviewDetentRef.current = setPreviewDetent;

    const currentDetentRef = useRef<PreviewDetent>(previewDetent);
    useEffect(() => { currentDetentRef.current = previewDetent; }, [previewDetent]);

    const panResponder = useRef(
      PanResponder.create({
        // Only claim the gesture if there's clear vertical intent.
        onStartShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 2,
        onMoveShouldSetPanResponder:  (_, g) => Math.abs(g.dy) > 5,
        onPanResponderRelease: (_, g) => {
          const curr = currentDetentRef.current;
          // Drag up past 30 px threshold → advance to next detent.
          if (g.dy < -30) {
            if (curr === 'collapsed') setPreviewDetentRef.current('medium');
            else if (curr === 'medium') setPreviewDetentRef.current('full');
          }
          // Drag down past 30 px threshold → step back to previous detent.
          else if (g.dy > 30) {
            if (curr === 'full') setPreviewDetentRef.current('medium');
            else if (curr === 'medium') setPreviewDetentRef.current('collapsed');
          }
        },
      }),
    ).current;

    useImperativeHandle(ref, () => ({
      scrollToIndex: (index: number, animated = true) => {
        flatListRef.current?.scrollToIndex({ index, animated, viewPosition: 0.5 });
      },
    }));

    const scrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        scrollX.value = event.contentOffset.x;
      },
    });

    // ── §35 selection telemetry ──────────────────────────────────────────────
    //
    // Fire-and-forget: this never blocks, reorders or gates the selection it
    // reports. `opened` distinguishes a TAP (which pushes the detail screen)
    // from a swipe that merely moves the selection — only a tap is treated as
    // choosing a Compass option or accepting a recommendation.
    const emitSelection = useCallback(
      (index: number, opened: boolean) => {
        const entity = entities[index];
        if (!entity) return;
        try {
          const kind = entityKind(entity);
          const isCompassOption = compassResults === true;

          if (TELEMETRY_ZONE_KINDS.includes(kind)) {
            emitMapEvent('zone_selected', {
              ref: entityTelemetryRef(entity),
              source: isCompassOption ? 'compass_pick' : 'marker',
              forecast: isForecastKind(kind),
            });
          } else {
            emitMapEvent('place_opened', {
              ref: entityTelemetryRef(entity),
              source: isCompassOption ? 'compass_pick' : 'marker',
              rank: index,
            });
          }

          if (!opened || !isCompassOption) return;

          const distanceKm = entityDistanceKm(entity);
          emitMapEvent('compass_option_selected', {
            ref: entityTelemetryRef(entity),
            optionIndex: index,
            optionCount: entities.length,
            ...(distanceKm != null ? { distance: distanceBucket(distanceKm) } : {}),
          });

          // Opening a pick is one of §35's acceptance routes. Gated on an
          // actually-live decision so a stale flag can never manufacture one.
          if (currentDecisionId() !== null) {
            emitMapEvent('recommendation_accepted', {
              ref: entityTelemetryRef(entity),
              via: 'open',
              optionIndex: index,
              optionCount: entities.length,
            });
          }
        } catch {
          // Deliberately swallowed.
        }
      },
      [entities, compassResults],
    );

    const handleMomentumScrollEnd = useCallback(
      (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetX = e.nativeEvent.contentOffset.x;
        const index = Math.round(offsetX / SNAP_INTERVAL);
        const clamped = Math.max(0, Math.min(index, entities.length - 1));
        if (clamped !== activeIndex) {
          emitSelection(clamped, false);
          onIndexChange(clamped);
        }
      },
      [entities.length, activeIndex, onIndexChange, emitSelection],
    );

    // Active entity for the peek strip label (falls back to first entity when
    // activeIndex is out of range).
    const peekEntity = entities[activeIndex] ?? entities[0];

    // Card-area content — same as before; empty/loading/error handled here.
    // Visible only when detent > collapsed (overflow:hidden clips the card area).
    const renderCardArea = () => {
      if (entities.length === 0) {
        if (passportLoading) return <PassportLoadingCard />;
        if (passportError)   return <PassportErrorCard onRetry={onPassportRetry} />;
        if (placesLoading)   return <PlacesLoadingCard />;
        if (placesError)     return <PlacesErrorCard onRetry={onPlacesRetry} />;
        if (placesEmpty)     return <PlacesEmptyCard onRetry={onPlacesRetry} />;
        return <EmptyCard onFiltersPress={onFiltersPress} />;
      }
      return (
        <AnimatedFlatList
          ref={flatListRef}
          data={entities}
          keyExtractor={(item) => item.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={SNAP_INTERVAL}
          snapToAlignment="center"
          decelerationRate="fast"
          contentContainerStyle={{
            paddingHorizontal: CARD_OFFSET - CARD_MARGIN,
          }}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          initialScrollIndex={activeIndex}
          getItemLayout={(_data, index) => ({
            length: SNAP_INTERVAL,
            offset: SNAP_INTERVAL * index,
            index,
          })}
          renderItem={({ item, index }) => (
            <MapEntityCard
              entity={item}
              index={index}
              scrollX={scrollX}
              onBeforeNavigate={onBeforeNavigate}
              isRecommendation={compassResults}
              onPress={() => {
                emitSelection(index, true);
                if (index !== activeIndex) onIndexChange(index);
              }}
            />
          )}
        />
      );
    };

    return (
      <Animated.View
        style={[cs.container, containerAnimStyle, style]}
        accessibilityRole="scrollbar"
      >
        {/* Always-visible peek strip — drag handle + entity label + detent toggle */}
        <PeekStrip
          entity={peekEntity}
          detent={previewDetent}
          onMoveToDetent={setPreviewDetent}
          panHandlers={panResponder.panHandlers as Record<string, unknown>}
        />
        {/* Card carousel — clipped to zero when collapsed via overflow:hidden */}
        {renderCardArea()}
        {/* Full-detent extended detail — only rendered in the full state */}
        {previewDetent === 'full' && peekEntity ? (
          <EntityFullDetail
            entity={peekEntity}
            onBeforeNavigate={onBeforeNavigate}
            isRecommendation={compassResults}
          />
        ) : null}
      </Animated.View>
    );
  },
);

// ── Styles ────────────────────────────────────────────────────────────────────

const cs = StyleSheet.create({
  container: {
    // Positioned by parent (absolute, bottom + safeArea).
    // overflow:'hidden' is required so the card area is clipped to zero height
    // when the carousel is collapsed — without it cards bleed below the container
    // on iOS (RN doesn't clip children by default).
    overflow: 'hidden',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },

  // ── Peek strip ──────────────────────────────────────────────────────────────
  peekStrip: {
    height: PEEK_HEIGHT,
    backgroundColor: color.paperRaised,
    paddingHorizontal: space.md,
    paddingTop: 6,
    paddingBottom: 2,
    gap: 4,
    justifyContent: 'center',
    // Thin rule at the bottom separates strip from card area when expanded.
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: 2,
  },
  peekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flex: 1,
    minHeight: 28,
  },
  peekBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
    flexShrink: 0,
  },
  peekDot: {
    width: dot.s5,
    height: dot.s5,
    borderRadius: dot.s5 / 2,
  },
  peekBadgeText: {
    fontSize: 9,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  peekTitle: {
    ...t.bodyStrong,
    fontSize: 13,
    color: color.ink,
    flex: 1,
  },
  peekSpacer: {
    width: space.sm,
  },
  peekActionBtn: {
    width: avatar.s28, height: avatar.s28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: avatar.s28 / 2,
    backgroundColor: color.haze,
    flexShrink: 0,
  },
  // ── End peek strip ──────────────────────────────────────────────────────────
  cardWrapper: {
    width: CARD_WIDTH,
    marginHorizontal: CARD_MARGIN,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
    ...shadow.card,
    elevation: 8,
  },
  // Empty state
  emptyCard: {
    width: CARD_WIDTH,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.xl,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
  },
  emptyBody: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 240,
  },
  emptyBtn: {
    marginTop: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  emptyBtnText: {
    ...t.bodyStrong,
    fontSize: 13,
    color: '#fff',
  },
  // Passport error card
  errorIconCircle: {
    width: avatar.s44, height: avatar.s44,
    borderRadius: avatar.s44 / 2,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtn: {
    marginTop: space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  // Type badge
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeDot: {
    width: dot.s6,
    height: dot.s6,
    borderRadius: dot.s6 / 2,
  },
  typeLabel: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // Card content
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  iconCircle: {
    width: avatar.s42, height: avatar.s42,
    borderRadius: avatar.s42 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  iconImg: {
    width: avatar.s42, height: avatar.s42,
    borderRadius: avatar.s42 / 2,
  },
  topText: {
    flex: 1,
    minWidth: 0,
  },
  primaryText: {
    ...t.bodyStrong,
    fontSize: 14,
    color: color.ink,
  },
  secondaryText: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
    marginTop: 1,
    textTransform: 'capitalize',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
    textTransform: 'capitalize',
  },
  greenChip: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  liveChip: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  liveDot: {
    width: dot.s6,
    height: dot.s6,
    borderRadius: dot.s6 / 2,
    backgroundColor: '#DC2626',
  },
  statusChip: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  statusDot: {
    width: dot.s6,
    height: dot.s6,
    borderRadius: dot.s6 / 2,
    backgroundColor: color.success,
  },
  // Trip member avatars
  memberAvatarsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 4,
  },
  // Sizing/shape come from <Avatar size>; this is the overlap ring only.
  memberAvatarRing: {
    borderWidth: 1.5,
    borderColor: color.paperRaised,
  },
  // Friend avatar
  avatarWrap: {
    width: avatar.s42, height: avatar.s42,
    borderRadius: avatar.s42 / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    flexShrink: 0,
  },
  avatarImg: {
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
  },
  avatarFallback: {
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Full-detent extended detail section ──────────────────────────────────────
  fullDetail: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.xs,
    backgroundColor: color.paperRaised,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  fullDetailText: {
    ...t.body,
    fontSize: 13,
    color: color.mute,
    lineHeight: 19,
  },
  fullDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // Place emoji in category fallback
  placeEmoji: {
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
  },
  // Place attribution footer (canonical place sources)
  attributionRow: {
    marginTop: 4,
    gap: 1,
  },
  attributionText: {
    fontSize: 9,
    color: color.faint,
    fontStyle: 'italic',
    lineHeight: 13,
  },

  fullDetailLabel: {
    ...t.small,
    fontSize: 11,
    fontWeight: '600' as const,
    color: color.mute,
    textTransform: 'capitalize' as const,
    minWidth: 80,
  },
  fullDetailValue: {
    ...t.small,
    fontSize: 12,
    color: color.ink,
    flex: 1,
  },
});
