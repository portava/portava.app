/**
 * TripMapLayersCard — §14.1's projection, said in words.
 *
 * WHY THIS IS NOT A MAP
 * =====================
 * The map surface has its own gateway, its own layer-toggle contract and its
 * own census. Adding a stage layer to it is Map-lane work. What §14.1 is
 * about, and what census-trips TR254 says is missing, is the PROJECTION: a
 * versioned, generated-at description of what the trip puts on a map, whose
 * layers each say whether they were read.
 *
 * So this card renders the projection's SHAPE rather than its geometry: what
 * this trip has to show, what could not be read, and what has no producer.
 * That is the part a marker list could never carry, and it is the part a user
 * needs in order to know whether the map they are looking at is the whole
 * trip.
 *
 * THE THREE THINGS IT WILL NOT DO
 * ==============================
 *   It will not draw an unread layer as an absence. `unread` is named.
 *   It will not show private anchors. `allPoints` excludes them, and this card
 *     never reads `privateAnchors` — the count of them is not shown either,
 *     because on a small trip a count is a location.
 *   It will not present an unattributable projection as current. A projection
 *     with no `sourceTripVersion` says so.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Layers, CloudOff, AlertTriangle } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  fetchTripMapProjection, allPoints, unreadLayers, isAttributable, LAYER_LABEL,
  type ProjectionRead,
} from '../../services/tripMapProjection.ts';

interface Props {
  tripId: string;
  load?: typeof fetchTripMapProjection;
}

export function TripMapLayersCard({ tripId, load = fetchTripMapProjection }: Props) {
  const [read, setRead] = useState<ProjectionRead | undefined>(undefined);

  const run = useCallback(async () => {
    setRead(undefined);
    try {
      setRead(await load(tripId));
    } catch (e: any) {
      setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') });
    }
  }, [tripId, load]);

  useEffect(() => { void run(); }, [run]);

  if (read === undefined) {
    return (
      <View style={s.wrap} testID="trip-map-layers-loading">
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  if (read.state === 'off') return null;

  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-map-layers-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Map layers unavailable</Text>
            <Text style={s.detail}>
              We couldn&apos;t work out what this trip has on the map.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const p = read.projection;
  // Private anchors are excluded by allPoints, and their COUNT is not shown
  // either — on a two-stop trip, "1 private location" is close to naming it.
  const shown = allPoints(p).length;
  const missing = unreadLayers(p);

  // Read, and genuinely nothing to show, and nothing failed. The one honest
  // blank.
  if (shown === 0 && missing.length === 0) return null;

  return (
    <View style={[s.wrap, missing.length > 0 && s.wrapWarn]} testID="trip-map-layers-card">
      <View style={s.row}>
        <Layers size={14} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>
            {shown} thing{shown === 1 ? '' : 's'} on this trip&apos;s map
          </Text>
          {!isAttributable(p) && (
            // A projection with no version cannot be compared with another, so
            // it cannot be said to be up to date.
            <Text style={s.detail} testID="map-layers-unattributable">
              We couldn&apos;t confirm which version of the trip this reflects.
            </Text>
          )}
        </View>
      </View>

      {missing.length > 0 && (
        // The load-bearing line. Without it, a map missing its saved places
        // looks exactly like a trip with none saved.
        <View style={s.row} testID="trip-map-layers-unread">
          <AlertTriangle size={14} color={color.warn} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Some layers didn&apos;t load</Text>
            <Text style={s.detail}>
              {missing.map((k) => LAYER_LABEL[k]).join(', ')} could not be read, so the map is
              showing less than this trip has.
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, ...shadow.card,
    overflow: 'hidden', paddingVertical: space.sm,
  },
  wrapWarn: { borderColor: color.warn },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
});
