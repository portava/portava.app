/**
 * Trip recap — /trip/:id/recap (HM-F15).
 *
 * `GET /trips/:tripId/memories/recap`, §18 TripMemoryProjection. The server
 * decides everything: accepted crew only, the trip owner's Memories that THIS
 * crew member may read (§23 canReadMemory "trip"), participants disclosed per
 * §10 and counted here, never named. Rows arrive in trip order.
 *
 * Three answers kept apart: not on this trip (not_found — nothing to retry),
 * could not build it (an error and a retry), and a trip with no memories yet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { firstParam } from '../../../src/lib/routeParams.ts';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../../src/theme/tokens.ts';
import { getTripMemoryRecap, type TripRecapRow } from '../../../src/services/memorySocial.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: TripRecapRow[] };

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function TripRecapRoute() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const tripId = firstParam(params.id);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    if (!tripId) { setState({ kind: 'unavailable' }); return; }
    setState({ kind: 'loading' });
    const res = await getTripMemoryRecap(tripId);
    if (res.ok) setState({ kind: 'ready', rows: res.rows });
    else if (res.kind === 'not_found') setState({ kind: 'unavailable' });
    else setState({ kind: 'error', message: res.message });
  }, [tripId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <View style={s.screen}>
      <View style={[s.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Trip recap</Text>
        <View style={s.spacer} />
      </View>
      {state.kind === 'loading' ? (
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      ) : state.kind === 'unavailable' ? (
        <View style={s.center} testID="trip-recap-unavailable">
          <Text style={s.strong}>No recap for you on this trip</Text>
          <Text style={s.body}>A trip recap is shared with the people who were on the trip.</Text>
        </View>
      ) : state.kind === 'error' ? (
        <View style={s.center}>
          <Text style={s.body}>{state.message}</Text>
          <Pressable onPress={load} style={s.retry} accessibilityRole="button" testID="trip-recap-retry"><Text style={s.retryText}>Try again</Text></Pressable>
        </View>
      ) : state.rows.length === 0 ? (
        <View style={s.center} testID="trip-recap-empty">
          <Text style={s.strong}>No memories from this trip yet</Text>
          <Text style={s.body}>Memories from this trip that you can see will appear here, in order.</Text>
        </View>
      ) : (
        <FlatList
          data={state.rows}
          keyExtractor={(r) => r.memory_id}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + space.xl }]}
          renderItem={({ item }) => {
            const people = item.people?.length ?? 0;
            const photos = item.media_count ?? 0;
            const place = [item.location_city, item.location_country].filter(Boolean).join(', ');
            const meta = [when(item.occurred_at), photos ? `${photos} photo${photos === 1 ? '' : 's'}` : null, people ? `with ${people} ${people === 1 ? 'person' : 'people'}` : null].filter(Boolean).join(' · ');
            return (
              <Pressable style={s.card} onPress={() => router.push(`/memory/${item.memory_id}` as never)} accessibilityRole="button" testID={`trip-recap-row-${item.memory_id}`}>
                <Text style={s.strong} numberOfLines={1}>{item.title || 'Untitled memory'}</Text>
                {place ? <Text style={s.body} numberOfLines={1}>{place}</Text> : null}
                {meta ? <Text style={s.caption}>{meta}</Text> : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.md },
  title: { ...(t.bodyStrong as object), color: color.ink },
  spacer: { width: 22 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  strong: { ...(t.bodyStrong as object), color: color.ink },
  body: { ...(t.body as object), color: color.mute, textAlign: 'center' },
  caption: { ...(t.small as object), color: color.mute },
  list: { padding: space.lg, gap: space.sm },
  card: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 2 },
  retry: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  retryText: { ...(t.bodyStrong as object), color: color.deep },
});
