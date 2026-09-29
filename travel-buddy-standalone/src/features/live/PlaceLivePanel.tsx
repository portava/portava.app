/**
 * PlaceLivePanel — TM-live (WP-11) on the place screen: "should I go now?",
 * what is true here now, what it is usually like, the neighbourhood pulse,
 * and the opportunity → experience session → outcome bridge.
 *
 *   COMP-F15  Compass decision (GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN)
 *   SEN-F08   live state, typical patterns, neighbourhood pulse (§19 read models)
 *   SEN-F07   opportunity here → "I'm going" (session) → "how was it?" (outcome)
 *
 * Each block loads on its own and renders one of: loading, the answer, a
 * named failure with Try again, or nothing when its feature is off in this
 * build. A failed read is never drawn as a quiet place or an empty answer, and
 * the decision is never shown without the server's own sentence and grounding.
 * When the viewer has an open session somewhere, it is sent as the CURRENT
 * experience, so Compass can say STAY or SWITCH instead of judging this place
 * in a vacuum.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Compass, Activity, Clock, MapPin, Footprints } from 'lucide-react-native';

import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { failureLine } from './liveApi.ts';
import {
  fetchCompassDecision, fetchLiveState, fetchTypicalPatterns, fetchNeighborhoodPulse, fetchPlaceOpportunity,
  fetchOpenSession, startSessionFromOpportunity, closeSession, decisionCaveat, typicalLines, scalarOf,
  DECISION_WORDS, DECISION_REASON_WORDS, OPPORTUNITY_WORDS, OPPORTUNITY_REFUSAL_WORDS, SESSION_OUTCOMES, SESSION_REFUSAL_WORDS,
  type Read, type CompassDecisionView, type LiveStateView, type TypicalPattern, type PulseView, type OpportunityAnswer, type SessionView,
} from './placeLive.ts';

interface Props {
  placeId: string;
  neighborhood?: string | null;
  /** The viewer's position, when the screen has one; sent once for a walking ETA and stored nowhere. */
  pos?: { lat: number; lng: number } | null;
}

function hhmm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Failed({ read, what, onRetry, testID }: { read: Extract<Read<unknown>, { state: 'failed' }>; what: string; onRetry: () => void; testID: string }) {
  return (
    <View testID={testID}>
      <Text style={s.error}>{failureLine(read.call, what)}</Text>
      <Pressable onPress={onRetry} testID={`${testID}-retry`}><Text style={s.action}>Try again</Text></Pressable>
    </View>
  );
}

const LIVE_STATE_WORDS: Record<string, string> = { live: 'Live now', emerging: 'Emerging', typical: 'Typical for now (not live)', unknown: 'No current reading' };

export function PlaceLivePanel({ placeId, neighborhood, pos }: Props) {
  const [session, setSession] = useState<Read<SessionView | null> | undefined>(undefined);
  const [decision, setDecision] = useState<Read<CompassDecisionView> | undefined>(undefined);
  const [live, setLive] = useState<Read<LiveStateView> | undefined>(undefined);
  const [typical, setTypical] = useState<Read<TypicalPattern[]> | undefined>(undefined);
  const [pulse, setPulse] = useState<Read<PulseView> | null | undefined>(undefined);
  const [opp, setOpp] = useState<Read<OpportunityAnswer> | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The viewer's open session, when it is somewhere else, is their CURRENT experience; at this place the server says STAY itself.
  const current = session?.state === 'ok' && session.value ? session.value.subjectId : null;
  const loadDecision = useCallback(async () => {
    setDecision(undefined);
    setDecision(await fetchCompassDecision(placeId, pos ?? null, current));
  }, [placeId, pos, current]);
  const loadLive = useCallback(async () => { setLive(undefined); setLive(await fetchLiveState(placeId)); }, [placeId]);
  const loadTypical = useCallback(async () => { setTypical(undefined); setTypical(await fetchTypicalPatterns(placeId)); }, [placeId]);
  const loadPulse = useCallback(async () => {
    if (!neighborhood) { setPulse(null); return; }
    setPulse(undefined); setPulse(await fetchNeighborhoodPulse(neighborhood));
  }, [neighborhood]);
  const loadOpp = useCallback(async () => { setOpp(undefined); setOpp(await fetchPlaceOpportunity(placeId)); }, [placeId]);
  const loadSession = useCallback(async () => { setSession(undefined); setSession(await fetchOpenSession()); }, []);

  useEffect(() => { void loadLive(); void loadTypical(); void loadPulse(); void loadOpp(); void loadSession(); }, [loadLive, loadTypical, loadPulse, loadOpp, loadSession]);

  // The decision waits for the session read so the CURRENT experience can go with it.
  const sessionRead = session !== undefined;
  useEffect(() => { if (sessionRead) void loadDecision(); }, [sessionRead, loadDecision]);

  const going = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const r = await startSessionFromOpportunity(placeId);
    setBusy(false);
    if (!r.ok) { setNote(SESSION_REFUSAL_WORDS[r.refusal] ?? `No session was opened (${r.refusal}${r.detail ? `: ${r.detail}` : ''}).`); return; }
    setNote('Enjoy it — tell Compass how it was when you leave.');
    setSession({ state: 'ok', value: r.value });
  }, [busy, placeId]);

  const report = useCallback(async (sessionId: string, outcome: string) => {
    if (busy) return;
    setBusy(true);
    const r = await closeSession(sessionId, outcome);
    setBusy(false);
    if (!r.ok) { setNote(SESSION_REFUSAL_WORDS[r.refusal] ?? `That wasn't recorded (${r.refusal}${r.detail ? `: ${r.detail}` : ''}).`); return; }
    setNote('Thanks — recorded.');
    setSession({ state: 'ok', value: null });
    void loadOpp();
  }, [busy, loadOpp]);

  const allOff = [decision, live, typical, opp, session].every((x) => x?.state === 'off') && (pulse === null || pulse?.state === 'off');
  if (allOff) return null;

  return (
    <View style={s.wrap} testID="place-live-panel">
      {/* ── COMP-F15: should I go now? ── */}
      {decision?.state === 'off' ? null : (
        <View style={s.block} testID="place-decision">
          <View style={s.headRow}><Compass size={14} color={color.deep} /><Text style={s.label}>SHOULD I GO NOW?</Text></View>
          {decision === undefined ? <ActivityIndicator size="small" color={color.signal} testID="place-decision-loading" />
            : decision.state === 'failed' ? <Failed read={decision} what="Compass's decision" onRetry={() => void loadDecision()} testID="place-decision-failed" />
            : (
              <>
                <Text style={s.decision} testID="place-decision-word">{DECISION_WORDS[decision.value.decision] ?? decision.value.decision}</Text>
                {decisionCaveat(decision.value) ? <Text style={s.error} testID="place-decision-caveat">{decisionCaveat(decision.value)}</Text> : null}
                <Text style={s.sub} testID="place-decision-summary">{decision.value.summary}</Text>
                {decision.value.reasons.map((r) => <Text key={r} style={s.meta}>• {DECISION_REASON_WORDS[r] ?? r}</Text>)}
                {decision.value.grounding ? (
                  <Text style={s.meta} testID="place-decision-grounding">
                    Based on: {decision.value.grounding.truthClass} · {decision.value.grounding.freshness} · {decision.value.grounding.coverage} coverage
                  </Text>
                ) : null}
                {decision.value.confirmation?.required ? <Text style={s.meta}>Switching leaves where you are now — only you can decide that.</Text> : null}
                <Pressable onPress={() => void loadDecision()} testID="place-decision-again"><Text style={s.action}>Ask again</Text></Pressable>
              </>
            )}
        </View>
      )}

      {/* ── SEN-F08: right now ── */}
      {live?.state === 'off' ? null : (
        <View style={s.block} testID="place-live-state">
          <View style={s.headRow}><Activity size={14} color={color.deep} /><Text style={s.label}>RIGHT NOW</Text></View>
          {live === undefined ? <ActivityIndicator size="small" color={color.signal} />
            : live.state === 'failed' ? <Failed read={live} what="what's happening here" onRetry={() => void loadLive()} testID="place-live-failed" />
            : (
              <>
                {live.value.liveReadFailed ? (
                  <Text style={s.error} testID="place-live-read-failed">
                    The live reading couldn't be read{live.value.state === 'typical' ? ' — showing what is typical instead' : ''}. This is not a reading of quiet.
                  </Text>
                ) : null}
                <Text style={s.title} testID="place-live-word">{LIVE_STATE_WORDS[live.value.state] ?? live.value.state}</Text>
                {live.value.state === 'unknown' && !live.value.liveReadFailed ? <Text style={s.sub}>No current reports here — that isn't the same as quiet.</Text> : null}
                {live.value.claims.map((c, i) => (
                  <Text key={`${c.claimType}-${i}`} style={s.sub}>
                    {c.claimType.replace(/\./g, ' ')}: {scalarOf(c.value) ?? '—'}{c.truth ? ` (${c.truth.truthClass}, ${c.truth.freshness})` : ''}
                  </Text>
                ))}
                {live.value.validUntil ? <Text style={s.meta}>Good until {hhmm(live.value.validUntil)}</Text> : null}
              </>
            )}
        </View>
      )}

      {/* ── SEN-F08: typically ── */}
      {typical?.state === 'off' ? null : (
        <View style={s.block} testID="place-typical">
          <View style={s.headRow}><Clock size={14} color={color.deep} /><Text style={s.label}>TYPICALLY</Text></View>
          {typical === undefined ? <ActivityIndicator size="small" color={color.signal} />
            : typical.state === 'failed' ? <Failed read={typical} what="this place's usual pattern" onRetry={() => void loadTypical()} testID="place-typical-failed" />
            : typicalLines(typical.value).length === 0 ? <Text style={s.sub} testID="place-typical-none">No usual pattern has been learned for this place yet.</Text>
            : typicalLines(typical.value).map((l) => <Text key={l} style={s.sub}>{l}</Text>)}
          <Text style={s.meta}>A pattern from past weeks — not what is happening now.</Text>
        </View>
      )}

      {/* ── SEN-F08: neighbourhood pulse ── */}
      {pulse === null || pulse?.state === 'off' ? null : (
        <View style={s.block} testID="place-pulse">
          <View style={s.headRow}><MapPin size={14} color={color.deep} /><Text style={s.label}>{`${neighborhood ?? ''} PULSE`.trim().toUpperCase()}</Text></View>
          {pulse === undefined ? <ActivityIndicator size="small" color={color.signal} />
            : pulse.state === 'failed' ? <Failed read={pulse} what="the neighbourhood pulse" onRetry={() => void loadPulse()} testID="place-pulse-failed" />
            : pulse.value.exposable ? (
              <Text style={s.sub} testID="place-pulse-levels">
                {Object.entries(pulse.value.levels).map(([k, v]) => `${k} ${Math.round(Number(v) * 100)}%`).join(' · ')} across {pulse.value.subjectCount} places
              </Text>
            ) : (
              <Text style={s.sub} testID="place-pulse-withheld">
                {pulse.value.reason === 'below_threshold' ? 'Too few live places here to show a pulse without singling one out.' : 'No live pulse to show for this neighbourhood right now — not a reading of quiet.'}
              </Text>
            )}
        </View>
      )}

      {/* ── SEN-F07: opportunity → session → outcome ── */}
      {session?.state === 'off' || (opp?.state === 'off' && !(session?.state === 'ok' && session.value)) ? null : (
        <View style={s.block} testID="place-session">
          <View style={s.headRow}><Footprints size={14} color={color.deep} /><Text style={s.label}>GOING?</Text></View>
          {session === undefined ? <ActivityIndicator size="small" color={color.signal} />
            : session.state === 'failed' ? <Failed read={session} what="your open Compass session" onRetry={() => void loadSession()} testID="place-session-failed" />
            : session.value ? (
              <View testID="place-session-open">
                <Text style={s.sub}>
                  {session.value.subjectId === placeId ? "You're here on a Compass session." : 'You have an open Compass session at another place.'} How was it?
                </Text>
                <View style={s.chips}>
                  {SESSION_OUTCOMES.map((o) => (
                    <Pressable key={o.key} style={s.chip} disabled={busy} onPress={() => void report(session.value!.sessionId, o.key)} testID={`place-session-outcome-${o.key}`}>
                      <Text style={s.chipText}>{o.label}</Text>
                    </Pressable>
                  ))}
                </View>
                {hhmm(session.value.expiresAt) ? <Text style={s.meta}>Open until {hhmm(session.value.expiresAt)}</Text> : null}
              </View>
            ) : opp === undefined ? <ActivityIndicator size="small" color={color.signal} />
            : opp.state === 'failed' ? <Failed read={opp} what="live opportunities here" onRetry={() => void loadOpp()} testID="place-opportunity-failed" />
            : opp.state === 'ok' && opp.value.found ? (
              <View testID="place-opportunity">
                <Text style={s.title}>{OPPORTUNITY_WORDS[opp.value.opportunity.kind] ?? opp.value.opportunity.kind}</Text>
                {hhmm(opp.value.opportunity.validUntil) ? <Text style={s.meta}>While the reading holds — until {hhmm(opp.value.opportunity.validUntil)}</Text> : null}
                <Pressable style={s.goBtn} disabled={busy} onPress={() => void going()} testID="place-going">
                  <Text style={s.goText}>I'm going</Text>
                </Pressable>
              </View>
            ) : opp.state === 'ok' && !opp.value.found ? (
              <Text style={s.sub} testID="place-opportunity-none">{OPPORTUNITY_REFUSAL_WORDS[opp.value.reason] ?? `No opportunity here (${opp.value.reason}).`}</Text>
            ) : null}
          {note ? <Text style={s.meta} testID="place-session-note">{note}</Text> : null}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginVertical: space.md, gap: space.sm },
  block: { padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, gap: space.xs },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  label: { ...t.stamp, color: color.mute, letterSpacing: 0.5 },
  decision: { ...t.heading, color: color.ink },
  title: { ...t.bodyStrong, color: color.ink },
  sub: { ...t.small, color: color.ink },
  meta: { ...t.stamp, color: color.mute },
  error: { ...t.small, color: color.warn },
  action: { ...t.stamp, color: color.deep, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipText: { ...t.stamp, color: color.ink },
  goBtn: { alignSelf: 'flex-start', marginTop: space.xs, paddingVertical: space.xs, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: color.deep },
  goText: { ...t.stamp, color: color.onInk, fontWeight: '700' },
});
