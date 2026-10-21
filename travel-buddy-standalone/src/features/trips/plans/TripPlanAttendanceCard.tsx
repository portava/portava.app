/**
 * TripPlanAttendanceCard — "who's going" on each plan, and your own answer
 * (census-trips TR149 §9.1 attendance; populates TR83 `trip_plan_participants`).
 *
 * Each open plan of the trip (GET /trips/:tripId/plan) is listed with how many
 * are going — the server's `goingUserIds`, never a count of every answer,
 * because `interested` and `maybe` are not attendance — and the viewer's own
 * answer from GET /trips/:tripId/structure. The viewer can say Going, Maybe,
 * Can't go or Interested, or leave a plan they answered (tripAttendance.ts).
 * Neither read nor the command is behind a flag.
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It shows an answer only once the kernel recorded it and the attendance is
 * read again; a refusal is shown with its reason; an unreachable kernel is
 * "nothing was changed" with a retry of THE SAME command and key. A plan list
 * or attendance read that failed is said, never drawn as a trip with no plans
 * or as nobody going. Finished, cancelled and skipped plans are not offered.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, Users } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { useLatestRead } from '../shared/latestRead.ts';
import { fetchTripPlan, type TripPlanResult } from '../planning/tripPlan.ts';
import { fetchTripStructure, type StructureRead } from '../planning/tripDecisions.ts';
import { OFFERED_ATTENDANCE, myAttendance, goingCount, type AttendanceState, type OfferedAttendance } from './tripAttendancePayloads.ts';
import { setAttendance, attendanceKey, type AttendanceResult } from './tripAttendance.ts';

interface Props {
  tripId: string;
  currentUserId: string;
  /** Test seams. */
  loadPlans?: (tripId: string) => Promise<TripPlanResult>;
  loadStructure?: typeof fetchTripStructure;
  answer?: typeof setAttendance;
}

type PlansRead = { state: 'ok'; plans: Array<{ id: string; title: string }> } | { state: 'unavailable'; detail: string };
type Target = OfferedAttendance | 'leave';
type Attempt = { current: AttendanceState | null; target: Target; key: string; result: AttendanceResult | 'pending' };

const LABEL: Record<AttendanceState, string> = { going: 'Going', maybe: 'Maybe', cant_go: "Can't go", interested: 'Interested', left: 'Left' };
/** §3.3's terminal states: nothing left to attend. */
const CLOSED = new Set(['done', 'cancelled', 'skipped']);

async function readPlans(load: (tripId: string) => Promise<TripPlanResult>, tripId: string): Promise<PlansRead> {
  try {
    const r = await load(tripId);
    if (!r || !Array.isArray(r.items)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', plans: r.items.filter((p) => p && typeof p.id === 'string' && !CLOSED.has(String(p.status))).map((p) => ({ id: p.id, title: p.title })) };
  } catch (e: unknown) {
    return { state: 'unavailable', detail: e instanceof Error ? e.message : 'network error' };
  }
}

export function TripPlanAttendanceCard({ tripId, currentUserId, loadPlans = fetchTripPlan, loadStructure = fetchTripStructure, answer = setAttendance }: Props) {
  const [plans, setPlans] = useState<PlansRead | undefined>(undefined);
  const [structure, setStructure] = useState<StructureRead | undefined>(undefined);
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});

  const beginPlans = useLatestRead();
  const beginStructure = useLatestRead();
  /** Both reads; each answer is applied only if it is still the latest. */
  const fetchBoth = useCallback(() => {
    const p = beginPlans(); const st = beginStructure();
    void Promise.all([
      readPlans(loadPlans, tripId),
      loadStructure(tripId).catch((e: unknown): StructureRead => ({ state: 'unavailable', detail: e instanceof Error ? e.message : 'unexpected error' })),
    ]).then(([pr, sr]) => { if (p()) setPlans(pr); if (st()) setStructure(sr); });
  }, [tripId, loadPlans, loadStructure, beginPlans, beginStructure]);
  useEffect(() => { fetchBoth(); }, [fetchBoth]);
  /** "Try again": back to the loading state, then both reads. */
  const readAll = useCallback(() => { setPlans(undefined); setStructure(undefined); fetchBoth(); }, [fetchBoth]);

  const rereadAttendance = useCallback(async () => {
    const st = beginStructure();
    try { const r = await loadStructure(tripId); if (st()) setStructure(r); }
    catch (e: unknown) { if (st()) setStructure({ state: 'unavailable', detail: e instanceof Error ? e.message : 'unexpected error' }); }
  }, [tripId, loadStructure, beginStructure]);

  const send = useCallback(async (planId: string, current: AttendanceState | null, target: Target, key: string) => {
    setAttempts((a) => ({ ...a, [planId]: { current, target, key, result: 'pending' } }));
    const result = await answer(tripId, planId, current, target, key);
    setAttempts((a) => ({ ...a, [planId]: { current, target, key, result } }));
    // Recorded or refused, the answer drawn may not be the server's: read it again.
    if (result.state !== 'unavailable') void rereadAttendance();
  }, [tripId, answer, rereadAttendance]);

  if (plans === undefined || structure === undefined) {
    return <View style={s.wrap} testID="plan-attendance-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} accessibilityLabel="Reading who's going" /></View>;
  }
  if (structure.state === 'off') return null;
  if (plans.state !== 'ok' || structure.state !== 'ok') {
    const detail = plans.state !== 'ok' ? plans.detail : structure.state === 'unavailable' ? structure.detail : '';
    return (
      <View style={s.wrap} testID="plan-attendance-read-failed">
        <View style={s.row}>
          <Users size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Who&apos;s going</Text>
            <Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t read this trip&apos;s plans and who&apos;s going — {detail}. That isn&apos;t the same as nobody going.</Text>
            <Pressable onPress={readAll} style={s.button} testID="plan-attendance-reread" accessibilityRole="button" accessibilityLabel="Read who's going again">
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
  // Both reads answered and the trip has no open plans: nothing to attend.
  if (plans.plans.length === 0) return null;

  const attendance = structure.structure.planAttendance;
  return (
    <View style={s.wrap} testID="plan-attendance-card">
      <Text style={s.heading}>Who&apos;s going</Text>
      {plans.plans.map((plan) => {
        const mine = myAttendance(attendance, plan.id, currentUserId);
        const going = goingCount(attendance, plan.id);
        const a = attempts[plan.id];
        const busy = a?.result === 'pending';
        const res = a && a.result !== 'pending' ? a.result : null;
        return (
          <View key={plan.id} style={s.row} testID={`plan-attendance-${plan.id}`}>
            <Users size={14} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{plan.title}</Text>
              <Text style={s.detail} testID={`plan-attendance-summary-${plan.id}`}>
                {going === null ? 'No one has answered yet' : `${going} going`} · {mine ? `You: ${LABEL[mine]}` : "You haven't answered"}
              </Text>
              <View style={s.buttons}>
                {OFFERED_ATTENDANCE.map((target) => (
                  <Pressable
                    key={target} disabled={busy || mine === target}
                    onPress={() => void send(plan.id, mine, target, attendanceKey(plan.id, target))}
                    style={[s.button, mine === target && s.buttonOn, busy && { opacity: 0.5 }]} testID={`plan-attendance-${plan.id}-${target}`}
                    accessibilityRole="button" accessibilityLabel={`${LABEL[target]} — ${plan.title}`} accessibilityState={{ selected: mine === target, disabled: busy || mine === target }}
                  >
                    <Text style={[s.buttonText, mine === target && s.buttonTextOn]}>{LABEL[target]}</Text>
                  </Pressable>
                ))}
                {mine !== null && mine !== 'left' ? (
                  <Pressable
                    disabled={busy} onPress={() => void send(plan.id, mine, 'leave', attendanceKey(plan.id, 'leave'))}
                    style={[s.button, busy && { opacity: 0.5 }]} testID={`plan-attendance-${plan.id}-leave`}
                    accessibilityRole="button" accessibilityLabel={`Leave — ${plan.title}`} accessibilityState={{ disabled: busy }}
                  >
                    <Text style={s.buttonText}>Leave</Text>
                  </Pressable>
                ) : null}
              </View>
              {busy ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID={`plan-attendance-busy-${plan.id}`} accessibilityLabel="Saving your answer" /> : null}
              {res?.state === 'recorded' ? (
                <View style={s.inline} testID={`plan-attendance-recorded-${plan.id}`}>
                  <CheckCircle2 size={12} color={color.success} />
                  <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>{a!.target === 'leave' ? 'You left this plan' : 'Answer saved'}{res.duplicate ? ' (already was)' : ''}</Text>
                </View>
              ) : res?.state === 'refused' ? (
                <Text style={[s.detail, { color: color.signalStrong }]} testID={`plan-attendance-refused-${plan.id}`}>Not changed — {res.detail}</Text>
              ) : res?.state === 'unavailable' ? (
                <View testID={`plan-attendance-unavailable-${plan.id}`}>
                  <Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was changed.</Text>
                  <Pressable onPress={() => void send(plan.id, a!.current, a!.target, a!.key)} style={s.button} testID={`plan-attendance-retry-${plan.id}`} accessibilityRole="button" accessibilityLabel={`Try your answer on ${plan.title} again`}>
                    <Text style={s.buttonText}>Try again</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingVertical: space.xs },
  heading: { ...t.small, fontWeight: '700', color: color.ink, paddingHorizontal: space.lg, paddingTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonOn: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  buttonTextOn: { color: '#fff' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
