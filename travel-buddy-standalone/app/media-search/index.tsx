/**
 * /media-search — the §4 / §38 Media Search screen (census-media §19).
 *
 * ADDITIVE: reached from the World shell header's Search affordance, from the
 * contextual viewer's "Where was this taken?" (a `mediaId` deep link), and by
 * deep link. Params: `q`, `scope` (all | me | trip), `tripId`, `mediaId`, and `nearPlaceId` (+ `nearPlaceName`) for a search opened from a place.
 * The viewer's coarse city is OFFERED as a "Near <city>" filter, never applied
 * silently.
 */
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import { color } from '../../src/theme/tokens.ts';
import { useActiveLocation } from '../../src/hooks/useActiveLocation.ts';
import { MediaSearchScreen } from '../../src/features/media/screens/MediaSearchScreen.tsx';
import type { MediaSearchScope } from '../../src/features/media/state/mediaFilterStore.ts';

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

export default function MediaSearchRoute() {
  const params = useLocalSearchParams<{ q?: string; scope?: string; tripId?: string; mediaId?: string; nearPlaceId?: string; nearPlaceName?: string }>();
  const { locationState } = useActiveLocation();
  const scopeParam = one(params.scope);
  const scope: MediaSearchScope = scopeParam === 'me' || scopeParam === 'trip' ? scopeParam : 'all';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style="light" />
      <View style={styles.body}>
        <MediaSearchScreen
          initialScope={scope}
          tripId={one(params.tripId)}
          mediaId={one(params.mediaId)}
          initialQuery={one(params.q) ?? ''}
          nearCity={locationState.place?.city ?? null} viewerPoint={viewerPointFrom(locationState)} nearPlace={nearPlaceFrom(params)}
          onOpenMedia={(m) => router.push(`/media-viewer/${encodeURIComponent(m.id)}` as never)}
          onOpenPlace={(placeId) => router.push(`/place/${encodeURIComponent(placeId)}` as never)}
          onOpenGem={(gemId) => router.push(`/gems/${encodeURIComponent(gemId)}` as never)}
          onOpenExperience={(x) =>
            router.push(`/media-world?lens=experiences&experienceId=${encodeURIComponent(x.id)}` as never)
          }
          onOpenPerson={(p) => {
            if (p.username) router.push(`/u/${encodeURIComponent(p.username)}` as never);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ink },
  body: { flex: 1 },
});

// ── census-media §29 (MD288) — appended at the TAIL so no line cited above moves ──

/**
 * §38 "near X": the viewer's point for "Near me". It is the SAME point
 * /media-world hands the World shell and its Media Map (that route's
 * `locationState.ok ? locationState.coords : null`), read from this route's
 * existing useActiveLocation call. No new location read, no permission, and the
 * point is never put in a URL.
 */
function viewerPointFrom(locationState: ReturnType<typeof useActiveLocation>['locationState']): { lat: number; lng: number } | null {
  return locationState.ok && locationState.coords ? { lat: locationState.coords.lat, lng: locationState.coords.lng } : null;
}

/** A search opened from a place: its canonical id, and its name for the chip. */
function nearPlaceFrom(params: { nearPlaceId?: string | string[]; nearPlaceName?: string | string[] }): { id: string; label: string | null } | null {
  const id = one(params.nearPlaceId);
  return id ? { id, label: one(params.nearPlaceName) } : null;
}
