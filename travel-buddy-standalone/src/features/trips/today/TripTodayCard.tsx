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
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { AlertTriangle, CloudOff, Compass } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import {
  fetchTripToday, todayHeadline, todayAnswers, attentionBanner, sensingLine, type TodayRead,
} from './tripToday.ts';

interface Props {
  tripId: string;
  /** Test seam — the real fetcher by default. */
  load?: typeof fetchTripToday;
}

export function TripTodayCard({ tripId, load = fetchTripToday }: Props) {
  const [read, setRead] = useState<TodayRead | undefined>(undefined);

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
      <Text style={s.sensing} testID="trip-today-sensing">{sensingLine(today)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
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
