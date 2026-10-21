/**
 * TripOfflineTiles — the map half of the offline copy (Trips §18.1 "cached map
 * tiles where permitted", census-trips TR340), drawn inside TripOfflineCard.
 *
 * It packs the trip's area ONLY when the traveller refreshes the offline copy
 * (a newer `stored.storedAt` than the one it mounted with) — never on mount,
 * because a refresh of the pack deletes and re-downloads it. On mount it reads
 * how far the trip's pack has got. Every outcome, including "not permitted",
 * is said in one line; nothing about tiles can make the offline copy fail.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet } from 'react-native';

import { color, type as t } from '../../../theme/tokens.ts';
import { mayLoad, readDataSaverSetting } from '../../telegraph/hooks/useDataSaver.ts';
import type { StoredBundle } from './tripOffline.ts';
import {
  cacheTripTiles, describeTripTiles, tripTileStatus,
  type TripTileOutcome, type TripTileStatus, type TripTilePoint,
} from './tripOfflineTiles.ts';

/** Test seams — the real functions by default. */
export interface TripTileSeams {
  cacheTiles?: typeof cacheTripTiles;
  tileStatus?: typeof tripTileStatus;
  /** Whether bulk media may load on this device now (the data-saver ladder). */
  mediaAllowed?: () => Promise<boolean>;
}

async function deviceMediaAllowed(): Promise<boolean> {
  return mayLoad('media', await readDataSaverSetting());
}

interface Props extends TripTileSeams {
  tripId: string;
  stored: StoredBundle | null;
  destination?: { lat: number | null | undefined; lng: number | null | undefined } | null;
}

export function TripOfflineTiles({
  tripId, stored, destination = null,
  cacheTiles = cacheTripTiles, tileStatus = tripTileStatus, mediaAllowed = deviceMediaAllowed,
}: Props) {
  const [outcome, setOutcome] = useState<TripTileOutcome | null>(null);
  const [status, setStatus] = useState<TripTileStatus | null>(null);
  const mountedWith = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void tileStatus(tripId).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [tripId, tileStatus]);

  const storedAt = stored?.storedAt ?? null;
  useEffect(() => {
    if (mountedWith.current === undefined) { mountedWith.current = storedAt; return; }
    if (!stored || storedAt === mountedWith.current) return;
    mountedWith.current = storedAt;
    let cancelled = false;
    void (async () => {
      const allowed = await mediaAllowed().catch(() => false);
      const point: Partial<TripTilePoint> | null = destination && typeof destination.lat === 'number' && typeof destination.lng === 'number'
        ? { lat: destination.lat, lng: destination.lng } : null;
      const o = await cacheTiles(tripId, { destination: point, meetingPoints: stored.signed.bundle.contents.meetingPoints ?? [] }, { mediaAllowed: allowed });
      if (cancelled) return;
      setOutcome(o);
      if (o.state === 'cached') setStatus(await tileStatus(tripId).catch(() => null));
    })();
    return () => { cancelled = true; };
  }, [storedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const line = describeTripTiles(outcome, status);
  if (!line) return null;
  const warn = outcome?.state === 'failed' || outcome?.state === 'not_permitted';
  return <Text style={[s.detail, warn && { color: color.warn }]} testID="trip-offline-tiles">{line}</Text>;
}

const s = StyleSheet.create({
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
});
