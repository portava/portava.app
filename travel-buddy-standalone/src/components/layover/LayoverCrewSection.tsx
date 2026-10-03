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
 *
 * ── NO COORDINATE, ANYWHERE ──────────────────────────────────────────────────
 * The crew payload publishes a §14 PRECISION RUNG per member
 * (`locationRungs`) and never a position — 3514 stores permission, and the
 * assertion that the crew tables hold no coordinate is deliberate, not an
 * oversight waiting to be filled in. So `precise` is rendered as "sharing their
 * precise location with the crew" and NOT as a place: a dot on a map here would
 * be a claim the server never made, built out of a permission it is only
 * entitled to describe.
 *
 * ── "COULD NOT BE READ" IS NOT "NOT SHARING" ─────────────────────────────────
 * Every member reads at the `meeting_point` rung both when nobody has shared
 * and when the grant table could not be read, which is why the server reports
 * `location_grants_unreadable` beside the rungs. This section renders that
 * reason as its own sentence and SUPPRESSES the per-member rung list under it.
 * Showing the list would tell the traveller who just tapped "share my location"
 * that it reached nobody — a sentence that is false and that they would act on.
 *
 * ── THE TOGGLE READS `yourShare`, NEVER YOUR OWN RUNG ────────────────────────
 * `locationPrecisionFor` answers `precise` with reason `self` for the viewer
 * before it looks at a grant at all, so the viewer's own rung is a tautology and
 * cannot say whether they are sharing. `yourShare` is judged by
 * `evaluateCrewLocationShare` with no self short-circuit and is the only field
 * the control may read. Its THREE states each get their own rendering: live
 * (stop sharing, with the server's expiry in words), not live (share, with the
 * terminator named where that helps), and UNKNOWN — `null`, the server saying it
 * could not tell, or the field absent entirely. Unknown offers no confident
 * affordance, because a "Share my location" button over an unknown state is the
 * screen answering "no" on the server's behalf.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput, Switch } from 'react-native';
import {
  Users, UserPlus, LogOut, AlertTriangle, RefreshCw,
  MapPin, Plus, Trash2, X, Split, EyeOff,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';
import {
  assignCrewBranches,
  createLayoverCrew,
  getLayoverCrew,
  grantCrewLocation,
  joinLayoverCrew,
  leaveLayoverCrew,
  proposeCrewStop,
  removeCrewStop,
  revokeCrewLocation,
  CREW_LOCATION_GRANTS_UNREADABLE,
  type CrewActionOutcome,
  type CrewBranchVerdict,
  type CrewInfeasibilityReason,
  type CrewItineraryStop,
  type CrewLocationPrecision,
  type CrewMemberCard,
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

/**
 * §14's rungs, in a traveller's words. A RUNG, NEVER A PLACE — see the header.
 *
 * `precise` is the only rung that means somebody said yes, and it still comes
 * with no position: it is written as what the crewmate has PERMITTED, which is
 * the whole of what the server published.
 */
const PRECISION_TEXT: Record<CrewLocationPrecision, string> = {
  none: 'Not shared with you',
  city: 'City only',
  meeting_point: 'The meeting point only',
  precise: 'Sharing their precise location with the crew',
};

/**
 * Why your own share is not live, where that tells the traveller something.
 *
 * `never_granted` is deliberately ABSENT: it is the default state every crew
 * starts in, and "you have never shared your location" under a button that says
 * "Share my location" is a sentence that adds nothing. `not_a_member` is absent
 * too — a viewer the roster does not hold has a larger problem than this line.
 *
 * AN UNKNOWN REASON GETS NO COPY. A newer server may name a terminator this
 * build has never heard of; it must not be given an invented sentence, which is
 * the same rule `layoverReasonCodes` holds for Appendix A.
 */
const SHARE_ENDED_TEXT: Record<string, string> = {
  'no_live_grant:user_revoked': 'You stopped sharing.',
  'no_live_grant:ttl_elapsed': 'Your last share ran out on its own.',
  'no_live_grant:boarding': 'Your last share ended when you boarded.',
  'no_live_grant:session_expired': 'Your last share ended with that layover.',
  'no_live_grant:crew_dissolved': 'Your last share ended when that crew did.',
  'no_live_grant:airport_reentry': 'Your last share ended when you got back to the airport.',
};

/** The unsplit branch's id, as the server defaults a stop to (`UNSPLIT_BRANCH_ID`). */
const UNSPLIT_BRANCH_ID = 'all';
/** The second group a split makes. The first keeps the unsplit id, so an
 *  un-split returns to exactly the state it came from. */
const SPLIT_BRANCH_ID = 'b';

const DUR_CHOICES = [30, 45, 60, 90, 120];
/**
 * No zero, for the reason `LayoverPlanSection` states: a landside stop reached
 * in no time is not a journey, and the server now REFUSES a stated
 * `travelMin: 0` outside the airport (`landsideTravelRefusal`). Offering the
 * chip would only produce an error, so it is not offered.
 */
const TRAVEL_CHOICES = [10, 20, 30, 45, 60];

function branchLabel(branchId: string): string {
  if (branchId === UNSPLIT_BRANCH_ID) return 'Everyone';
  if (branchId === SPLIT_BRANCH_ID) return 'Second group';
  return branchId;
}

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
  const [proposing, setProposing] = useState(false);
  const [stopTitle, setStopTitle] = useState('');
  const [stopBranchId, setStopBranchId] = useState(UNSPLIT_BRANCH_ID);
  const [durationMin, setDurationMin] = useState(60);
  const [travelMin, setTravelMin] = useState(20);
  const [insideAirport, setInsideAirport] = useState(false);
  /**
   * The split being composed: userId → branchId. NULL when nobody is editing
   * one, which is a different state from "an empty split" — an empty
   * assignment list is the request that puts the crew back together, so the two
   * must not share a representation.
   */
  const [splitDraft, setSplitDraft] = useState<Record<string, string> | null>(null);

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
    setProposing(false);
    setStopTitle('');
    setSplitDraft(null);
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

    // ── Who is who ────────────────────────────────────────────────────────────
    // `solution.members` is the WHOLE membership (every member binds the
    // deadline, card or no card); `members` is only the faces this viewer is
    // entitled to. Joining on the CARDS and not on the rungs is the server's own
    // instruction: a blocked member has a rung and no card.
    const youId = state.locationRungs?.find((r) => r.reason === 'self')?.userId ?? null;
    const nameFor = (userId: string): string => {
      if (userId === youId) return 'You';
      const card: CrewMemberCard | undefined = members.find((m) => m.id === userId);
      if (!card) return 'A crewmate';
      return card.name ?? (card.handle ? `@${card.handle}` : 'A traveller');
    };

    const stops: CrewItineraryStop[] = state.itinerary?.stops ?? [];
    const branches: CrewBranchVerdict[] = solution.branches ?? [];
    const branchIds = solution.split && branches.length > 0
      ? branches.map((b) => b.branchId)
      : [UNSPLIT_BRANCH_ID];
    const ceiling = state.itinerary?.maxStopsPerBranch ?? 0;
    const inTargetBranch = stops.filter((s) => s.branchId === stopBranchId).length;
    const branchFull = ceiling > 0 && inTargetBranch >= ceiling;

    // The grant table could not be read. NOT "nobody is sharing" — see header.
    const grantsUnreadable =
      state.degraded && state.degradedReasons.includes(CREW_LOCATION_GRANTS_UNREADABLE);

    // YOUR OWN SHARE, IN THREE STATES. `yourShare` absent means this server
    // publishes no such field; `null` means it published one saying it could not
    // tell. Neither is "no", so neither gets a confident affordance.
    const shareStated = 'yourShare' in state && state.yourShare != null;
    const share = shareStated ? state.yourShare! : null;
    const shareUnknown = !shareStated;
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

        {/* ── §14.1 THE CREW'S ITINERARY ───────────────────────────────────────
            Rendered ONLY when the server published the block. An absent
            `itinerary` is a server that said nothing about the crew's plan, and
            drawing "no stops yet" over it would be this section answering a
            question nobody asked it. */}
        {state.itinerary ? (
          <View testID="crew-itinerary" style={styles.subBlock}>
            <Text style={styles.memberHeading}>The crew&rsquo;s plan</Text>
            {stops.length === 0 ? (
              <Text testID="crew-itinerary-empty" style={styles.body}>
                Nobody has proposed a stop yet.
              </Text>
            ) : (
              stops.map((s) => (
                <View key={s.id} testID={`crew-stop-${s.id}`} style={styles.stopRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.stopTitle} numberOfLines={2}>{s.title}</Text>
                    <View style={styles.stopMeta}>
                      <Text style={styles.metaStamp}>{fmtDur(s.durationMin)}</Text>
                      {!s.insideAirport && s.travelMin > 0 ? (
                        <Text style={styles.metaStamp}>+{s.travelMin}m travel</Text>
                      ) : null}
                      {s.insideAirport ? (
                        <Text style={[styles.metaStamp, { color: color.deep }]}>in airport</Text>
                      ) : null}
                      {/* A LABEL the proposer typed, never a position. */}
                      {s.locationLabel ? (
                        <Text style={styles.metaStamp} numberOfLines={1}>{s.locationLabel}</Text>
                      ) : null}
                      {solution.split ? (
                        <Text style={styles.metaStamp}>{branchLabel(s.branchId)}</Text>
                      ) : null}
                    </View>
                    <Text style={styles.hiddenNote}>Proposed by {nameFor(s.proposedBy)}</Text>
                  </View>
                  <Pressable
                    onPress={() => { void apply(`stop-rm:${s.id}`, () => removeCrewStop(sessionId, s.id)); }}
                    disabled={busy !== null}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${s.title} from the crew plan`}
                    accessibilityState={{ disabled: busy !== null, busy: busy === `stop-rm:${s.id}` }}
                  >
                    {busy === `stop-rm:${s.id}`
                      ? <ActivityIndicator size="small" color={color.deep} />
                      : <Trash2 size={16} color={color.signalDim} />}
                  </Pressable>
                </View>
              ))
            )}

            {proposing ? (
              <View testID="crew-stop-form" style={styles.composer}>
                <TextInput
                  value={stopTitle}
                  onChangeText={setStopTitle}
                  placeholder="What should the crew do? e.g. Ramen in the old town"
                  placeholderTextColor={color.faint}
                  maxLength={120}
                  accessibilityLabel="Stop title"
                  style={styles.input}
                />
                <Text style={styles.formLabel}>How long there?</Text>
                <View style={styles.chipRow}>
                  {DUR_CHOICES.map((d) => (
                    <Pressable
                      key={d}
                      onPress={() => setDurationMin(d)}
                      accessibilityRole="button"
                      accessibilityLabel={`Stay ${fmtDur(d)}`}
                      accessibilityState={{ selected: durationMin === d }}
                      style={[styles.chip, durationMin === d && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, durationMin === d && styles.chipTextActive]}>
                        {fmtDur(d)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {!insideAirport ? (
                  <>
                    <Text style={styles.formLabel}>Travel time (one way)</Text>
                    <View style={styles.chipRow}>
                      {TRAVEL_CHOICES.map((d) => (
                        <Pressable
                          key={d}
                          onPress={() => setTravelMin(d)}
                          accessibilityRole="button"
                          accessibilityLabel={`${d} minutes travel`}
                          accessibilityState={{ selected: travelMin === d }}
                          style={[styles.chip, travelMin === d && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, travelMin === d && styles.chipTextActive]}>
                            {`${d}m`}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                ) : null}
                <View style={styles.switchRow}>
                  <Text style={styles.formLabel}>Inside the airport</Text>
                  <Switch
                    value={insideAirport}
                    onValueChange={setInsideAirport}
                    accessibilityLabel="Inside the airport"
                    trackColor={{ true: color.deep, false: color.haze }}
                  />
                </View>
                {solution.split && branchIds.length > 1 ? (
                  <>
                    <Text style={styles.formLabel}>Which group is this for?</Text>
                    <View style={styles.chipRow}>
                      {branchIds.map((id) => (
                        <Pressable
                          key={id}
                          onPress={() => setStopBranchId(id)}
                          accessibilityRole="button"
                          accessibilityLabel={`For ${branchLabel(id)}`}
                          accessibilityState={{ selected: stopBranchId === id }}
                          style={[styles.chip, stopBranchId === id && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, stopBranchId === id && styles.chipTextActive]}>
                            {branchLabel(id)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                ) : null}
                {branchFull ? (
                  // The server's own ceiling, named rather than discovered as a
                  // refusal after the traveller has typed the stop out.
                  <Text style={styles.footnote}>
                    {branchLabel(stopBranchId)} already has the most stops a group may
                    hold ({ceiling}). Remove one first.
                  </Text>
                ) : null}
                <View style={styles.composerActions}>
                  <Pressable
                    onPress={() => { setProposing(false); setNotice(null); }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    style={styles.secondaryBtn}
                  >
                    <X size={13} color={color.deep} />
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      if (!stopTitle.trim()) { setNotice('Give the stop a name first.'); return; }
                      void apply('stop-add', () => proposeCrewStop(sessionId, {
                        title: stopTitle.trim(),
                        durationMin,
                        // Airside: the server sets the zero because the zero is
                        // a fact there. Landside: a stated figure, because an
                        // unstated one is REFUSED rather than defaulted.
                        ...(insideAirport ? {} : { travelMin }),
                        insideAirport,
                        branchId: stopBranchId,
                      }));
                    }}
                    disabled={busy !== null || branchFull}
                    accessibilityRole="button"
                    accessibilityLabel="Propose this stop"
                    accessibilityState={{ disabled: busy !== null || branchFull, busy: busy === 'stop-add' }}
                    style={[styles.primaryBtn, branchFull && { opacity: 0.5 }]}
                  >
                    {busy === 'stop-add'
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <Text style={styles.primaryBtnText}>Propose stop</Text>}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => { setProposing(true); setNotice(null); }}
                accessibilityRole="button"
                accessibilityLabel="Propose a stop for the crew"
                style={styles.secondaryBtn}
              >
                <Plus size={13} color={color.deep} />
                <Text style={styles.secondaryBtnText}>Propose a stop</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {/* ── §14.1 THE SPLIT, AND EACH BRANCH'S OWN VERDICT ───────────────────
            The roll-up above says whether the crew fits. This says WHICH GROUP
            does not and who is binding it — every figure the server's, none
            recomputed here. */}
        {solution.branches ? (
          <View testID="crew-branches" style={styles.subBlock}>
            <Text style={styles.memberHeading}>
              {solution.split ? 'Split into groups' : 'Going together'}
            </Text>
            {branches.map((b) => (
              <View key={b.branchId} testID={`crew-branch-${b.branchId}`} style={styles.branchRow}>
                <Text style={styles.branchTitle}>{branchLabel(b.branchId)}</Text>
                <Text style={styles.branchMembers}>
                  {b.memberIds.length > 0
                    ? b.memberIds.map(nameFor).join(', ')
                    : 'Nobody is on this group.'}
                </Text>
                {b.branchReturnBy ? (
                  <Text style={styles.branchMeta}>
                    Back by {fmtClock(b.branchReturnBy, timezone)}
                    {b.bindingMemberIds.length > 0
                      ? ` — ${b.bindingMemberIds.map(nameFor).join(', ')} set that`
                      : ''}
                  </Text>
                ) : (
                  // Null is the server declining to publish a minimum over the
                  // subset it could read. It is not filled in here.
                  <Text style={styles.branchMeta}>
                    Back by: not certified — a crewmate on this group could not be certified.
                  </Text>
                )}
                <Text style={styles.branchMeta}>
                  Needs {fmtDur(b.neededMinutes)} of{' '}
                  {b.usableMinutes === null ? 'an uncertified window' : fmtDur(b.usableMinutes)}
                </Text>
                {b.feasible ? (
                  <Text testID={`crew-branch-${b.branchId}-fits`} style={styles.branchFits}>
                    This group fits.
                  </Text>
                ) : (
                  <View style={styles.warnBlock}>
                    <AlertTriangle size={13} color={color.warn} />
                    <View style={{ flex: 1, gap: 2 }}>
                      {b.reasons.length > 0
                        ? b.reasons.map((r) => (
                            <Text key={r} style={styles.warnText}>{REASON_TEXT[r] ?? r}</Text>
                          ))
                        : <Text style={styles.warnText}>This group does not fit.</Text>}
                      {b.perMemberSlackMin
                        .filter((s) => s.slackMin !== null && s.slackMin < 0)
                        .map((s) => (
                          <Text key={s.userId} style={styles.warnText}>
                            {nameFor(s.userId)} is {Math.abs(s.slackMin as number)} minutes short.
                          </Text>
                        ))}
                    </View>
                  </View>
                )}
              </View>
            ))}

            {splitDraft ? (
              <View testID="crew-split-editor" style={styles.composer}>
                <Text style={styles.formLabel}>Who goes with whom?</Text>
                {solution.members.map((m) => (
                  <View key={m.userId} style={styles.switchRow}>
                    <Text style={styles.memberName}>{nameFor(m.userId)}</Text>
                    <View style={styles.chipRow}>
                      {[UNSPLIT_BRANCH_ID, SPLIT_BRANCH_ID].map((id) => (
                        <Pressable
                          key={id}
                          onPress={() => setSplitDraft({ ...splitDraft, [m.userId]: id })}
                          accessibilityRole="button"
                          accessibilityLabel={`Put ${nameFor(m.userId)} in ${branchLabel(id)}`}
                          accessibilityState={{ selected: splitDraft[m.userId] === id }}
                          style={[styles.chip, splitDraft[m.userId] === id && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, splitDraft[m.userId] === id && styles.chipTextActive]}>
                            {branchLabel(id)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ))}
                <Text style={styles.footnote}>
                  The whole split is saved at once. A crew assigned one person at a
                  time would pass through a half-split plan that nobody chose.
                </Text>
                <View style={styles.composerActions}>
                  <Pressable
                    onPress={() => { setSplitDraft(null); setNotice(null); }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel the split"
                    style={styles.secondaryBtn}
                  >
                    <X size={13} color={color.deep} />
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      void apply('split-save', () => assignCrewBranches(
                        sessionId,
                        solution.members.map((m) => ({
                          userId: m.userId,
                          branchId: splitDraft[m.userId] ?? UNSPLIT_BRANCH_ID,
                        })),
                      ));
                    }}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel="Save this split"
                    accessibilityState={{ disabled: busy !== null, busy: busy === 'split-save' }}
                    style={styles.primaryBtn}
                  >
                    {busy === 'split-save'
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <Text style={styles.primaryBtnText}>Save split</Text>}
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.composerActions}>
                <Pressable
                  onPress={() => {
                    setNotice(null);
                    setSplitDraft(Object.fromEntries(
                      solution.members.map((m) => [m.userId, UNSPLIT_BRANCH_ID]),
                    ));
                  }}
                  disabled={busy !== null || solution.members.length < 2}
                  accessibilityRole="button"
                  accessibilityLabel="Split the crew into groups"
                  accessibilityState={{ disabled: busy !== null || solution.members.length < 2 }}
                  style={[styles.secondaryBtn, solution.members.length < 2 && { opacity: 0.5 }]}
                >
                  <Split size={13} color={color.deep} />
                  <Text style={styles.secondaryBtnText}>
                    {solution.split ? 'Change the split' : 'Split the crew'}
                  </Text>
                </Pressable>
                {solution.split ? (
                  <Pressable
                    // AN EMPTY ARRAY IS THE REQUEST. It is the server's way back
                    // to unsplit, not an empty form, so nothing screens it out.
                    onPress={() => { void apply('unsplit', () => assignCrewBranches(sessionId, [])); }}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel="Put the crew back together"
                    accessibilityState={{ disabled: busy !== null, busy: busy === 'unsplit' }}
                    style={styles.secondaryBtn}
                  >
                    {busy === 'unsplit'
                      ? <ActivityIndicator size="small" color={color.deep} />
                      : <><Users size={13} color={color.deep} /><Text style={styles.secondaryBtnText}>
                          Go together again
                        </Text></>}
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        ) : null}

        {/* ── §14 L4 LOCATION SHARING ──────────────────────────────────────────
            A RUNG PER MEMBER AND NO POSITION, and when the grant table could
            not be read, that fact instead of the rungs. */}
        {state.locationRungs || grantsUnreadable || 'yourShare' in state ? (
          <View testID="crew-location-sharing" style={styles.subBlock}>
            <Text style={styles.memberHeading}>Location sharing</Text>
            {grantsUnreadable ? (
              <View testID="crew-location-grants-unreadable" style={styles.warnBlock}>
                <EyeOff size={13} color={color.warn} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.warnText}>
                    Who is sharing their location could not be read, so we cannot show
                    it. This is not the same as nobody sharing — we could not tell.
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.memberList}>
                {(state.locationRungs ?? []).map((r) => (
                  <View key={r.userId} testID={`crew-rung-${r.userId}`} style={styles.rungRow}>
                    <MapPin size={12} color={color.mute} />
                    <Text style={styles.memberName}>{nameFor(r.userId)}</Text>
                    {/* THE VIEWER'S OWN ROW IS NOT A STATEMENT ABOUT THEIR
                        GRANT. `locationPrecisionFor` answers `precise` with
                        reason `self` for the viewer whether or not they have
                        shared anything — a traveller's own position is theirs —
                        so rendering it as "you are sharing" would invent a live
                        grant out of a tautology. */}
                    <Text style={styles.rungText}>
                      {r.reason === 'self'
                        ? 'Your own position — the crew sees this only if you share it'
                        : PRECISION_TEXT[r.precision] ?? r.precision}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* ── YOUR OWN SHARE: ONE CONTROL, THREE STATES ─────────────────
                Read off `yourShare` and never off your own rung, which is
                `precise`/`self` whether or not you have shared anything. */}
            {shareUnknown ? (
              <View testID="crew-your-share-unknown" style={styles.warnBlock}>
                <AlertTriangle size={13} color={color.warn} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.warnText}>
                    We cannot tell whether you are sharing your location right now
                    {state.yourShare === null ? ' — it could not be read' : ''}. Rather
                    than offer you a button that assumes the answer is no, here is the
                    state we actually have: none.
                  </Text>
                  <Pressable
                    onPress={() => { setLoad({ kind: 'loading' }); void refresh(); }}
                    accessibilityRole="button"
                    accessibilityLabel="Check your location sharing again"
                    style={styles.retry}
                  >
                    <RefreshCw size={13} color={color.deep} />
                    <Text style={styles.retryText}>Try again</Text>
                  </Pressable>
                </View>
              </View>
            ) : share!.live ? (
              <View testID="crew-your-share-live" style={styles.subBlock}>
                <Pressable
                  onPress={() => { void apply('revoke', () => revokeCrewLocation(sessionId)); }}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel="Stop sharing my location with this crew"
                  accessibilityState={{ disabled: busy !== null, busy: busy === 'revoke' }}
                  style={styles.secondaryBtn}
                >
                  {busy === 'revoke'
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <><EyeOff size={13} color={color.deep} /><Text style={styles.secondaryBtnText}>
                        Stop sharing
                      </Text></>}
                </Pressable>
                {share!.expiresAt ? (
                  // THE SERVER'S INSTANT, FORMATTED. Not a countdown this client
                  // worked out: the ceiling is min(the crew's life, your own
                  // certified return) and a second opinion on a privacy boundary
                  // could only move it the wrong way.
                  <Text style={styles.shareLive}>
                    You are sharing with this crew until {fmtClock(share!.expiresAt, timezone)}.
                  </Text>
                ) : (
                  <Text style={styles.shareLive}>You are sharing with this crew.</Text>
                )}
              </View>
            ) : (
              <View testID="crew-your-share-off" style={styles.subBlock}>
                <Pressable
                  onPress={() => { void apply('grant', () => grantCrewLocation(sessionId)); }}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel="Share my location with this crew"
                  accessibilityState={{ disabled: busy !== null, busy: busy === 'grant' }}
                  style={styles.secondaryBtn}
                >
                  {busy === 'grant'
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <><MapPin size={13} color={color.deep} /><Text style={styles.secondaryBtnText}>
                        Share my location
                      </Text></>}
                </Pressable>
                {SHARE_ENDED_TEXT[share!.reason] ? (
                  <Text style={styles.hiddenNote}>{SHARE_ENDED_TEXT[share!.reason]}</Text>
                ) : null}
              </View>
            )}
            <Text style={styles.footnote}>
              Sharing ends on its own — when this crew ends, when your layover ends, or
              when you board, whichever comes first. You cannot ask for longer.
            </Text>
          </View>
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
  subBlock: {
    gap: space.xs,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: space.sm,
    marginTop: space.xs,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    padding: space.md,
  },
  stopTitle: { ...t.small, color: color.ink, fontWeight: '600' },
  stopMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  metaStamp: { ...t.stamp, color: color.mute },
  formLabel: { ...t.small, color: color.mute, fontSize: 12, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: color.deep, borderColor: color.deep },
  chipText: { ...t.small, color: color.mute, fontSize: 12 },
  chipTextActive: { color: color.onInk, fontWeight: '700' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  branchRow: {
    gap: 2,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    padding: space.md,
  },
  branchTitle: { ...t.small, color: color.ink, fontWeight: '700' },
  branchMembers: { ...t.small, color: color.ink, fontSize: 12 },
  branchMeta: { ...t.small, color: color.mute, fontSize: 12 },
  branchFits: { ...t.small, color: color.success, fontSize: 12, fontWeight: '600' },
  shareLive: { ...t.small, color: color.success, fontSize: 12, fontWeight: '600' },
  rungRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  rungText: { ...t.small, color: color.mute, fontSize: 12, flex: 1 },
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
