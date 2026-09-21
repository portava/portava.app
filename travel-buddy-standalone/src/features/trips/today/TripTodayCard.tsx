/**
 * TripTodayCard — §11 Today on screen. census-trips TR193, TR317, TR319, TR172.
 *
 * THE ORDER IS THE POINT
 * ======================
 * §11.2 asks five questions in order — where am I now, what is next, who is
 * around, what can I do, what changed — and the projection answers them in
 * that order, naming the field for each. The card renders them in that
 * order and nothing else above them. When the §17.2 switch is not NORMAL the
 * banner comes first, because "safety / official help / location
 * coordination" IS the answer to every question, and discovery is not shown
 * at all while the server says it is suppressed.
 *
 * WHAT A FAILED READ LOOKS LIKE
 * =============================
 * A Today that could not be read, or that §19.1 refused as stale or of
 * another schema, renders as "unavailable" with the reason. It never renders
 * as a quiet day: an empty card and a clean card look the same.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { AlertTriangle, CloudOff, Compass, Navigation } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import {
  fetchTripToday, todayHeadline, todayAnswers, attentionBanner, sensingLine, type TodayRead,
} from './tripToday.ts';
import { startNavigation, resolveNavigationReturn } from '../crew/tripNavigationHandoff.ts';
import { phaseView } from './tripPhase.ts';

interface Props {
  tripId: string;
  /** Test seam — the real fetcher by default. */
  load?: typeof fetchTripToday;
  /** The §17.2 mode after each read (null when Today could not be read), so the screen can mount §17.3's rescue entry under it. */
  onAttention?: (mode: string | null) => void;
  /** §10.3 test seams — the real navigation handoff and its callback by default. */
  startNav?: typeof startNavigation;
  resolveNav?: typeof resolveNavigationReturn;
}

export function TripTodayCard({ tripId, load = fetchTripToday, onAttention, startNav = startNavigation, resolveNav = resolveNavigationReturn }: Props) {
  const [read, setRead] = useState<TodayRead | undefined>(undefined);
  const [navNote, setNavNote] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRead(undefined);
    try {
      const r = await load(tripId);
      setRead(r);
      onAttention?.(r.state === 'ok' ? r.today.attention.mode : null);
    } catch (e: any) {
      setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') });
      onAttention?.(null);
    }
  }, [tripId, load, onAttention]);

  useEffect(() => { void run(); }, [run]);

  // §10.3's navigation CALLBACK. Reaching Today is the traveller coming back
  // to the app, which is the only return signal this path has; a journey that
  // was never started resolves to nothing and writes nothing.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await resolveNav(tripId);
        if (!live) return;
        if (r.state === 'arrived') setNavNote('Marked you as arrived, from the navigation you started here.');
        else if (r.state === 'still_transiting') setNavNote('Still on the way — nothing claimed about arriving.');
      } catch { /* the callback is a courtesy; a failure must not take Today down */ }
    })();
    return () => { live = false; };
  }, [tripId, resolveNav]);

  const navigate = useCallback(async () => {
    if (read?.state !== 'ok') return;
    const plan = read.today.currentPlan;
    if (!plan) return;
    const r = await startNav(tripId, {
      planItemId: plan.id, title: plan.title, locationName: plan.locationName, startsAt: plan.startsAt,
    });
    setNavNote(r.state === 'started' ? 'Opened directions, and told your crew you are on the way.' : r.detail);
  }, [read, tripId, startNav]);

  if (read === undefined) {
    return (
      <View style={s.wrap} testID="trip-today-loading">
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }
  if (read.state === 'off') return null;

  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-today-unavailable">
        <View style={s.row}>
          <CloudOff size={16} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Today unavailable</Text>
            <Text style={s.detail}>
              {read.reason ? `${read.reason}: ` : ''}{read.detail}. This is not a quiet day; it could not be read.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const today = read.today;
  const banner = attentionBanner(today);
  const answers = todayAnswers(today);
  const alarm = banner !== null || today.health === 'CRITICAL' || today.health === 'AT_RISK';

  return (
    <View style={[s.wrap, alarm && s.wrapAlarm]} testID="trip-today-card">
      {banner ? (
        <View style={[s.row, s.banner]} testID="trip-today-attention">
          <AlertTriangle size={16} color={color.signal} />
          <View style={{ flex: 1 }}>
            <Text style={[s.title, { color: color.signal }]}>{banner.title}</Text>
            <Text style={s.detail}>{banner.detail}</Text>
          </View>
        </View>
      ) : null}
      <View style={s.row}>
        <Compass size={16} color={alarm ? color.signal : color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title} testID="trip-today-headline">{todayHeadline(today)}</Text>
          <Text style={s.detail}>{today.nowState.reason}</Text>
        </View>
      </View>
      {(() => {
        // §3.2: the phase decides what this card LEADS with, and in two phases
        // what it withholds. The five answers below are unchanged and still in
        // §11.2's order — a phase reorders the lead, it does not replace them.
        const pv = phaseView(today);
        if (!pv.phase) return null;
        return (
          <View style={s.phase} testID="trip-today-phase">
            <Text style={s.phaseTitle} testID="trip-today-phase-name">{pv.phase.replace(/_/g, ' ')}</Text>
            {pv.focus ? <Text style={s.detail} testID="trip-today-phase-focus">{pv.focus}</Text> : null}
            {pv.sections.map((sec) => (
              <View key={sec.key} style={s.answerRow} testID={`trip-today-phase-${sec.key}`}>
                <Text style={s.question}>{sec.label}</Text>
                <Text style={s.answer}>{sec.detail}</Text>
              </View>
            ))}
            {pv.withheld.map((w) => (
              <Text key={w.key} style={s.detail} testID={`trip-today-phase-withheld-${w.key}`}>
                {w.key} withheld — {w.reason}
              </Text>
            ))}
          </View>
        );
      })()}
      <View style={s.answers}>
        {answers.map((a, i) => (
          <View key={a.key} style={s.answerRow} testID={`trip-today-answer-${i}-${a.key}`}>
            <Text style={s.question}>{a.question}</Text>
            <Text style={s.answer}>{a.answer}</Text>
          </View>
        ))}
      </View>
      {today.unresolvedActions.length > 0 ? (
        <View style={s.actions} testID="trip-today-actions">
          {today.unresolvedActions.map((u, i) => (
            <Text key={`${u.kind}-${i}`} style={[s.detail, u.severity === 'critical' && { color: color.signal }]}>
              • {u.detail}
            </Text>
          ))}
        </View>
      ) : null}
      {today.currentPlan && (today.currentPlan.locationName ?? '').trim().length > 0 ? (
        <Pressable onPress={() => void navigate()} style={s.navButton} testID="trip-today-navigate" accessibilityRole="button"
          accessibilityLabel={`Navigate to ${today.currentPlan.locationName}`}>
          <Navigation size={14} color={color.signal} />
          <Text style={s.navText}>Navigate to {today.currentPlan.locationName}</Text>
        </Pressable>
      ) : null}
      {navNote ? <Text style={s.detail} testID="trip-today-nav-note">{navNote}</Text> : null}
      <Text style={s.sensing} testID="trip-today-sensing">{sensingLine(today)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  phase: { marginTop: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
  phaseTitle: { ...t.stamp, color: color.signal, fontWeight: '700', letterSpacing: 0.5 },
  navButton: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  navText: { ...t.stamp, color: color.signal, fontWeight: '600' },
  wrap: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
    overflow: 'hidden',
  },
  wrapAlarm: { borderColor: color.signal },
  banner: { borderBottomWidth: 1, borderBottomColor: color.haze },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  answers: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.xs },
  answerRow: { flexDirection: 'column' },
  question: { ...t.stamp, color: color.faint },
  answer: { ...t.small, color: color.ink },
  actions: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  sensing: { ...t.stamp, color: color.faint, paddingHorizontal: space.lg, paddingBottom: space.md },
});
