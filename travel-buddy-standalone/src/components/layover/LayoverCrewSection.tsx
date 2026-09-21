/**
 * LayoverCrewSection — §14 Layover Crew on the layover dashboard.
 *
 * census-layover L28/L29 (`layover_crews`, `layover_crew_members`) read
 * "Absent."; L131 (§14 "L3 crew formed") and L185/L186/L188
 * (`LayoverCrewService.create/join/leave`) read N with the reason "No crew."
 * The §14.1 constraint solver was never missing — `certifyCrewPlan` has
 * computed `shared_return_by = min(member.required_return_by)`, per-branch
 * feasibility and split plans for several census passes, purely. It had no
 * crew. This screen is where a traveller makes one.
 *
 * ── THIS SECTION DERIVES NO TIME ─────────────────────────────────────────────
 * `sharedReturnBy`, `feasible`, `reasons` and every member's
 * `requiredReturnBy` arrive certified from the server. Nothing here takes a
 * minimum, compares two instants or decides whether a crew works. That rule is
 * not stylistic: `LayoverReturnPanel.tsx` was deleted at `a718beb5` for
 * carrying its own `usableMinutes < 30 / < 60` thresholds that existed nowhere
 * on the server (census L2, L6), and a second opinion about a SHARED deadline
 * would be the same defect with more people relying on it.
 *
 * In particular, `sharedReturnBy === null` is rendered as "not certified" and
 * NEVER replaced by the earliest time this client can see. The server returns
 * null when any member is uncertified precisely because a minimum over the
 * readable subset is a LATER deadline than the truth — the one direction a
 * safety minimum must not move — and helpfully filling it in here would undo
 * that on the last hop.
 *
 * ── memberCount IS NOT members.length ────────────────────────────────────────
 * A crewmate who has blocked you, paused sharing, or gone into ghost mode is
 * still in the crew and still binds the shared deadline; they simply have no
 * card, because the server runs member cards through the same blocks +
 * `publishableUserIds` + `nameVisibilitySet` pipeline the presence surface
 * uses. The headcount comes from `crew.memberCount` and the faces from
 * `members`, and where they differ this section says so rather than quietly
 * showing a smaller crew.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput } from 'react-native';
import { Users, UserPlus, LogOut, AlertTriangle, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fmtClock } from './layoverFormat.ts';
import {
  createLayoverCrew,
  getLayoverCrew,
  joinLayoverCrew,
  leaveLayoverCrew,
  type CrewActionOutcome,
  type CrewInfeasibilityReason,
  type CrewState,
} from '../../services/layover.ts';

/**
 * The server's reason codes, in a traveller's words.
 *
 * Every one of these is a real state `certifyCrewPlan` can return, and none of
 * them is an error: an infeasible crew plan is a true answer about a group of
 * people with different flights. Showing the raw code would make it look like a
 * fault.
 */
const REASON_TEXT: Record<CrewInfeasibilityReason, string> = {
  no_members: 'This crew has nobody in it yet.',
  member_without_certified_feasibility:
    'One crewmate’s layover could not be certified, so the shared deadline is not settled.',
  member_unassigned: 'Someone in this crew is not on the plan.',
  member_assigned_twice: 'Someone in this crew is on the plan twice.',
  unknown_member_in_branch: 'The plan names someone who is not in the crew.',
  empty_branch: 'Part of the plan has nobody doing it.',
  plan_exceeds_usable_minutes: 'The plan needs more time than the tightest crewmate has.',
  plan_ends_after_shared_return: 'The plan would finish after the crew has to be back.',
};

interface Props {
  sessionId: string;
  timezone: string | null;
  /** Bumped by the parent on pull-to-refresh so this section reloads with it. */
  refreshKey?: number;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; state: CrewState };

export function LayoverCrewSection({ sessionId, timezone, refreshKey = 0 }: Props) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [meetingPoint, setMeetingPoint] = useState('');

  const refresh = useCallback(async () => {
    const state = await getLayoverCrew(sessionId);
    // `null` is a FAILED READ, not "you are in no crew" — see the header.
    setLoad(state ? { kind: 'ready', state } : { kind: 'unavailable' });
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const apply = useCallback(async (key: string, run: () => Promise<CrewActionOutcome>) => {
    setBusy(key);
    setNotice(null);
    const outcome = await run();
    setBusy(null);
    if (!outcome.ok) { setNotice(outcome.message); return; }
    setComposing(false);
    setTitle('');
    setMeetingPoint('');
    // Re-read rather than trusting the action's own body, so what the section
    // shows is what a fresh load would show. That is what makes the flow
    // survive a reload rather than only look as if it had.
    await refresh();
  }, [refresh]);

  if (load.kind === 'loading') {
    return (
      <View style={styles.card}>
        <Header />
        <ActivityIndicator color={color.deep} style={{ marginTop: space.md }} />
      </View>
    );
  }

  if (load.kind === 'unavailable') {
    return (
      <View style={styles.card}>
        <Header />
        <Text style={styles.body}>Your crew could not be loaded.</Text>
        <Pressable
          onPress={() => { setLoad({ kind: 'loading' }); void refresh(); }}
          accessibilityRole="button"
          accessibilityLabel="Retry loading your crew"
          style={styles.retry}
        >
          <RefreshCw size={13} color={color.deep} />
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const state = load.state;

  if (state.inCrew) {
    const { crew, solution, members } = state;
    const hidden = Math.max(0, crew.memberCount - 1 - members.length);
    return (
      <View style={styles.card}>
        <Header />
        <Text style={styles.crewTitle}>{crew.title}</Text>
        {crew.meetingPointLabel ? (
          <Text style={styles.meetingPoint}>Meeting at {crew.meetingPointLabel}</Text>
        ) : null}

        {/* §14.1. The shared deadline, certified, or an honest refusal. */}
        <View style={styles.deadlineBlock}>
          {solution.sharedReturnBy ? (
            <>
              <Text style={styles.deadlineLabel}>Everyone must be back by</Text>
              <Text style={styles.deadline}>{fmtClock(solution.sharedReturnBy, timezone)}</Text>
              <Text style={styles.deadlineNote}>
                The earliest deadline in the crew, so it is everyone&rsquo;s.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.deadlineLabel}>Shared deadline</Text>
              <Text style={styles.deadlineAbsent}>Not certified</Text>
              <Text style={styles.deadlineNote}>
                A crewmate&rsquo;s layover could not be certified. We will not show a
                deadline that could be later than the real one.
              </Text>
            </>
          )}
        </View>

        {!solution.feasible && solution.reasons.length > 0 ? (
          <View style={styles.warnBlock}>
            <AlertTriangle size={13} color={color.warn} />
            <View style={{ flex: 1, gap: 2 }}>
              {solution.reasons.map((r) => (
                <Text key={r} style={styles.warnText}>{REASON_TEXT[r] ?? r}</Text>
              ))}
            </View>
          </View>
        ) : null}

        <Text style={styles.memberHeading}>
          {crew.memberCount === 1 ? 'Just you so far' : `${crew.memberCount} travellers`}
        </Text>
        {members.length > 0 ? (
          <View style={styles.memberList}>
            {members.map((m) => (
              <Text key={m.id} style={styles.memberName}>
                {m.name ?? (m.handle ? `@${m.handle}` : 'A traveller')}
              </Text>
            ))}
          </View>
        ) : null}
        {hidden > 0 ? (
          // NOT hidden from the count. See the header: these people bind the
          // shared deadline whether or not you can see a card for them.
          <Text style={styles.hiddenNote}>
            {hidden === 1 ? '1 crewmate is' : `${hidden} crewmates are`} not showing a profile.
          </Text>
        ) : null}
        {state.degraded ? (
          <Text style={styles.hiddenNote}>Some crewmate details could not be loaded.</Text>
        ) : null}

        <Pressable
          onPress={() => { void apply('leave', () => leaveLayoverCrew(sessionId)); }}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel={crew.youAreOwner ? 'Disband this crew' : 'Leave this crew'}
          accessibilityState={{ disabled: busy !== null, busy: busy === 'leave' }}
          style={styles.secondaryBtn}
        >
          {busy === 'leave'
            ? <ActivityIndicator size="small" color={color.deep} />
            : <><LogOut size={13} color={color.deep} /><Text style={styles.secondaryBtnText}>
                {crew.youAreOwner ? 'Disband crew' : 'Leave crew'}
              </Text></>}
        </Pressable>
        {crew.youAreOwner ? (
          <Text style={styles.footnote}>
            Disbanding closes the crew for everyone — a crew outliving the layover that
            made it would be certified against a deadline that has passed.
          </Text>
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </View>
    );
  }

  // Not in a crew: the openings here, and the way to make one.
  return (
    <View style={styles.card}>
      <Header />
      {state.city ? (
        <Text style={styles.subhead}>Meet other travellers on a layover in {state.city}.</Text>
      ) : (
        <Text style={styles.subhead}>
          We do not know which city this layover is in yet, so there is no crew to join.
        </Text>
      )}

      {state.crews.length > 0 ? (
        <View style={styles.openings}>
          {state.crews.map((c) => (
            <View key={c.id} style={styles.opening}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.openingTitle}>{c.title}</Text>
                {c.meetingPointLabel ? (
                  <Text style={styles.openingMeta}>{c.meetingPointLabel}</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => { void apply(`join:${c.id}`, () => joinLayoverCrew(sessionId, c.id)); }}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel={`Join crew ${c.title}`}
                accessibilityState={{ disabled: busy !== null, busy: busy === `join:${c.id}` }}
                style={styles.joinBtn}
              >
                {busy === `join:${c.id}`
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={styles.joinBtnText}>Join</Text>}
              </Pressable>
            </View>
          ))}
        </View>
      ) : state.city ? (
        <Text style={styles.body}>No crews here yet. Start one.</Text>
      ) : null}

      {state.city ? (
        composing ? (
          <View style={styles.composer}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What are you doing? e.g. Ramen in the old town"
              placeholderTextColor={color.faint}
              maxLength={120}
              accessibilityLabel="Crew title"
              style={styles.input}
            />
            <TextInput
              value={meetingPoint}
              onChangeText={setMeetingPoint}
              placeholder="Where to meet (optional) — e.g. Terminal 2 food court"
              placeholderTextColor={color.faint}
              maxLength={200}
              accessibilityLabel="Meeting point"
              style={styles.input}
            />
            {/* A LABEL, never a position. §14's crew-member map element is gated
                on an explicit temporary location permission whose grant store
                does not exist, so nothing here collects a coordinate. */}
            <View style={styles.composerActions}>
              <Pressable
                onPress={() => { setComposing(false); setNotice(null); }}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (!title.trim()) { setNotice('Give your crew a name first.'); return; }
                  void apply('create', () => createLayoverCrew(sessionId, {
                    title: title.trim(),
                    meetingPointLabel: meetingPoint.trim() || null,
                  }));
                }}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel="Create crew"
                accessibilityState={{ disabled: busy !== null, busy: busy === 'create' }}
                style={styles.primaryBtn}
              >
                {busy === 'create'
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={styles.primaryBtnText}>Create crew</Text>}
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={() => { setComposing(true); setNotice(null); }}
            accessibilityRole="button"
            accessibilityLabel="Start a crew"
            style={styles.secondaryBtn}
          >
            <UserPlus size={13} color={color.deep} />
            <Text style={styles.secondaryBtnText}>Start a crew</Text>
          </Pressable>
        )
      ) : null}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </View>
  );
}

function Header() {
  return (
    <View style={styles.headerRow}>
      <Users size={15} color={color.deep} />
      <Text style={styles.heading}>Layover crew</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  heading: { ...t.heading, color: color.ink },
  subhead: { ...t.small, color: color.mute },
  body: { ...t.small, color: color.ink },
  crewTitle: { ...t.bodyStrong, color: color.ink, marginTop: space.xs },
  meetingPoint: { ...t.small, color: color.mute },
  deadlineBlock: {
    backgroundColor: 'rgba(10,61,74,0.05)',
    borderRadius: radius.sm,
    padding: space.md,
    marginTop: space.xs,
    gap: 2,
  },
  deadlineLabel: {
    ...t.small, color: color.mute, fontSize: 11, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  deadline: { ...t.title, color: color.deep },
  deadlineAbsent: { ...t.heading, color: color.faint },
  deadlineNote: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 17 },
  warnBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    backgroundColor: 'rgba(200,133,26,0.08)',
    borderRadius: radius.sm,
    padding: space.sm,
  },
  warnText: { ...t.small, color: color.ink, fontSize: 12, lineHeight: 17 },
  memberHeading: { ...t.bodyStrong, color: color.ink, marginTop: space.xs },
  memberList: { gap: 2 },
  memberName: { ...t.small, color: color.ink },
  hiddenNote: { ...t.small, color: color.faint, fontSize: 12 },
  openings: { gap: space.sm, marginTop: space.xs },
  opening: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    padding: space.md,
  },
  openingTitle: { ...t.small, color: color.ink, fontWeight: '600' },
  openingMeta: { ...t.small, color: color.mute, fontSize: 12 },
  joinBtn: {
    backgroundColor: color.deep,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  composer: { gap: space.sm, marginTop: space.xs },
  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    minHeight: 40,
    color: color.ink,
    ...t.small,
  },
  composerActions: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  primaryBtn: {
    backgroundColor: color.deep,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    minHeight: 36,
    alignSelf: 'flex-start',
    marginTop: space.xs,
  },
  secondaryBtnText: { ...t.small, color: color.deep, fontWeight: '600' },
  notice: { ...t.small, color: color.warn, marginTop: space.xs },
  footnote: { ...t.small, color: color.faint, fontSize: 11 },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.sm,
    alignSelf: 'flex-start',
    minHeight: 36,
  },
  retryText: { ...t.small, color: color.deep, fontWeight: '600' },
});
