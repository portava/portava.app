/**
 * TripLayoverConnectionsCard — Layover spec §25 "Trips: detect connection;
 * show Layover card/status; pass flight segments into session creation"
 * (census-layover L267, with L11's flight entry). Lane B1-F.
 *
 * What it shows, all of it the server's word:
 *   * every layover the trip's flights make (an arriving and a departing flight
 *     at one airport, within a day) — the airport, the gap, the two flights,
 *     what the bookings say, and the missed-connection risk WITH its number;
 *   * an UNDETERMINED connection as exactly that, naming the missing time —
 *     never a guessed gap;
 *   * the traveller's own layover for it, by §4.1 state ("Flight changed —
 *     rechecking"), with Open; or Start, which hands the two flights to the
 *     server, which re-reads them and starts the DETECTED session;
 *   * "Add a flight": carrier + number, the two airports, and each time in its
 *     own airport's local time (the server converts with the airport's zone, or
 *     refuses).
 * Off (either flag): nothing is drawn. A failed read says so, with a retry.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Plane, CloudOff, AlertTriangle } from 'lucide-react-native';
import { router } from 'expo-router';

import { color, radius, shadow, space, type as t } from '../../../theme/tokens.ts';
import { intentKey, writeFailureText, type ApiWrite } from '../shared/tripApi.ts';
import {
  addTripFlight, bookingWords, fetchLayoverConnections, flightEntryProblem, gapWords, riskWords, startLayoverFromConnection,
  stateWords, unknownWords, type ConnectionsBody, type FlightEntry, type LayoverConnection,
} from './tripLayoverConnections.ts';
import type { ApiRead } from '../shared/tripApi.ts';

interface Props {
  tripId: string;
  /** Test seams. */
  load?: typeof fetchLayoverConnections;
  start?: typeof startLayoverFromConnection;
  addFlight?: typeof addTripFlight;
  open?: (sessionId: string) => void;
}

const EMPTY_ENTRY: FlightEntry = { flight: '', departureAirport: '', arrivalAirport: '', departureLocal: '', arrivalLocal: '' };

export function TripLayoverConnectionsCard({ tripId, load = fetchLayoverConnections, start = startLayoverFromConnection, addFlight = addTripFlight, open }: Props) {
  const [read, setRead] = useState<ApiRead<ConnectionsBody> | undefined>(undefined);
  const [starting, setStarting] = useState<string | null>(null);
  const [startResult, setStartResult] = useState<Record<string, ApiWrite<unknown>>>({});
  const [entryOpen, setEntryOpen] = useState(false);
  const [entry, setEntry] = useState<FlightEntry>(EMPTY_ENTRY);
  const [entryProblem, setEntryProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<ApiWrite<unknown> | null>(null);
  const addKey = useRef<string | null>(null);

  const openSession = useCallback((id: string) => (open ? open(id) : router.push(`/layover/${id}` as any)), [open]);

  const run = useCallback(async () => {
    setRead(undefined);
    try { setRead(await load(tripId)); }
    catch (e: any) { setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, load]);
  useEffect(() => { void run(); }, [run]);

  async function onStart(c: LayoverConnection) {
    setStarting(c.key);
    const w = await start(tripId, c);
    setStarting(null);
    setStartResult((r) => ({ ...r, [c.key]: w }));
    if (w.state === 'done') {
      const id = (w.data as any)?.session?.id;
      if (typeof id === 'string') openSession(id);
      void run();
    }
  }

  async function onAdd() {
    const problem = flightEntryProblem(entry);
    setEntryProblem(problem);
    if (problem) return;
    if (!addKey.current) addKey.current = intentKey('trip-flight');
    setAdding(true);
    setAddResult(null);
    const w = await addFlight(tripId, entry, addKey.current);
    setAdding(false);
    setAddResult(w);
    if (w.state === 'done') {
      addKey.current = null; // the next flight is a new intent
      setEntry(EMPTY_ENTRY);
      setEntryOpen(false);
      void run();
    }
  }

  if (read === undefined) {
    return <View style={s.wrap} testID="trip-layovers-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-layovers-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Layovers unavailable</Text>
            <Text style={s.detail}>We couldn&apos;t read this trip&apos;s flights. Nothing about your connections was decided.</Text>
            <Pressable onPress={() => void run()} style={s.button} testID="trip-layovers-retry" accessibilityRole="button">
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const { connections } = read.data;
  const field = (k: keyof FlightEntry, label: string, placeholder: string) => (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={entry[k] ?? ''}
        onChangeText={(v) => { setEntry((e) => ({ ...e, [k]: v })); addKey.current = null; }}
        placeholder={placeholder}
        autoCapitalize="characters"
        style={s.input}
        testID={`trip-flight-${k}`}
        accessibilityLabel={label}
      />
    </View>
  );

  return (
    <View style={s.wrap} testID="trip-layovers-card">
      <View style={s.row}>
        <Plane size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Layovers on this trip</Text>
          {read.data.degraded ? <Text style={s.detail} testID="trip-layovers-degraded">Some airport details could not be read; a risk may show as unknown.</Text> : null}
          {connections.length === 0 ? (
            <Text style={s.detail} testID="trip-layovers-none">No connection between this trip&apos;s flights yet. Add your flights and a layover between them appears here.</Text>
          ) : connections.map((c) => {
            const result = startResult[c.key];
            const risky = c.missedConnection.risk === 'at_risk' || c.missedConnection.risk === 'missed';
            return (
              <View key={c.key} style={s.connection} testID={`trip-layover-${c.key}`}>
                <Text style={s.connTitle}>{c.airport} · {c.status === 'detected' ? gapWords(c.gapMinutes) : 'gap unknown'}</Text>
                <Text style={s.detail}>{c.arrivalSegment.designator ?? 'Flight'} → {c.departureSegment.designator ?? 'flight'} · {bookingWords(c.connectionType)}</Text>
                {c.terminalChange ? <Text style={s.detail} testID={`trip-layover-terminal-${c.key}`}>Terminal change: {c.arrivalSegment.arrivalTerminal} → {c.departureSegment.departureTerminal}</Text> : null}
                {c.status === 'undetermined' ? (
                  <Text style={s.detail} testID={`trip-layover-undetermined-${c.key}`}>Not enough to go on: {unknownWords(c.unknowns)}.</Text>
                ) : (
                  <View style={s.inline}>
                    {risky ? <AlertTriangle size={12} color={color.warn} /> : null}
                    <Text style={[s.detail, risky && { color: color.ink, fontWeight: '600' }]} testID={`trip-layover-risk-${c.key}`}>{riskWords(c.missedConnection)}</Text>
                  </View>
                )}
                {c.session ? (
                  <View style={s.inline}>
                    <Text style={s.status} testID={`trip-layover-state-${c.key}`}>Layover: {stateWords(c.session.state)}</Text>
                    <Pressable onPress={() => openSession(c.session!.sessionId)} style={s.button} testID={`trip-layover-open-${c.key}`} accessibilityRole="button">
                      <Text style={s.buttonText}>Open</Text>
                    </Pressable>
                  </View>
                ) : c.status === 'detected' ? (
                  <Pressable onPress={() => void onStart(c)} disabled={starting !== null} style={[s.button, s.primary]} testID={`trip-layover-start-${c.key}`} accessibilityRole="button">
                    {starting === c.key ? <ActivityIndicator size="small" color="#fff" /> : <Text style={[s.buttonText, s.primaryText]}>Start this layover</Text>}
                  </Pressable>
                ) : null}
                {result && result.state !== 'done' ? <Text style={[s.detail, { color: color.ink, fontWeight: '600' }]} testID={`trip-layover-not-started-${c.key}`}>{writeFailureText(result)}</Text> : null}
              </View>
            );
          })}
          {entryOpen ? (
            <View style={s.entry} testID="trip-flight-entry">
              {field('flight', 'Flight', 'BA286')}
              <View style={s.pair}>{field('departureAirport', 'From', 'SFO')}{field('arrivalAirport', 'To', 'LHR')}</View>
              {field('departureLocal', 'Leaves (local time there)', 'YYYY-MM-DD HH:MM')}
              {field('arrivalLocal', 'Lands (local time there)', 'YYYY-MM-DD HH:MM')}
              <View style={s.pair}>{field('departureTerminal', 'Terminal (from)', 'optional')}{field('arrivalTerminal', 'Terminal (to)', 'optional')}</View>
              {field('bookingRef', 'Booking reference', 'optional')}
              {entryProblem ? <Text style={[s.detail, { color: color.ink, fontWeight: '600' }]} testID="trip-flight-problem">{entryProblem}</Text> : null}
              <Pressable onPress={() => void onAdd()} disabled={adding} style={[s.button, s.primary]} testID="trip-flight-save" accessibilityRole="button">
                {adding ? <ActivityIndicator size="small" color="#fff" /> : <Text style={[s.buttonText, s.primaryText]}>Add flight</Text>}
              </Pressable>
              {addResult && addResult.state !== 'done' ? <Text style={[s.detail, { color: color.ink, fontWeight: '600' }]} testID="trip-flight-not-added">{writeFailureText(addResult)}</Text> : null}
            </View>
          ) : (
            <Pressable onPress={() => setEntryOpen(true)} style={s.button} testID="trip-flight-add" accessibilityRole="button">
              <Text style={s.buttonText}>Add a flight</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  connection: { marginTop: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: color.haze },
  connTitle: { ...t.small, fontWeight: '600', color: color.ink },
  status: { ...t.small, color: color.deep, marginTop: space.xs },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: 2 },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonText: { ...t.small, color: color.ink },
  primary: { backgroundColor: color.deep, borderColor: color.deep },
  primaryText: { color: '#fff' },
  entry: { marginTop: space.sm, gap: space.xs },
  pair: { flexDirection: 'row', gap: space.sm },
  field: { flex: 1 },
  label: { ...t.stamp, color: color.mute },
  input: { ...t.small, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, marginTop: 2 },
});
