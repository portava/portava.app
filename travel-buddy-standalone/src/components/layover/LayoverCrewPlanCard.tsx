/**
 * LayoverCrewPlanCard — §14.1 explicit split plans on the layover dashboard (census-layover L134, L135).
 *
 * "Unless an explicit split plan exists: member A leaves at T1, members B/C continue until T2. Crew plan must be
 * certified against every member branch."
 *
 * A SIBLING of `LayoverCrewSection` (like `LayoverCrewLocationCard`), never inside it: its own read must not join the
 * section's fetches. It draws NOTHING unless the server says split plans are on and this traveller is in a crew.
 *
 * ── THIS CARD DERIVES NO TIME AND DECIDES NO FEASIBILITY ──────────────────────
 * Every verdict here is the server's, re-certified against each member's own layover on every read. The card picks
 * times only as PROPOSALS ("back at the airport by"), and a proposal that does not certify comes back refused with the
 * server's reasons, which are shown — nothing is saved. A branch without a readable verdict is "not certified".
 * Crewmates the traveller cannot see (blocked, paused) are never offered by name; they are counted, and they are in
 * "everyone else" — certified against their own layover like everybody.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { GitBranch, CheckCircle2, AlertTriangle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fmtClock } from './layoverFormat.ts';
import { getLayoverCrew, type CrewMemberCard } from '../../services/layover.ts';
import {
  crewPlanReasonText, getCrewPlan, proposeCrewPlan, withdrawCrewPlan,
  type CrewPlan, type CrewPlanBranch,
} from '../../services/layoverCrewPlan.ts';

interface Props {
  sessionId: string;
  timezone: string | null;
  refreshKey?: number;
  /** Injected for tests; defaults to the device clock. */
  now?: () => number;
}

/** Proposal steps: a T moves in 15-minute steps, starting an hour (T1) / two hours (T2) from now. */
export const CREW_PLAN_STEP_MS = 15 * 60_000;

type Load =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; plan: CrewPlan | null };

function roundUp(ms: number): number { return Math.ceil(ms / CREW_PLAN_STEP_MS) * CREW_PLAN_STEP_MS; }

function memberLabel(m: CrewMemberCard): string { return m.name ?? (m.handle ? `@${m.handle}` : 'A crewmate'); }

export function LayoverCrewPlanCard({ sessionId, timezone, refreshKey = 0, now = Date.now }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [composing, setComposing] = useState(false);
  const [mates, setMates] = useState<CrewMemberCard[] | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set(['me']));
  const [t1, setT1] = useState(0);
  const [t2, setT2] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refused, setRefused] = useState<CrewPlan | null>(null);
  const ticket = useRef(0);
  /** The last ANSWERED read said: feature on, and this traveller is in a crew. A failed read before that draws nothing. */
  const known = useRef(false);

  const refresh = useCallback(async () => {
    const mine = ++ticket.current;
    const r = await getCrewPlan(sessionId);
    if (mine !== ticket.current) return;
    if (!r.ok) { setLoad(known.current ? { kind: 'failed', message: r.message } : { kind: 'hidden' }); return; }
    known.current = r.available && r.inCrew;
    if (!r.available || !r.inCrew) { setLoad({ kind: 'hidden' }); return; }
    setLoad({ kind: 'ready', plan: r.plan });
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const startComposing = useCallback(async () => {
    setNotice(null); setRefused(null);
    const crew = await getLayoverCrew(sessionId);
    if (!crew || !crew.inCrew) { setNotice('Your crew could not be loaded. Please try again.'); return; }
    setMates(crew.members);
    const base = roundUp(now());
    setT1(base + 60 * 60_000);
    setT2(base + 2 * 60 * 60_000);
    setLeaving(new Set(['me']));
    setComposing(true);
  }, [sessionId, now]);

  const propose = useCallback(async () => {
    const ids = [...leaving].filter((id) => id !== 'me');
    if (leaving.size === 0) { setNotice('Choose who heads back first.'); return; }
    setBusy(true); setNotice(null); setRefused(null);
    const out = await proposeCrewPlan(sessionId, {
      branches: [{ memberIds: ids, includeMe: leaving.has('me'), returnBy: new Date(t1).toISOString() }],
      rest: { returnBy: new Date(t2).toISOString() },
    });
    setBusy(false);
    if (!out.ok) { setNotice(out.message); setRefused(out.notCertified); return; }
    setComposing(false);
    await refresh();
  }, [leaving, sessionId, t1, t2, refresh]);

  const withdraw = useCallback(async () => {
    setBusy(true); setNotice(null);
    const out = await withdrawCrewPlan(sessionId);
    setBusy(false);
    if (!out.ok) { setNotice(out.message); return; }
    await refresh();
  }, [sessionId, refresh]);

  if (load.kind === 'hidden') return null;
  if (load.kind === 'loading') return null;
  if (load.kind === 'failed') {
    return (
      <View style={styles.card} testID="layover-crew-plan-failed">
        <Header />
        <Text style={styles.body}>{load.message}</Text>
      </View>
    );
  }

  const plan = load.plan;
  return (
    <View style={styles.card} testID="layover-crew-plan">
      <Header />
      {plan ? (
        <View style={{ gap: space.sm }}>
          <View style={styles.statusRow} testID={plan.feasible ? 'layover-crew-plan-certified' : 'layover-crew-plan-not-certified'}>
            {plan.feasible ? <CheckCircle2 size={13} color={color.deep} /> : <AlertTriangle size={13} color={color.warn} />}
            <Text style={styles.body}>
              {plan.feasible
                ? 'Certified against every crewmate’s own layover.'
                : 'Not certified right now — at least one group no longer fits someone’s layover.'}
            </Text>
          </View>
          {plan.branches.map((b) => <BranchRow key={b.key} b={b} timezone={timezone} />)}
          {plan.certifiedAt ? <Text style={styles.footnote}>Checked {fmtClock(plan.certifiedAt, timezone)}. Each crewmate still checks their own gate.</Text> : null}
          <Pressable onPress={() => { void withdraw(); }} disabled={busy} accessibilityRole="button" accessibilityLabel="Withdraw the split plan" style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Withdraw plan</Text>
          </Pressable>
        </View>
      ) : !composing ? (
        <View style={{ gap: space.sm }}>
          <Text style={styles.body}>No split. Everyone follows the crew’s shared deadline.</Text>
          <Pressable onPress={() => { void startComposing(); }} accessibilityRole="button" accessibilityLabel="Propose a split" style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Propose a split</Text>
          </Pressable>
        </View>
      ) : null}

      {composing ? (
        <View style={styles.composer} testID="layover-crew-plan-composer">
          <Text style={styles.label}>Who heads back first?</Text>
          {[{ id: 'me', label: 'You' }, ...(mates ?? []).map((m) => ({ id: m.id, label: memberLabel(m) }))].map((o) => {
            const on = leaving.has(o.id);
            return (
              <Pressable
                key={o.id}
                onPress={() => { const next = new Set(leaving); if (on) next.delete(o.id); else next.add(o.id); setLeaving(next); }}
                accessibilityRole="checkbox"
                accessibilityLabel={`${o.label} heads back first`}
                accessibilityState={{ checked: on }}
                style={[styles.choice, on ? styles.choiceOn : null]}
              >
                <Text style={styles.body}>{o.label}</Text>
              </Pressable>
            );
          })}
          <TimeStepper label="First group back at the airport by" value={t1} timezone={timezone} onChange={setT1} testID="layover-crew-plan-t1" />
          <TimeStepper label="Everyone else back by" value={t2} timezone={timezone} onChange={setT2} testID="layover-crew-plan-t2" />
          <View style={styles.actions}>
            <Pressable onPress={() => { setComposing(false); setRefused(null); setNotice(null); }} accessibilityRole="button" accessibilityLabel="Cancel the split" style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => { void propose(); }} disabled={busy} accessibilityRole="button" accessibilityLabel="Propose this split" accessibilityState={{ busy }} style={styles.primaryBtn}>
              {busy ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={styles.primaryBtnText}>Propose</Text>}
            </Pressable>
          </View>
        </View>
      ) : null}

      {refused ? (
        <View style={{ gap: space.xs }} testID="layover-crew-plan-refused">
          {refused.branches.map((b) => <BranchRow key={b.key} b={b} timezone={timezone} />)}
        </View>
      ) : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </View>
  );
}

function BranchRow({ b, timezone }: { b: CrewPlanBranch; timezone: string | null }) {
  const who = [b.includesYou ? 'You' : null, b.memberIds.length - (b.includesYou ? 1 : 0) > 0 ? `${b.memberIds.length - (b.includesYou ? 1 : 0)} crewmate${b.memberIds.length - (b.includesYou ? 1 : 0) === 1 ? '' : 's'}` : null, b.hiddenMemberCount > 0 ? `${b.hiddenMemberCount} not showing a profile` : null].filter(Boolean).join(', ');
  return (
    <View style={styles.branch} testID={`layover-crew-plan-branch-${b.key}`}>
      <Text style={styles.branchTitle}>{b.key === 'rest' ? 'Everyone else' : 'Heads back first'} — back by {fmtClock(b.returnBy, timezone)}</Text>
      <Text style={styles.footnote}>{who || 'Nobody'}</Text>
      {b.feasible && b.landside === 'caution' ? <Text style={styles.footnote} testID={`layover-crew-plan-branch-${b.key}-caution`}>Leaves the airport: each crewmate checks their own entry before going.</Text> : null}
      {b.feasible
        ? <Text style={styles.ok} testID={`layover-crew-plan-branch-${b.key}-ok`}>Fits everyone in this group.</Text>
        : (b.reasons.length > 0 ? b.reasons : ['not_certified']).map((r) => <Text key={r} style={styles.warnText}>{crewPlanReasonText(r)}</Text>)}
    </View>
  );
}

function TimeStepper({ label, value, timezone, onChange, testID }: { label: string; value: number; timezone: string | null; onChange: (v: number) => void; testID: string }) {
  return (
    <View style={styles.stepper} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.actions}>
        <Pressable onPress={() => onChange(value - CREW_PLAN_STEP_MS)} accessibilityRole="button" accessibilityLabel={`${label}: 15 minutes earlier`} style={styles.stepBtn}><Text style={styles.secondaryBtnText}>−15</Text></Pressable>
        <Text style={styles.stepValue}>{fmtClock(new Date(value).toISOString(), timezone)}</Text>
        <Pressable onPress={() => onChange(value + CREW_PLAN_STEP_MS)} accessibilityRole="button" accessibilityLabel={`${label}: 15 minutes later`} style={styles.stepBtn}><Text style={styles.secondaryBtnText}>+15</Text></Pressable>
      </View>
    </View>
  );
}

function Header() {
  return (
    <View style={styles.headerRow}>
      <GitBranch size={15} color={color.deep} />
      <Text style={styles.heading}>Crew plan</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  heading: { ...t.heading, color: color.ink },
  body: { ...t.small, color: color.ink },
  label: { ...t.small, color: color.mute, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  branch: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.md, gap: 2 },
  branchTitle: { ...t.small, color: color.ink, fontWeight: '600' },
  ok: { ...t.small, color: color.deep, fontSize: 12 },
  warnText: { ...t.small, color: color.warn, fontSize: 12, lineHeight: 17 },
  footnote: { ...t.small, color: color.faint, fontSize: 11 },
  notice: { ...t.small, color: color.warn },
  composer: { gap: space.sm },
  choice: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.sm, minHeight: 36, justifyContent: 'center' },
  choiceOn: { borderColor: color.deep, borderWidth: 1.5 },
  stepper: { gap: space.xs },
  stepBtn: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  stepValue: { ...t.bodyStrong, color: color.ink, minWidth: 64, textAlign: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  primaryBtn: { backgroundColor: color.deep, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.lg, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.lg, minHeight: 36, alignSelf: 'flex-start' },
  secondaryBtnText: { ...t.small, color: color.deep, fontWeight: '600' },
});
