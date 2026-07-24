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
  Image,
  StyleSheet,
  Dimensions,
  AccessibilityInfo,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
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
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { useMapStore } from '../../stores/mapStore.tsx';
import type { PreviewDetent } from '../../stores/mapStore.tsx';
import { MAP_LAYER_CONFIG } from '../../types/mapTypes.ts';
import type { MapEntity, PassportCountryPayload } from '../../types/mapTypes.ts';
import type { BuddyProfile } from '../../services/rentABuddy.ts';
import type { EventListItem } from '../../services/events.ts';
import type { HiddenGem } from '../../services/hiddenGems.ts';
import type { TripRow } from '../../services/trips.ts';
import { openDirectThread } from '../../services/messaging.ts';
import type { CircleMemberLocation } from '../../services/map.ts';

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
 * Sized generously so all card types (regular entities, empty, error) fit.
 */
const CARD_AREA_HEIGHT = 164;
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

/** Extract a one-line display label from any entity type for the peek strip. */
function getEntityPeekLabel(entity: MapEntity | undefined): string {
  if (!entity) return 'Nearby';
  switch (entity.type) {
    case 'trips':   return (entity.payload as TripRow).title                 ?? 'Trip';
    case 'events':  return (entity.payload as EventListItem).title            ?? 'Event';
    case 'buddies': return (entity.payload as BuddyProfile).displayName       ?? 'Local Buddy';
    case 'gems':    return (entity.payload as HiddenGem).name                 ?? 'Gem';
    case 'friends': return (entity.payload as CircleMemberLocation).name      ?? 'Friend nearby';
    case 'stamps':  return (entity.payload as PassportCountryPayload).country ?? 'Country';
    default:        return 'Nearby';
  }
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

function BuddyCardBody({ entity }: { entity: MapEntity<BuddyProfile> }) {
  const buddy = entity.payload;
  const cfg = MAP_LAYER_CONFIG.buddies;
  const cats = buddy.categories?.slice(0, 2).join(' · ') ?? '';
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: cfg.color }]}>
          {buddy.coverPhotoUrl
            ? <Image source={{ uri: buddy.coverPhotoUrl }} style={cs.iconImg} />
            : <Users size={18} color="#fff" />}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>
            {buddy.displayName ?? 'Local Buddy'}
          </Text>
          {cats ? <Text style={cs.secondaryText} numberOfLines={1}>{cats}</Text> : null}
        </View>
      </View>
      <View style={cs.chipRow}>
        {buddy.averageRating != null && (
          <View style={cs.chip}>
            <Star size={10} color="#F59E0B" fill="#F59E0B" />
            <Text style={cs.chipText}>{buddy.averageRating.toFixed(1)}</Text>
          </View>
        )}
        {buddy.city ? (
          <View style={cs.chip}>
            <MapPin size={10} color={color.mute} />
            <Text style={cs.chipText} numberOfLines={1}>{buddy.city}</Text>
          </View>
        ) : null}
        {buddy.hourlyRateUsd != null && (
          <View style={cs.chip}>
            <Text style={cs.chipText}>${buddy.hourlyRateUsd}/hr</Text>
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

function EventCardBody({ entity }: { entity: MapEntity<EventListItem> }) {
  const ev = entity.payload;
  const now = Date.now();
  const startsAt = ev.startsAt ? new Date(ev.startsAt).getTime() : null;
  const endsAt = ev.endsAt ? new Date(ev.endsAt).getTime() : null;
  const isLive = startsAt != null && endsAt != null && now >= startsAt && now <= endsAt;
  const minutesLeft = endsAt != null && isLive ? Math.round((endsAt - now) / 60000) : null;

  const dateLabel = ev.startsAt
    ? new Date(ev.startsAt).toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
      })
    : null;

  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: MAP_LAYER_CONFIG.events.color }]}>
          {ev.coverUrl
            ? <Image source={{ uri: ev.coverUrl }} style={cs.iconImg} />
            : <CalendarDays size={18} color="#fff" />}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={2}>{ev.title}</Text>
          {ev.hostName ? <Text style={cs.secondaryText} numberOfLines={1}>by {ev.hostName}</Text> : null}
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
        {minutesLeft != null && (
          <View style={cs.chip}>
            <Text style={cs.chipText}>Ends in {minutesLeft}m</Text>
          </View>
        )}
        {ev.goingCount > 0 && (
          <View style={cs.chip}>
            <Users size={10} color={color.mute} />
            <Text style={cs.chipText}>{ev.goingCount} going</Text>
          </View>
        )}
        {ev.priceType === 'free' && (
          <View style={[cs.chip, cs.greenChip]}>
            <Text style={[cs.chipText, { color: color.success }]}>Free</Text>
          </View>
        )}
      </View>
    </>
  );
}

function GemCardBody({ entity }: { entity: MapEntity<HiddenGem> }) {
  const gem = entity.payload;
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: MAP_LAYER_CONFIG.gems.color }]}>
          <Sparkles size={18} color="#fff" />
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{gem.name}</Text>
          <Text style={cs.secondaryText} numberOfLines={1}>
            {gem.neighborhood ?? gem.city} · {gem.category.replace('_', ' ')}
          </Text>
        </View>
      </View>
      <View style={cs.chipRow}>
        {gem.vibeTags?.slice(0, 3).map((tag) => (
          <View key={tag} style={cs.chip}>
            <Text style={cs.chipText}>#{tag}</Text>
          </View>
        ))}
        {gem.saveCount != null && gem.saveCount > 0 && (
          <View style={cs.chip}>
            <Heart size={10} color={color.mute} />
            <Text style={cs.chipText}>{gem.saveCount}</Text>
          </View>
        )}
      </View>
    </>
  );
}

function TripCardBody({ entity }: { entity: MapEntity<TripRow> }) {
  const trip = entity.payload;
  const dateRange = [trip.startDate, trip.endDate]
    .filter(Boolean)
    .map((d) => new Date(d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    .join(' – ');
  const memberAvatars: string[] = (trip as any).memberAvatarUrls?.slice(0, 3) ?? [];
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.iconCircle, { backgroundColor: MAP_LAYER_CONFIG.trips.color }]}>
          {trip.coverUrl
            ? <Image source={{ uri: trip.coverUrl }} style={cs.iconImg} />
            : <Plane size={18} color="#fff" />}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{trip.title}</Text>
          <Text style={cs.secondaryText} numberOfLines={1}>
            {trip.destinationCity}{trip.destinationCountry ? `, ${trip.destinationCountry}` : ''}
          </Text>
        </View>
      </View>
      <View style={cs.chipRow}>
        {dateRange ? (
          <View style={cs.chip}>
            <CalendarDays size={10} color={color.mute} />
            <Text style={cs.chipText}>{dateRange}</Text>
          </View>
        ) : null}
        <View style={cs.chip}>
          <Text style={cs.chipText}>{trip.visibility.replace('_', ' ')}</Text>
        </View>
        {memberAvatars.length > 0 && (
          <View style={cs.memberAvatarsRow}>
            {memberAvatars.map((url, i) => (
              <Image
                key={i}
                source={{ uri: url }}
                style={[cs.memberAvatar, { marginLeft: i === 0 ? 0 : -8 }]}
              />
            ))}
          </View>
        )}
      </View>
    </>
  );
}

function FriendCardBody({ entity }: { entity: MapEntity<CircleMemberLocation> }) {
  const loc = entity.payload;
  const cfg = MAP_LAYER_CONFIG.friends;
  const displayName = loc.name ?? 'Circle member';
  const locationLabel = loc.city ?? 'Area location';
  return (
    <>
      <View style={cs.topRow}>
        <View style={[cs.avatarWrap, { borderColor: cfg.color }]}>
          {loc.avatarUrl
            ? <Image source={{ uri: loc.avatarUrl }} style={cs.avatarImg} />
            : (
              <View style={[cs.avatarFallback, { backgroundColor: cfg.color }]}>
                <Heart size={14} color="#fff" />
              </View>
            )}
        </View>
        <View style={cs.topText}>
          <Text style={cs.primaryText} numberOfLines={1}>{displayName}</Text>
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

function StampCardBody({ entity }: { entity: MapEntity<PassportCountryPayload> }) {
  const { country, stampCount, cities } = entity.payload;
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

// ── Full-detent extended entity detail ───────────────────────────────────────
//
// Shown only when previewDetent === 'full'. Surfaces description, extra stats,
// and address-like fields that are already present in the payload but don't
// fit in the medium card area. No new data fetching required.

function EntityFullDetail({ entity }: { entity: MapEntity }) {
  switch (entity.type) {
    case 'buddies': {
      const buddy = entity.payload as BuddyProfile;
      return (
        <View style={cs.fullDetail}>
          {buddy.bio ? (
            <Text style={cs.fullDetailText} numberOfLines={5}>{buddy.bio}</Text>
          ) : null}
          {buddy.languages.length > 0 && (
            <View style={cs.fullDetailRow}>
              <Text style={cs.fullDetailLabel}>Languages</Text>
              <Text style={cs.fullDetailValue}>{buddy.languages.join(', ')}</Text>
            </View>
          )}
          {buddy.responseTimeH != null && (
            <View style={cs.fullDetailRow}>
              <Text style={cs.fullDetailLabel}>Response time</Text>
              <Text style={cs.fullDetailValue}>~{buddy.responseTimeH}h</Text>
            </View>
          )}
          {buddy.country ? (
            <View style={cs.fullDetailRow}>
              <MapPin size={11} color={color.mute} />
              <Text style={cs.fullDetailValue}>{buddy.city}, {buddy.country}</Text>
            </View>
          ) : null}
        </View>
      );
    }
    case 'events': {
      const ev = entity.payload as EventListItem;
      const description = (ev as any).description as string | null | undefined;
      const address = (ev as any).address as string | null | undefined;
      if (!description && !address) return null;
      return (
        <View style={cs.fullDetail}>
          {description ? (
            <Text style={cs.fullDetailText} numberOfLines={5}>{description}</Text>
          ) : null}
          {address ? (
            <View style={cs.fullDetailRow}>
              <MapPin size={11} color={color.mute} />
              <Text style={cs.fullDetailValue}>{address}</Text>
            </View>
          ) : null}
        </View>
      );
    }
    case 'gems': {
      const gem = entity.payload as HiddenGem;
      return (
        <View style={cs.fullDetail}>
          {gem.description ? (
            <Text style={cs.fullDetailText} numberOfLines={5}>{gem.description}</Text>
          ) : null}
          {gem.bestTimeToGo ? (
            <View style={cs.fullDetailRow}>
              <Text style={cs.fullDetailLabel}>Best time</Text>
              <Text style={cs.fullDetailValue}>{gem.bestTimeToGo}</Text>
            </View>
          ) : null}
          {gem.priceRange ? (
            <View style={cs.fullDetailRow}>
              <Text style={cs.fullDetailLabel}>Price range</Text>
              <Text style={cs.fullDetailValue}>{gem.priceRange}</Text>
            </View>
          ) : null}
          {gem.neighborhood ? (
            <View style={cs.fullDetailRow}>
              <MapPin size={11} color={color.mute} />
              <Text style={cs.fullDetailValue}>{gem.neighborhood}, {gem.city}</Text>
            </View>
          ) : null}
        </View>
      );
    }
    case 'trips': {
      const trip = entity.payload as TripRow;
      const description = (trip as any).description as string | null | undefined;
      if (!description) return null;
      return (
        <View style={cs.fullDetail}>
          <Text style={cs.fullDetailText} numberOfLines={5}>{description}</Text>
        </View>
      );
    }
    default:
      return null;
  }
}

// ── Single animated card wrapper ──────────────────────────────────────────────

function MapEntityCard({
  entity,
  index,
  scrollX,
  onPress,
}: {
  entity: MapEntity;
  index: number;
  scrollX: SharedValue<number>;
  onPress: () => void;
}) {
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

  const renderBody = () => {
    switch (entity.type) {
      case 'buddies':
        return <BuddyCardBody entity={entity as MapEntity<BuddyProfile>} />;
      case 'events':
        return <EventCardBody entity={entity as MapEntity<EventListItem>} />;
      case 'gems':
        return <GemCardBody entity={entity as MapEntity<HiddenGem>} />;
      case 'trips':
        return <TripCardBody entity={entity as MapEntity<TripRow>} />;
      case 'friends':
        return <FriendCardBody entity={entity as MapEntity<CircleMemberLocation>} />;
      case 'stamps':
        return <StampCardBody entity={entity as MapEntity<PassportCountryPayload>} />;
      default:
        return null;
    }
  };

  const navigateToDetail = () => {
    switch (entity.type) {
      case 'buddies': {
        const b = entity.payload as BuddyProfile;
        router.push(`/(rent-a-buddy)/buddy/${b.id}` as any);
        break;
      }
      case 'events': {
        const ev = entity.payload as EventListItem;
        router.push(`/event/${ev.id}` as any);
        break;
      }
      case 'gems': {
        const gem = entity.payload as HiddenGem;
        router.push(`/gems/${gem.id}` as any);
        break;
      }
      case 'trips': {
        const trip = entity.payload as TripRow;
        router.push(`/trip/${trip.id}` as any);
        break;
      }
      case 'friends': {
        const loc = entity.payload as CircleMemberLocation;
        // Resolve the direct thread first — /messages/[id] takes a THREAD id, not a user id.
        void openDirectThread(loc.userId).then((res) => {
          if (res.ok && res.data?.threadId) {
            router.push(`/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(loc.userId)}` as any);
          }
        });
        break;
      }
      case 'stamps':
        // Passport tab handles its own navigation — tapping a country card
        // on the map just centres the camera (handled by the parent's
        // handleSelectEntity), so no deep-link is needed here.
        break;
    }
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
      </Pressable>
    </Animated.View>
  );
}

// ── MapCarousel public ref ────────────────────────────────────────────────────

export interface MapCarouselRef {
  scrollToIndex: (index: number) => void;
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
      scrollToIndex: (index: number) => {
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      },
    }));

    const scrollHandler = useAnimatedScrollHandler({
      onScroll: (event) => {
        scrollX.value = event.contentOffset.x;
      },
    });

    const handleMomentumScrollEnd = useCallback(
      (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetX = e.nativeEvent.contentOffset.x;
        const index = Math.round(offsetX / SNAP_INTERVAL);
        const clamped = Math.max(0, Math.min(index, entities.length - 1));
        if (clamped !== activeIndex) {
          onIndexChange(clamped);
        }
      },
      [entities.length, activeIndex, onIndexChange],
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
              onPress={() => {
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
          <EntityFullDetail entity={peekEntity} />
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
    width: 5,
    height: 5,
    borderRadius: 2.5,
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
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
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
    width: 44,
    height: 44,
    borderRadius: 22,
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
    width: 6,
    height: 6,
    borderRadius: 3,
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
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  iconImg: {
    width: 42,
    height: 42,
    borderRadius: 21,
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
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#DC2626',
  },
  statusChip: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.success,
  },
  // Trip member avatars
  memberAvatarsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 4,
  },
  memberAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: color.paperRaised,
  },
  // Friend avatar
  avatarWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    flexShrink: 0,
  },
  avatarImg: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
