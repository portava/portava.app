/**
 * Discovery Trails — browse and search (owner decision 2026-10-04: Trails are
 * a user-facing feature; `02_Trails.md` §1, `11` §3 action 1).
 *
 * A failed read is said, with Retry; it is never "no Trails". An empty answer
 * for a search is "No Trails match", and the person is offered to start one.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Route as RouteIcon } from 'lucide-react-native';

import { color, space } from '../../../theme/tokens.ts';
import { ds } from '../shared/discoveryStyles.ts';
import { listTrails, type Trail } from './trailsApi.ts';
import { lifecycleNote } from './trailModel.ts';
import type { ApiRead } from '../shared/discoveryApi.ts';

interface Props {
  initialDestination?: string | null;
  onOpen: (trailId: string) => void;
  onCreate: (destination: string | null) => void;
  load?: typeof listTrails;
}

export function TrailsBrowser({ initialDestination = null, onOpen, onCreate, load = listTrails }: Props) {
  const [q, setQ] = useState('');
  const [destination, setDestination] = useState(initialDestination ?? '');
  const [read, setRead] = useState<ApiRead<Trail[]> | undefined>(undefined);

  const run = useCallback(async (query: string, dest: string) => {
    setRead(undefined);
    setRead(await load({ q: query, destination: dest, limit: 50 }));
  }, [load]);

  useEffect(() => { void run('', initialDestination ?? ''); }, [run, initialDestination]);

  return (
    <ScrollView keyboardShouldPersistTaps="handled" testID="trails-browser">
      <TextInput
        style={ds.input} value={q} onChangeText={setQ} placeholder="Search Trails"
        returnKeyType="search" onSubmitEditing={() => { void run(q, destination); }}
        accessibilityLabel="Search Trails" testID="trails-search"
      />
      <TextInput
        style={ds.input} value={destination} onChangeText={setDestination} placeholder="City (optional)"
        returnKeyType="search" onSubmitEditing={() => { void run(q, destination); }}
        accessibilityLabel="City to browse Trails in" testID="trails-destination"
      />
      <View style={ds.chips}>
        <Pressable style={ds.ghost} onPress={() => { void run(q, destination); }} accessibilityRole="button" testID="trails-search-go">
          <Text style={ds.ghostText}>Search</Text>
        </Pressable>
        <Pressable style={ds.ghost} onPress={() => onCreate(destination.trim() || null)} accessibilityRole="button" testID="trails-create">
          <Text style={ds.ghostText}>Start a Trail</Text>
        </Pressable>
      </View>

      {read === undefined ? (
        <ActivityIndicator style={{ margin: space.xl }} color={color.signal} testID="trails-loading" />
      ) : read.state === 'off' ? (
        <Text style={ds.notice} testID="trails-off">Trails aren't available yet.</Text>
      ) : read.state === 'unavailable' ? (
        <View testID="trails-unavailable">
          <Text style={ds.notice}>Trails couldn't be loaded — {read.detail}.</Text>
          <Pressable onPress={() => { void run(q, destination); }} accessibilityRole="button" testID="trails-retry">
            <Text style={[ds.link, { textAlign: 'center' }]}>Try again</Text>
          </Pressable>
        </View>
      ) : read.data.length === 0 ? (
        <Text style={ds.notice} testID="trails-empty">
          {q.trim() || destination.trim() ? 'No Trails match. You can start one.' : 'No Trails yet. You can start one.'}
        </Text>
      ) : (
        <View style={ds.card}>
          {read.data.map((trail, i) => (
            <Pressable
              key={trail.id} style={[ds.row, i > 0 && ds.rowDivider]} onPress={() => onOpen(trail.id)}
              accessibilityRole="button" accessibilityLabel={`Open Trail ${trail.title}`} testID={`trail-row-${trail.id}`}
            >
              <RouteIcon size={18} color={color.deep} />
              <View style={{ flex: 1 }}>
                <Text style={ds.title}>{trail.title}</Text>
                {trail.destination ? <Text style={ds.detail}>{trail.destination}</Text> : null}
                {trail.description ? <Text style={ds.detail} numberOfLines={2}>{trail.description}</Text> : null}
                {lifecycleNote(trail.lifecycle) ? <Text style={ds.detail}>{lifecycleNote(trail.lifecycle)}</Text> : null}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
