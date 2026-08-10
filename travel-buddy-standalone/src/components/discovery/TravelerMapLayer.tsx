/**
 * TravelerMapLayer — avatar markers + clustering for travelers who share
 * their location on the Discovery map.
 *
 * Visual language (deliberately distinct from place pins):
 *   - Place pins: 30px colored circles with white MapPin/Star icons.
 *   - Traveler markers: 38px WHITE-ringed avatar photos (or initials on a
 *     deep-teal disc when no avatar), with a small freshness dot.
 *   - Clusters: deep-teal count bubbles, tap to zoom in.
 *
 * Privacy: coordinates arriving here are already coarsened server-side
 * (city centroid or ~2km grid) — nothing precise is ever rendered.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import { color, avatar, dot } from '../../theme/tokens.ts';
import { primaryIdentityText } from '../../lib/displayIdentity.ts';
import type { MapTraveler } from '../../services/mapTravelers.ts';
import { useHydratedMedia } from '../../services/mediaUrl.ts';

// ── Clustering (pure, grid-based) ─────────────────────────────────────────────

export interface TravelerCluster {
  key: string;
  lat: number;
  lng: number;
  items: MapTraveler[];
}

/**
 * Grid clustering sized to the current zoom: cell ≈ 60 screen px, so markers
 * that would visually overlap merge into one bubble. Deterministic — no
 * marker jitter between renders at the same zoom.
 */
export function clusterTravelers(travelers: MapTraveler[], zoom: number): TravelerCluster[] {
  const z = Math.max(1, Math.min(20, zoom));
  const cellDeg = (360 / Math.pow(2, z)) * (60 / 512);
  const buckets = new Map<string, MapTraveler[]>();
  for (const t of travelers) {
    const key = `${Math.floor(t.lng / cellDeg)}:${Math.floor(t.lat / cellDeg)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(t);
    else buckets.set(key, [t]);
  }
  const out: TravelerCluster[] = [];
  for (const [key, items] of buckets) {
    if (items.length === 1) {
      out.push({ key, lat: items[0].lat, lng: items[0].lng, items });
      continue;
    }
    if (z < 15) {
      out.push({
        key,
        lat: items.reduce((s, t) => s + t.lat, 0) / items.length,
        lng: items.reduce((s, t) => s + t.lng, 0) / items.length,
        items,
      });
      continue;
    }
    // Fully zoomed in: fan stacked travelers into a deterministic ring so
    // city-precision users (who share one centroid) become individually
    // tappable instead of clustering forever. Sorted by id → stable layout.
    const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const ringR = cellDeg * 0.45;
    sorted.forEach((t, i) => {
      const ang = (2 * Math.PI * i) / sorted.length;
      out.push({
        key: `${key}:fan:${t.id}`,
        lat: t.lat + ringR * Math.sin(ang),
        lng: t.lng + ringR * Math.cos(ang),
        items: [t],
      });
    });
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function travelerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const FRESH_COLOR: Record<MapTraveler['freshness'], string> = {
  live: '#22C55E',
  recent: '#F59E0B',
};

// ── Marker views ──────────────────────────────────────────────────────────────

function TravelerAvatarMarker({ traveler, onPress }: {
  traveler: MapTraveler;
  onPress: (t: MapTraveler) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  // Route profile-media avatar URLs through the signed-URL hydration layer so
  // this map-marker surface stays functional when media_private_buckets_enabled
  // is toggled ON. The bare <Image> is kept as the render leaf to preserve the
  // freshDot overlay and the white-border ring that live in the same wrapper.
  const { resolved } = useHydratedMedia(traveler.avatarUrl && !imgFailed ? [traveler.avatarUrl] : []);
  const hydratedAvatarUrl = (traveler.avatarUrl && resolved[traveler.avatarUrl]) ?? traveler.avatarUrl;
  const showImage = !!hydratedAvatarUrl && !imgFailed;
  return (
    <Pressable onPress={() => onPress(traveler)} hitSlop={6}>
      <View style={m.avatarWrap}>
        {showImage ? (
          <Image
            source={{ uri: hydratedAvatarUrl as string }}
            style={m.avatarImg}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <View style={m.initialsDisc}>
            <Text style={m.initialsText}>{travelerInitials(primaryIdentityText({ displayName: traveler.displayName, handle: traveler.handle }).replace(/^@/, ''))}</Text>
          </View>
        )}
        <View style={[m.freshDot, { backgroundColor: FRESH_COLOR[traveler.freshness] }]} />
      </View>
    </Pressable>
  );
}

export function TravelerClusterMarkers({ travelers, zoom, onPressTraveler, onPressCluster }: {
  travelers: MapTraveler[];
  zoom: number;
  onPressTraveler: (t: MapTraveler) => void;
  onPressCluster: (cluster: TravelerCluster) => void;
}) {
  const clusters = useMemo(
    // Quantize zoom to halves so tiny camera drift doesn't re-bucket markers.
    () => clusterTravelers(travelers, Math.round(zoom * 2) / 2),
    [travelers, zoom],
  );

  return (
    <>
      {clusters.map((c) =>
        c.items.length === 1 ? (
          // c.lat/c.lng, not item coords — fanned positions differ from raw.
          <Marker key={`tv-${c.items[0].id}`} lngLat={[c.lng, c.lat]}>
            <TravelerAvatarMarker traveler={c.items[0]} onPress={onPressTraveler} />
          </Marker>
        ) : (
          <Marker key={`tvc-${c.key}`} lngLat={[c.lng, c.lat]}>
            <Pressable onPress={() => onPressCluster(c)} hitSlop={6}>
              <View style={m.clusterBubble}>
                <Text style={m.clusterCount}>{c.items.length}</Text>
              </View>
            </Pressable>
          </Marker>
        ),
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const m = StyleSheet.create({
  avatarWrap: {
    width: 38,
    height: 38,
  },
  avatarImg: {
    width: avatar.s38, height: avatar.s38,
    borderRadius: avatar.s38 / 2,
    borderWidth: 2.5,
    borderColor: '#fff',
    backgroundColor: color.haze,
  },
  initialsDisc: {
    width: avatar.s38, height: avatar.s38,
    borderRadius: avatar.s38 / 2,
    borderWidth: 2.5,
    borderColor: '#fff',
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialsText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  freshDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  clusterBubble: {
    minWidth: 40,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 6,
    backgroundColor: color.deep,
    borderWidth: 2.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  clusterCount: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});
