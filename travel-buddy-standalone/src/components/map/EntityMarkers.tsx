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
import React, { useMemo, useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import {
  Users,
  CalendarDays,
  Sparkles,
  Plane,
  Heart,
  Stamp,
  MapPin,
} from 'lucide-react-native';
import { MAP_LAYER_CONFIG } from '../../types/mapTypes.ts';
import type { MapEntity, MapEntityType, ToggleableEntityType } from '../../types/mapTypes.ts';
import {
  buddyCardPayload,
  friendCardPayload,
  objectOf,
  passportCardPayload,
} from '../../types/mapCardPayloads.ts';
import { avatar, dot } from '../../theme/tokens.ts';

/**
 * A `places` entity that came THROUGH the projection — its payload is a
 * gateway `place` MapObject (Map spec §19).
 *
 * Two other things share the legacy `places` entity type and must NOT be drawn
 * here: the legacy Discovery envelope (`payload` is a `DiscoveryPlace`), which
 * DiscoveryMapView's own pin loop already renders — drawing it again would
 * double every pin — and the zone/forecast kinds that `KIND_TO_ENTITY_TYPE`
 * folds onto `places` for want of a legacy layer, which ActivityZoneLayer draws
 * as polygons. Only the projected canonical place has no other renderer.
 */
export function isProjectedPlaceEntity(entity: MapEntity): boolean {
  return entity.type === 'places' && objectOf(entity)?.kind === 'place';
}

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
  selected = false,
}: {
  count: number;
  type: MapEntityType;
  onPress: () => void;
  /** True when this cluster contains the currently selected entity. */
  selected?: boolean;
}) {
  const cfg = MAP_LAYER_CONFIG[type];
  const body = (
    <Pressable onPress={onPress} hitSlop={6}>
      <View style={[bubble.wrap, { backgroundColor: cfg.color }]}>
        <Text style={bubble.count}>{count}</Text>
      </View>
    </Pressable>
  );
  // A selected entity can be INSIDE a cluster — it is still selected, and the
  // carousel is showing its card. Without this the highlight would vanish the
  // moment three entities collapsed, which is the zoom level where finding the
  // right pin matters most.
  if (!selected) return body;
  return (
    <View testID="entity-cluster-selected" style={[sel.ring, { borderColor: cfg.color }]}>
      {body}
    </View>
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

// ── The touch surface every marker shares ─────────────────────────────────────

/**
 * A long press on a marker, with the screen point it happened at.
 *
 * The point is what anchors the §25 menu under the finger. It is `pageX/pageY`
 * — window coordinates — because that is the frame the menu positions itself
 * in; the marker's own local coordinates would put the card at the top-left of
 * a 32 pt pin.
 */
export type MarkerLongPress = (entity: MapEntity, page: { x: number; y: number }) => void;

/**
 * The one Pressable behind every marker, so both gestures are wired once.
 *
 * WHY MARKERS NEED THEIR OWN LONG PRESS. `DiscoveryMapView` also listens for
 * MapLibre's map-level `onLongPress`, and that is what covers bare map and §6
 * zones (style layers, which take no RN touch). It cannot cover markers: a
 * `Marker` is a native view whose children are React Native views, so the
 * Pressable below claims the touch on start and the map's own gesture
 * recogniser never sees it. Without this a long press on a pin — the case §25's
 * `save`, `Add to Trip` and `report` rows exist for — would do nothing.
 *
 * WHY THE `didLongPress` REF. On this stack React Native fires `onPress` after
 * `onLongPress` for the same gesture, which is why the filter row in
 * `DiscoveryMapView` already carries this exact guard. Without it, long-pressing
 * a pin would also SELECT it, opening the carousel card and the §8 sheet behind
 * the menu that just opened over them.
 */
function MarkerTouch({
  entity,
  onPress,
  onLongPress,
  children,
}: {
  entity: MapEntity;
  onPress: (e: MapEntity) => void;
  onLongPress?: MarkerLongPress;
  children: React.ReactNode;
}) {
  const didLongPress = useRef(false);
  return (
    <Pressable
      testID={`entity-pin-${entity.id}`}
      hitSlop={6}
      onPress={() => {
        // Suppress the onPress that React Native fires after onLongPress.
        if (didLongPress.current) { didLongPress.current = false; return; }
        onPress(entity);
      }}
      onLongPress={
        onLongPress
          ? (e) => {
              didLongPress.current = true;
              const { pageX, pageY } = e.nativeEvent;
              onLongPress(entity, {
                x: Number.isFinite(pageX) ? pageX : 0,
                y: Number.isFinite(pageY) ? pageY : 0,
              });
            }
          : undefined
      }
    >
      {children}
    </Pressable>
  );
}

// ── Buddy marker ──────────────────────────────────────────────────────────────

function BuddyMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.buddies;
  // `entity.payload` is the projected MapObject, not a BuddyProfile — the cover
  // photo is one level deeper, on the payload the projector chose. This used to
  // read `entity.payload.coverPhotoUrl` behind an `as MapEntity<BuddyProfile>`
  // cast at the dispatch site, so it was always undefined and every buddy pin
  // drew the generic glyph.
  const coverPhotoUrl = buddyCardPayload(objectOf(entity))?.coverPhotoUrl ?? null;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        {coverPhotoUrl ? (
          <CachedImage source={{ uri: coverPhotoUrl }} style={pin.avatarImg} fallbackLabel="" />
        ) : (
          <Users size={12} color="#fff" />
        )}
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </MarkerTouch>
  );
}

// ── Event marker ──────────────────────────────────────────────────────────────

function EventMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.events;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <CalendarDays size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </MarkerTouch>
  );
}

// ── Gem marker ────────────────────────────────────────────────────────────────

function GemMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.gems;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <Sparkles size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </MarkerTouch>
  );
}

// ── Place marker (projected canonical place) ─────────────────────────────────

/**
 * §6: "Standard marker | Place". Drawn ONLY for a projected place — see
 * isProjectedPlaceEntity. It reads nothing off the payload: a place pin is
 * identity + position, and every live axis (§7) is the Live Place sheet's to
 * show, with its freshness and confidence beside it, not a glyph's to imply.
 */
function PlaceMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.places;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View testID="entity-pin-place" style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <MapPin size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </MarkerTouch>
  );
}

// ── Trip marker ───────────────────────────────────────────────────────────────

function TripMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.trips;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <Plane size={12} color="#fff" />
      </View>
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </MarkerTouch>
  );
}

// ── Friend marker ─────────────────────────────────────────────────────────────

function FriendMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.friends;
  // Same shape as BuddyMarker: the avatar is on the projected payload, not on
  // the envelope. An avatar is the whole point of a friend pin — §23 puts these
  // at `approximate`, the rung where mayRenderIdentity() permits a face — so
  // this read being silently undefined blanked exactly the thing that matters.
  const avatarUrl = friendCardPayload(objectOf(entity))?.avatarUrl ?? null;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View style={[pin.avatarWrap, { borderColor: cfg.color }]}>
        {avatarUrl ? (
          <CachedImage source={{ uri: avatarUrl }} style={pin.friendImg} fallbackLabel="" />
        ) : (
          <View style={[pin.friendFallback, { backgroundColor: cfg.color }]}>
            <Heart size={11} color="#fff" />
          </View>
        )}
      </View>
    </MarkerTouch>
  );
}

const pin = StyleSheet.create({
  wrap: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
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
    width: dot.s6,
    height: dot.s6,
    borderRadius: dot.s6 / 2,
    alignSelf: 'center',
    marginTop: -1,
    borderWidth: 1,
    borderColor: '#fff',
  },
  avatarImg: {
    width: avatar.s28, height: avatar.s28,
    borderRadius: avatar.s28 / 2,
  },
  avatarWrap: {
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
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
    width: avatar.s30, height: avatar.s30,
    borderRadius: avatar.s30 / 2,
  },
  friendFallback: {
    width: avatar.s30, height: avatar.s30,
    borderRadius: avatar.s30 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Stamp count badge — sits top-right of the stamp pin circle
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  // Wider offset for double-digit counts (10–99) so the badge clears the pin icon
  badgeDouble: {
    minWidth: 20,
    right: -10,
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
});

// ── Stamp marker (passport mode) ──────────────────────────────────────────────

function StampMarker({ entity, onPress, onLongPress }: { entity: MapEntity; onPress: (e: MapEntity) => void; onLongPress?: MarkerLongPress }) {
  const cfg = MAP_LAYER_CONFIG.stamps;
  // Passport pins are NOT projected — buildPassportEntities in app/map/index.tsx
  // builds this payload directly — so this one is read through its own guard.
  const stampCount = passportCardPayload(entity.payload)?.stampCount ?? 0;
  const isDouble = stampCount >= 10;
  return (
    <MarkerTouch entity={entity} onPress={onPress} onLongPress={onLongPress}>
      <View style={[pin.wrap, { backgroundColor: cfg.color }]}>
        <Stamp size={12} color="#fff" />
      </View>
      {stampCount > 1 && (
        <View
          style={[
            pin.badge,
            { backgroundColor: cfg.color },
            isDouble && pin.badgeDouble,
          ]}
        >
          <Text style={pin.badgeText}>{stampCount}</Text>
        </View>
      )}
      <View style={[pin.dot, { backgroundColor: cfg.color }]} />
    </MarkerTouch>
  );
}

// ── Render single marker by type ──────────────────────────────────────────────

/**
 * Selection ring.
 *
 * Applied in SingleMarker rather than inside each of the six marker components
 * so "selected" is one decision in one place. Every marker type gets the same
 * affordance, and a seventh marker added later inherits it without being told.
 *
 * The ring is a real visual change — a halo and an accent-coloured border in
 * the layer's own colour — not a testID. A selected pin has to be findable on a
 * map full of pins, and the colour ties it to the carousel card below it.
 */
const sel = StyleSheet.create({
  ring: {
    padding: 3,
    borderRadius: 999,
    borderWidth: 2,
    backgroundColor: 'rgba(255,255,255,0.6)',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 7,
  },
});

function SingleMarker({
  entity,
  onPress,
  onLongPress,
  selected = false,
}: {
  entity: MapEntity;
  onPress: (e: MapEntity) => void;
  /** §25 long-press. Omitted ⇒ the marker keeps tap-only behaviour. */
  onLongPress?: MarkerLongPress;
  /** True when this entity is the one the carousel card is showing. */
  selected?: boolean;
}) {
  const inner = renderMarkerBody(entity, onPress, onLongPress);
  if (!selected) return inner;
  return (
    <View
      testID="entity-pin-selected"
      style={[sel.ring, { borderColor: MAP_LAYER_CONFIG[entity.type].color }]}
    >
      {inner}
    </View>
  );
}

function renderMarkerBody(
  entity: MapEntity,
  onPress: (e: MapEntity) => void,
  onLongPress?: MarkerLongPress,
) {
  const t = { onPress, onLongPress };
  switch (entity.type) {
    case 'buddies':
      return <BuddyMarker entity={entity} {...t} />;
    case 'events':
      return <EventMarker entity={entity} {...t} />;
    case 'gems':
      return <GemMarker entity={entity} {...t} />;
    case 'trips':
      return <TripMarker entity={entity} {...t} />;
    case 'friends':
      return <FriendMarker entity={entity} {...t} />;
    case 'stamps':
      return <StampMarker entity={entity} {...t} />;
    case 'places':
      // Projected places only. The legacy Discovery envelope keeps its own
      // renderer in DiscoveryMapView, and zone kinds keep ActivityZoneLayer.
      return isProjectedPlaceEntity(entity) ? <PlaceMarker entity={entity} {...t} /> : null;
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
  /**
   * The entity the carousel card is currently showing, from mapStore.
   *
   * The store has held this value since the map screen was built and nothing on
   * the map ever read it, so selection existed as state and never as pixels —
   * tapping a pin moved the camera and the carousel but left every pin looking
   * identical.
   */
  selectedEntityId?: string | null;
  /**
   * §25 long-press on a single pin.
   *
   * Only single markers carry it. A CLUSTER deliberately does not: "Meet here"
   * or "Save location" against three collapsed entities has no subject, and the
   * cluster's own tap already does the useful thing — zoom in until they
   * separate, at which point each pin answers for itself.
   */
  onLongPressEntity?: MarkerLongPress;
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
  selectedEntityId = null,
  onLongPressEntity,
}: EntityMapLayersProps) {
  const filtered = useMemo(
    // 'stamps' is not a ToggleableEntityType (it's never user-toggled) but
    // must still render in passport mode — always pass it through.
    //
    // A PROJECTED place is not one either: its layer is §16's `relevant_places`,
    // and that decision has already been made upstream by the map shell's
    // layer pipeline (filterByLayers over the projected objects), which removes
    // the entity from `entities` when the layer is off. What reaches here has
    // been permitted; gating it on the legacy pin toggles would hide it behind
    // a switch that does not exist.
    () => entities.filter(
      (e) =>
        e.type === 'stamps' ||
        isProjectedPlaceEntity(e) ||
        enabledLayers.includes(e.type as ToggleableEntityType),
    ),
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
            <SingleMarker
              entity={c.items[0]}
              onPress={onSelectEntity}
              onLongPress={onLongPressEntity}
              selected={c.items[0].id === selectedEntityId}
            />
          </Marker>
        ) : (
          <Marker key={`entc-${c.key}`} lngLat={[c.lng, c.lat]}>
            <ClusterBubble
              count={c.items.length}
              type={c.type}
              selected={
                selectedEntityId != null && c.items.some((i) => i.id === selectedEntityId)
              }
              onPress={() => onPressCluster(c.lat, c.lng, zoom)}
            />
          </Marker>
        ),
      )}
    </>
  );
}
