/**
 * Discovery Trending — what is gaining travel relevance in a city now (owner
 * decision 2026-10-04: Trending is a user-facing feature; `11` §4; `03` §1).
 *
 * The four lists are the server's: popular now (by location), for you, emerging
 * (places AND Trails) and neighbourhoods (Local Pulse). Each row shows the
 * state and the server's own reason sentence and NOTHING ELSE — no count, no
 * score (`11` §4), and nothing the server withheld under Q12's floors.
 *
 * Switched off, the screen says Trending isn't available; a list with no
 * current run says why; a failed read says so with Retry. None of the three is
 * ever drawn as "nothing is trending".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { TrendingUp, MapPin, Route as RouteIcon } from 'lucide-react-native';

import { color, space } from '../../../theme/tokens.ts';
import { ds } from '../shared/discoveryStyles.ts';
import type { ApiRead } from '../shared/discoveryApi.ts';
import { usePlaceName, placeLabel, fetchPlaceName } from '../shared/placeNames.ts';
import {
  fetchTrending, unavailableCopy, trendingReadCopy, stateLabel, ACTION_LABEL, TRENDING_ACTIONS,
  type TrendingAction, type TrendingList,
} from './trendingApi.ts';

interface Props {
  initialDestination?: string | null;
  onNavigate: (href: string) => void;
  load?: typeof fetchTrending;
  loadPlaceName?: typeof fetchPlaceName;
}

export function TrendingView({ initialDestination = null, onNavigate, load = fetchTrending, loadPlaceName = fetchPlaceName }: Props) {
  const [destination, setDestination] = useState(initialDestination ?? '');
  const [shown, setShown] = useState(initialDestination ?? '');
  const [action, setAction] = useState<TrendingAction>('places');
  const [read, setRead] = useState<ApiRead<TrendingList> | undefined | null>(null);

  const run = useCallback(async (a: TrendingAction, d: string) => {
    if (!d.trim()) { setRead(null); return; }
    setRead(undefined);
    setRead(await load(a, d));
  }, [load]);

  useEffect(() => { void run(action, shown); }, [run, action, shown]);

  return (
    <ScrollView keyboardShouldPersistTaps="handled" testID="trending-view">
      <TextInput
        style={ds.input} value={destination} onChangeText={setDestination} placeholder="City"
        returnKeyType="search" onSubmitEditing={() => setShown(destination.trim())}
        accessibilityLabel="City to see what is trending in" testID="trending-destination"
      />
      <View style={ds.chips} accessibilityRole="tablist">
        {TRENDING_ACTIONS.map((a) => (
          <Pressable
            key={a} style={[ds.ghost, action === a && ds.ghostOn]} onPress={() => setAction(a)}
            accessibilityRole="tab" accessibilityState={{ selected: action === a }} testID={`trending-tab-${a}`}
          >
            <Text style={[ds.ghostText, action === a && ds.ghostTextOn]}>{ACTION_LABEL[a]}</Text>
          </Pressable>
        ))}
      </View>

      {read === null ? (
        <Text style={ds.notice} testID="trending-no-city">Choose a city to see what is trending there.</Text>
      ) : read === undefined ? (
        <ActivityIndicator style={{ margin: space.xl }} color={color.signal} testID="trending-loading" />
      ) : read.state !== 'ok' ? (
        <View testID={read.state === 'off' ? 'trending-off' : 'trending-unavailable'}>
          <Text style={ds.notice}>{trendingReadCopy(read)}</Text>
          {read.state === 'unavailable' ? (
            <Pressable onPress={() => { void run(action, shown); }} accessibilityRole="button" testID="trending-retry">
              <Text style={[ds.link, { textAlign: 'center' }]}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : read.data.unavailable ? (
        <Text style={ds.notice} testID="trending-list-unavailable">{unavailableCopy(read.data.unavailable, shown)}</Text>
      ) : (
        <TrendingLists list={read.data} onNavigate={onNavigate} loadPlaceName={loadPlaceName} />
      )}
    </ScrollView>
  );
}

function TrendingLists({ list, onNavigate, loadPlaceName }: { list: TrendingList; onNavigate: (href: string) => void; loadPlaceName: typeof fetchPlaceName }) {
  const nothing = list.places.length === 0 && list.areas.length === 0 && list.trails.length === 0;
  if (nothing) {
    return <Text style={ds.notice} testID="trending-empty">Nothing here is clearly gaining right now.</Text>;
  }
  return (
    <View>
      {list.action === 'for-you' && list.basis === 'none' ? (
        <Text style={[ds.detail, { paddingHorizontal: space.lg, paddingTop: space.sm }]} testID="trending-basis-none">Not personalised yet — shown as for everyone.</Text>
      ) : null}
      {list.areas.length > 0 ? (
        <View style={ds.card}>
          {list.areas.map((a, i) => (
            <View key={a.area} style={[ds.row, i > 0 && ds.rowDivider]} testID={`trending-area-${a.area}`}>
              <TrendingUp size={16} color={color.deep} />
              <View style={{ flex: 1 }}>
                <Text style={ds.title}>{a.area}</Text>
                <Text style={ds.detail}>{stateLabel(a.state)} · {a.reason.text}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {list.places.length > 0 ? (
        <View style={ds.card}>
          {list.places.map((p, i) => (
            <Pressable key={p.placeId} style={[ds.row, i > 0 && ds.rowDivider]} onPress={() => onNavigate(`/place/${encodeURIComponent(p.placeId)}`)} accessibilityRole="button" testID={`trending-place-${p.placeId}`}>
              <MapPin size={16} color={color.deep} />
              <View style={{ flex: 1 }}>
                <PlaceName id={p.placeId} load={loadPlaceName} />
                <Text style={ds.detail}>{stateLabel(p.state)} · {p.reason.text}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
      {list.trails.length > 0 ? (
        <View style={ds.card}>
          <Text style={ds.heading}>Emerging Trails</Text>
          {list.trails.map((tr, i) => (
            <Pressable key={tr.trailId} style={[ds.row, i > 0 && ds.rowDivider]} onPress={() => onNavigate(`/trails/${encodeURIComponent(tr.trailId)}`)} accessibilityRole="button" testID={`trending-trail-${tr.trailId}`}>
              <RouteIcon size={16} color={color.deep} />
              <Text style={[ds.detail, { flex: 1 }]}>{tr.reason.text}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {list.action === 'emerging' && list.trailsUnavailable ? (
        <Text style={[ds.detail, { paddingHorizontal: space.lg, paddingTop: space.sm }]} testID="trending-trails-unavailable">Emerging Trails couldn't be checked.</Text>
      ) : null}
    </View>
  );
}

function PlaceName({ id, load }: { id: string; load: typeof fetchPlaceName }) {
  const s = usePlaceName(id, load);
  return <Text style={s.state === 'ok' ? ds.title : ds.detail}>{placeLabel(s)}</Text>;
}
