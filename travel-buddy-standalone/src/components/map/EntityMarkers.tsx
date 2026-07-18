/**
 * EntityMarkers — marker components and grid-based clustering for all
 * non-traveler entity layers (Buddies, Events, Gems, Trips, Friends).
 *
 * Architecture mirrors TravelerMapLayer:
 *   - Generic `clusterEntities` pure fn — same 60-px-cell grid as travelers.
 *   - Per-type marker views (BuddyMarker, EventMarker, …).
 *   - `EntityMapLayers` — renders all enabled layers from a flat MapEntity[].
 *
 * Clustering rule: ≥ 3 entities of the same type in the same grid cell
 * collapse to a count bubble in the layer's accent colour.
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { Marker } from '@maplibre/maplibre-react-native';
import {
  Users,
  CalendarDays,
  Sparkles,
  Plane,
  Heart,
} from 'lucide-react-native';
import { MAP_LAYER_CONFIG } from '../../types/mapTypes.ts';
import type { MapEntity, MapEntityType, ToggleableEntityType } from '../../types/mapTypes.ts';
import type { BuddyProfile } from '../../services/rentABuddy.ts';
import type { EventListItem } from '../../services/events.ts';
import type { HiddenGem } from '../../services/hiddenGems.ts';
import type { TripRow } from '../../services/trips.ts';
import type { CircleMemberLocation } from '../../services/map.ts';

// ── Clustering ─────────────────────────────────────────────────────────────────

const MIN_CLUSTER = 3;

export interface EntityCluster {
  key: string;
  type: MapEntityType;
  lat: number;
  lng: number;
  items: MapEntity[];
}

/**
 * Groups entities of the same type into grid cells. Cells ≈ 60 screen px at
 * the current zoom so overlapping markers merge naturally.
 * Only collapses when ≥ MIN_CLUSTER items share a cell.
 */
export function clusterEntities(entities: MapEntity[], zoom: number): EntityCluster[] {
  const z = Math.max(1, Math.min(20, zoom));
  const cellDeg = (360 / Math.pow(2, z)) * (60 / 512);

  // Group by type + cell
  const buckets = new Map<string, MapEntity[]>();
  for (const e of entities) {
    const cellKey = `${e.type}:${Math.floor(e.lng / cellDeg)}:${Math.floor(e.lat / cellDeg)}`;
    const arr = buckets.get(cellKey);
    if (arr) arr.push(e);
    else buckets.set(cellKey, [e]);
  }

  const out: EntityCluster[] = [];
  for (const [key, items] of buckets) {
    const type = items[0].type;
    if (items.length < MIN_CLUSTER) {
      // Below threshold → individual markers
      for (const item of items) {
        out.push({ key: `${key}:${item.id}`, type, lat: item.lat, lng: item.lng, items: [item] });
      }
    } else {
      // Collapse to cluster bubble
      const lat = items.reduce((s, i) => s + i.lat, 0) / items.length;
      const lng = items.reduce((s, i) => s + i.lng, 0) / items.length;
      out.push({ key, type, lat, lng, items });
    }
  }
  return out;
}

// ── Cluster bubble (generic, per-type colour) ─────────────────────────────────

function ClusterBubble({
  count,
  type,
  onPress,
}: {
  count: number;
  type: MapEntityType;
  onPress: () => void;
}) {
  const cfg = MAP_LAYER_CONFIG[type];
  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <View style={[bubble.wrap, { backgroundColor: cfg.color }]}>
        <Text style={bubble.count}>{count}</Text>
      </View>
    </Pressable>
  );
}

const bubble = StyleSheet.create({
  wrap: {
    minWidth: 38,
    height: 38,
    borderRadius: 19,
    paddingHorizontal: 6,
    borderWidth: 2.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  count: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});

// ── Buddy marker ──────────────────────────────────────────────────────────────

function BuddyMarker({ entity, onPress }: { entity: MapEntity<BuddyProfile>; onPress: (e: MapEntity) => void }) {
  const cfg = MAP_LAYER_CONFIG.buddies;
  const buddy = entity.payload;
  return (
    <Pressable onPress={() => onPress(entity)} hitSlop={6}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        {buddy.coverPhotoUrl ? (
          <Image source={{ uri: buddy.coverPhotoUrl }} style={pin.avatarImg} />
        ) : (
          <Users size={12} color="#fff" />
        )}
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </Pressable>
  );
}

// ── Event marker ──────────────────────────────────────────────────────────────

function EventMarker({ entity, onPress }: { entity: MapEntity<EventListItem>; onPress: (e: MapEntity) => void }) {
  const cfg = MAP_LAYER_CONFIG.events;
  return (
    <Pressable onPress={() => onPress(entity)} hitSlop={6}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <CalendarDays size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </Pressable>
  );
}

// ── Gem marker ────────────────────────────────────────────────────────────────

function GemMarker({ entity, onPress }: { entity: MapEntity<HiddenGem>; onPress: (e: MapEntity) => void }) {
  const cfg = MAP_LAYER_CONFIG.gems;
  return (
    <Pressable onPress={() => onPress(entity)} hitSlop={6}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <Sparkles size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </Pressable>
  );
}

// ── Trip marker ───────────────────────────────────────────────────────────────

function TripMarker({ entity, onPress }: { entity: MapEntity<TripRow>; onPress: (e: MapEntity) => void }) {
  const cfg = MAP_LAYER_CONFIG.trips;
  return (
    <Pressable onPress={() => onPress(entity)} hitSlop={6}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <Plane size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </Pressable>
  );
}

// ── Friend marker ─────────────────────────────────────────────────────────────

function FriendMarker({ entity, onPress }: { entity: MapEntity<CircleMemberLocation>; onPress: (e: MapEntity) => void }) {
  const cfg = MAP_LAYER_CONFIG.friends;
  const loc = entity.payload;
  return (
    <Pressable onPress={() => onPress(entity)} hitSlop={6}>
      <View style={[pin.avatarWrap, { borderColor: cfg.color }]}>
        {loc.avatarUrl ? (
          <Image source={{ uri: loc.avatarUrl }} style={pin.friendImg} />
        ) : (
          <View style={[pin.friendFallback, { backgroundColor: cfg.color }]}>
            <Heart size={11} color="#fff" />
          </View>
        )}
      </View>
    </Pressable>
  );
}

const pin = StyleSheet.create({
  wrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    alignSelf: 'center',
    marginTop: -1,
    borderWidth: 1,
    borderColor: '#fff',
  },
  avatarImg: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  avatarWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  friendImg: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  friendFallback: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ── Render single marker by type ──────────────────────────────────────────────

function SingleMarker({ entity, onPress }: { entity: MapEntity; onPress: (e: MapEntity) => void }) {
  switch (entity.type) {
    case 'buddies':
      return <BuddyMarker entity={entity as MapEntity<BuddyProfile>} onPress={onPress} />;
    case 'events':
      return <EventMarker entity={entity as MapEntity<EventListItem>} onPress={onPress} />;
    case 'gems':
      return <GemMarker entity={entity as MapEntity<HiddenGem>} onPress={onPress} />;
    case 'trips':
      return <TripMarker entity={entity as MapEntity<TripRow>} onPress={onPress} />;
    case 'friends':
      return <FriendMarker entity={entity as MapEntity<CircleMemberLocation>} onPress={onPress} />;
    default:
      return null;
  }
}

// ── EntityMapLayers — main export ─────────────────────────────────────────────

export interface EntityMapLayersProps {
  entities: MapEntity[];
  enabledLayers: ToggleableEntityType[];
  zoom: number;
  onSelectEntity: (entity: MapEntity) => void;
  onPressCluster: (lat: number, lng: number, currentZoom: number) => void;
}

/**
 * Renders all entity type markers inside the MapLibre <Map> component.
 * Clusters entities of the same type when ≥ 3 appear in the same grid cell.
 */
export function EntityMapLayers({
  entities,
  enabledLayers,
  zoom,
  onSelectEntity,
  onPressCluster,
}: EntityMapLayersProps) {
  const filtered = useMemo(
    () => entities.filter((e) => enabledLayers.includes(e.type as ToggleableEntityType)),
    [entities, enabledLayers],
  );

  const clusters = useMemo(
    () => clusterEntities(filtered, Math.round(zoom * 2) / 2),
    [filtered, zoom],
  );

  return (
    <>
      {clusters.map((c) =>
        c.items.length === 1 ? (
          <Marker key={`ent-${c.items[0].id}`} lngLat={[c.lng, c.lat]}>
            <SingleMarker entity={c.items[0]} onPress={onSelectEntity} />
          </Marker>
        ) : (
          <Marker key={`entc-${c.key}`} lngLat={[c.lng, c.lat]}>
            <ClusterBubble
              count={c.items.length}
              type={c.type}
              onPress={() => onPressCluster(c.lat, c.lng, zoom)}
            />
          </Marker>
        ),
      )}
    </>
  );
}
