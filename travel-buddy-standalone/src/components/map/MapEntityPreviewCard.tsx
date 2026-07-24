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
import { View, Text, Image, Pressable, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
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
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { MAP_LAYER_CONFIG } from '../../types/mapTypes.ts';
import type { MapEntity, PassportCountryPayload } from '../../types/mapTypes.ts';
import { MapEntityActionRow } from './MapEntityActionRow.tsx';
import type { BuddyProfile } from '../../services/rentABuddy.ts';
import type { EventListItem } from '../../services/events.ts';
import type { HiddenGem } from '../../services/hiddenGems.ts';
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
            ? <Image source={{ uri: buddy.coverPhotoUrl }} style={s.iconImg} />
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
        onPress={() => { onClose(); router.push(`/(rent-a-buddy)/buddy/${buddy.id}` as any); }}
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
  return (
    <>
      <View style={s.topRow}>
        <View style={[s.iconCircle, { backgroundColor: cfg.color }]}>
          {ev.coverUrl
            ? <Image source={{ uri: ev.coverUrl }} style={s.iconImg} />
            : <CalendarDays size={20} color="#fff" />}
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
      </View>
      <Pressable
        style={[s.cta, { backgroundColor: cfg.color }]}
        onPress={() => { onClose(); router.push(`/event/${ev.id}` as any); }}
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
          <Sparkles size={20} color="#fff" />
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
        onPress={() => { onClose(); router.push(`/gems/${gem.id}` as any); }}
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
            ? <Image source={{ uri: trip.coverUrl }} style={s.iconImg} />
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
        onPress={() => { onClose(); router.push(`/trip/${trip.id}` as any); }}
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
            ? <Image source={{ uri: loc.avatarUrl }} style={s.avatarImg} />
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
            router.push(`/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(loc.userId)}` as any);
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

// ── Stamp card body ────────────────────────────────────────────────────────────

function StampCountryCardBody({ entity }: { entity: MapEntity<PassportCountryPayload> }) {
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
        return <StampCountryCardBody entity={entity as MapEntity<PassportCountryPayload>} />;
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
    width: 26,
    height: 26,
    borderRadius: 13,
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
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  iconImg: {
    width: 46,
    height: 46,
    borderRadius: 23,
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
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    flexShrink: 0,
  },
  avatarImg: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarFallback: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
});
