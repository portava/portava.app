import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { PlanStop } from '../../services/layover.ts';
import { getExperiencePlan, changeExperiencePlan, experienceRequestId, experienceRefusalMessage, type ExperiencePlan } from '../../services/layoverExperiencePlans.ts';
import { fmtClock } from './layoverFormat.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { prepareExperienceOffline } from '../../lib/layoverExperienceCache.ts';
import { LayoverExperienceGeometry } from './LayoverExperienceGeometry.tsx';

export interface ExperienceStartReadiness { ok: boolean; reason?: string }
interface Props {
  sessionId: string; stops: PlanStop[]; timezone: string | null; canStart: boolean; refreshKey?: number;
  onChanged: () => void; beforeStart?: (plan: ExperiencePlan) => Promise<ExperienceStartReadiness>;
}
export function LayoverExperiencePlanCard(props: Props) {
  return <SessionExperiencePlanCard key={`${props.sessionId}:${props.stops.map(s => `${s.id}:${s.stopOrder}:${s.durationMin}:${s.travelMin}`).join('|')}`} {...props} />;
}
function SessionExperiencePlanCard({ sessionId, stops, timezone, canStart, refreshKey, onChanged, beforeStart }: Props) {
  const [plan, setPlan] = useState<ExperiencePlan | null>(null), [usable, setUsable] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null), [available, setAvailable] = useState(true);
  const mounted = useRef(true), busyRef = useRef(false), request = useRef<{ operation: 'select' | 'start'; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void getExperiencePlan(sessionId).then(r => {
      if (!current) return;
      if (!r.ok) { setAvailable(r.reason !== 'feature_disabled'); setUsable(false); setMessage(experienceRefusalMessage(r.reason)); return; }
      setPlan(r.plan); setUsable(r.usable); if (r.reason) setMessage(experienceRefusalMessage(r.reason));
    });
    return () => { current = false; };
  }, [sessionId, refreshKey]);
  const act = async (operation: 'select' | 'start') => {
    if (busyRef.current || !canStart || !available) return;
    if (operation === 'start' && (!plan || !usable || Date.parse(plan.contract.expiresAt) <= Date.now())) { setMessage('This plan check expired. Review a new timed experience.'); return; }
    busyRef.current = true; setBusy(true); setMessage(null);
    try {
      let offlineMessage: string | undefined;
      if (operation === 'start' && plan) {
        const ready = beforeStart ? await beforeStart(plan) : await prepareExperienceOffline(sessionId, plan);
        if (!mounted.current) return;
        if (!ready.ok) { setMessage(ready.reason ?? 'The return plan could not be saved for offline use.'); return; }
        offlineMessage = ready.reason;
      }
      if (request.current?.operation !== operation) request.current = { operation, id: experienceRequestId() };
      const result = await changeExperiencePlan(sessionId, operation, { requestId: request.current.id, expectedStopIds: stops.map(s => s.id), ...(operation === 'start' && plan ? { selectedPlanId: plan.id } : {}) });
      if (!mounted.current) return;
      if (!result.ok) { setMessage(experienceRefusalMessage(result.reason)); if (!result.uncertain) { setUsable(false); request.current = null; } return; }
      if (operation === 'start') {
        const saved = await prepareExperienceOffline(sessionId, result.plan);
        if (!mounted.current) return;
        offlineMessage = saved.ok ? saved.reason : 'The updated timetable could not be saved offline. Keep this current plan open and save it again before leaving.';
      }
      request.current = null; setPlan(result.plan); setUsable(true); setMessage(operation === 'start' ? `Experience started. Keep the return deadline in view.${offlineMessage ? ` ${offlineMessage}` : ''}` : 'Review the checked timetable before starting.'); onChanged();
    } catch { if (mounted.current) setMessage('Could not confirm the result. Retry the same action to check it safely.'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const saveOffline = async () => {
    if (!plan || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const saved = await prepareExperienceOffline(sessionId, plan);
      if (mounted.current) setMessage(saved.reason ?? 'The timetable could not be saved offline.');
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  if (!available || stops.length === 0 && !plan) return null;
  const expired = !!plan && Date.parse(plan.contract.expiresAt) <= Date.now();
  return <View testID="experience-plan-card" style={{ padding: space.lg, gap: space.sm, backgroundColor: color.paperRaised, borderRadius: radius.md }}>
    <Text style={{ ...t.bodyStrong, color: color.ink }}>Your timed experience</Text>
    <Text style={{ ...t.small, color: color.mute }}>Check the saved recommendation choices together, including the journey back.</Text>
    {plan ? <View testID="experience-plan-review" style={{ gap: space.xs }}>
      <Text style={{ ...t.bodyStrong, color: color.ink }}>{plan.phase === 'executing' ? 'In progress' : 'Ready to review'}</Text>
      {plan.contract.itinerary.map((step, i) => <Text key={i} style={{ ...t.small, color: color.ink }}>{fmtClock(step.startsAt, timezone)}–{fmtClock(step.endsAt, timezone)} · {step.kind === 'experience' ? 'Experience' : step.kind === 'return' ? 'Return to airport' : 'Travel to next stop'}</Text>)}
      <Text style={{ ...t.bodyStrong, color: color.ink }}>Back by {fmtClock(plan.contract.hardReturnBy, timezone)}</Text>
      <LayoverExperienceGeometry sessionId={sessionId} plan={plan} usable={usable&&!expired}/>
      <Text style={{ ...t.small, color: color.mute }}>If the plan becomes unavailable, {plan.contract.insideAirport ? 'remain inside the airport' : 'return to the airport'}.</Text>
      {!usable || expired && plan.phase === 'selected' ? <Text accessibilityRole="alert" style={{ ...t.small, color: color.warn }}>This plan needs a fresh check before starting.</Text> : null}
    </View> : null}
    {message ? <Text testID="experience-plan-message" accessibilityRole="alert" style={{ ...t.small, color: color.mute }}>{message}</Text> : null}
    {busy ? <ActivityIndicator /> : null}
    {canStart && plan?.phase !== 'executing' ? <Pressable disabled={busy || stops.length < 1 || stops.length > 6} accessibilityRole="button" onPress={() => { void act('select'); }}><Text style={{ ...t.bodyStrong, color: color.deep }}>Review timed experience</Text></Pressable> : null}
    {canStart && plan?.phase === 'selected' ? <Pressable disabled={busy || !usable || expired} accessibilityRole="button" onPress={() => { void act('start'); }}><Text style={{ ...t.bodyStrong, color: color.deep }}>Start experience</Text></Pressable> : null}
    {plan?.phase === 'executing' ? <Pressable disabled={busy} accessibilityRole="button" onPress={() => { void saveOffline(); }}><Text style={{ ...t.bodyStrong, color: color.deep }}>Save timetable offline</Text></Pressable> : null}
  </View>;
}
