/**
 * JourneyDecisionPanel — §36 Phase 6's two trip surfaces, on one screen.
 *
 *   THE SHORTLIST   the crew's tentative plan items, with accept / decline and
 *                   a per-item tally.
 *   RECOVERY        planned stops a live constraint or a missed window has
 *                   taken out, each with its reason, its evidence and the
 *                   next-best same-category alternative.
 *   ALONG MY WAY    what is worth stopping for on the trip's own route, with
 *                   the detour each would cost.
 *
 * ALONG MY WAY ASKS THE GATEWAY, IT DOES NOT COMPUTE A CORRIDOR. The polyline
 * comes from the trip's route plan (the same stop list, in the same order, that
 * the map draws the route line from) and goes to GET /api/map/projection as
 * `corridor=`; the server filters, ranks by §31 and returns the detour
 * estimates. No bbox is sent — the server derives the viewport from the
 * polyline, which is tighter than any box this screen could guess.
 *
 * EVERY DECISION ON THIS SCREEN WAS MADE ON THE SERVER. The panel renders
 * `tallyLine`, `confirmArmed`, `recoveryEvidenceLine` and friends from
 * features/map/journey/groupDecision, which restate the server's answers and
 * never recompute them. In particular the "Add it to the plan" affordance is
 * armed by `tally.readyToConfirm` alone: a majority is not agreement, and
 * deciding that here would let this sheet overrule someone on the trip.
 *
 * §23. A crew member's presence is `crewPresenceLine` — the coarse area label
 * the server sent, or nothing. There is no map, no marker and no distance on
 * this screen, and `JourneyCrewArea` carries no coordinate to draw one with.
 *
 * §37. A recovery's evidence line distinguishes a LIVE report about the place
 * from a fact about the traveller's own plan; the schedule branch of the union
 * carries no source, so it cannot be dressed as an observation.
 *
 * FAIL-SOFT. `map_journey_intelligence_enabled` is off by default and both
 * endpoints answer `enabled: false`. That is rendered as "not available yet",
 * NEVER as an empty shortlist — "nobody suggested anything" and "the capability
 * is off" are different sentences and only one of them is true.
 *
 * CONFIRMING IS THE EXISTING PLAN WRITE PATH. The confirm button routes to the
 * trip's plan; it does not write a status here. See routes/mapJourney.ts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { fetchMapProjection } from '../../services/mapProjection.ts';
import { fetchTripRoutePlan } from '../../services/routePlan.ts';
import {
  corridorMetersFor,
  corridorPathFromRoutePlan,
  corridorSummaryLine,
  foldAlongMyWay,
  DEFAULT_CORRIDOR_PRESET,
  type AlongMyWayState,
} from '../../features/map/journey/alongMyWay.ts';
import {
  fetchJourneyRecovery,
  fetchJourneyShortlist,
  submitJourneyVote,
  type JourneyRecovery,
  type JourneyShortlist,
  type JourneyShortlistItem,
  type JourneyVote,
} from '../../services/mapJourney.ts';
import {
  applyOptimisticVote,
  confirmArmed,
  crewPresenceLine,
  myVoteState,
  orderRecovery,
  recoveryEvidenceLine,
  recoverySuggestionLine,
  recoveryTitle,
  shortlistHeaderLine,
  tallyLine,
  visibleCrew,
} from '../../features/map/journey/groupDecision.ts';

/** Deferring a navigation past the current tick — see check-close-then-navigate. */
const NAVIGATE_DEFER_MS = 80;

interface Props {
  tripId: string;
}

export function JourneyDecisionPanel({ tripId }: Props) {
  const [shortlist, setShortlist] = useState<JourneyShortlist | null>(null);
  const [recovery, setRecovery] = useState<JourneyRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [voting, setVoting] = useState<string | null>(null);
  const [alongMyWay, setAlongMyWay] = useState<AlongMyWayState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [s, r] = await Promise.all([
      fetchJourneyShortlist(tripId),
      fetchJourneyRecovery(tripId),
    ]);
    setLoading(false);
    if (!s.ok) {
      setError(s.error === 'aborted' ? null : 'Could not load the shortlist');
      return;
    }
    setShortlist(s.data);
    // A recovery failure is not a shortlist failure: the decision surface still
    // works without it, so it degrades to "no alternatives right now" rather
    // than taking the whole screen down.
    setRecovery(r.ok ? r.data : null);

    // Along My Way, best-effort: no route plan (or no gateway) simply means
    // there is no route to be "along", which the fold reports as `no_route`
    // rather than as an empty result. Skipped entirely while Phase 6 is off —
    // the corridor would be ignored server-side, so asking would cost a
    // request for an answer that could not be shown.
    if (!s.data.enabled) {
      setAlongMyWay(null);
      return;
    }
    const plan = await fetchTripRoutePlan(tripId);
    const path = corridorPathFromRoutePlan(plan);
    if (!path) {
      setAlongMyWay(null);
      return;
    }
    const projection = await fetchMapProjection({
      // No bbox on purpose — the corridor defines the viewport.
      zoom: 14,
      kinds: ['place', 'event', 'saved_place', 'safety_notice'],
      limit: 40,
      corridor: path,
      corridorMeters: corridorMetersFor(DEFAULT_CORRIDOR_PRESET),
    });
    setAlongMyWay(
      projection.ok
        ? foldAlongMyWay(
            projection.data.objects,
            projection.data.corridor,
            projection.data.corridorMatches,
          )
        : null,
    );
  }, [tripId]);

  useEffect(() => {
    void load();
  }, [load]);

  const vote = useCallback(
    async (item: JourneyShortlistItem, choice: JourneyVote) => {
      setVoting(item.id);
      // Optimistic, but `applyOptimisticVote` forces readyToConfirm false — the
      // confirm affordance must never arm on a vote that has not landed.
      setShortlist((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((i) =>
                i.id === item.id ? { ...i, tally: applyOptimisticVote(i.tally, choice) } : i,
              ),
            }
          : prev,
      );
      const res = await submitJourneyVote(tripId, item.id, choice);
      setVoting(null);
      if (!res.ok || !res.data.recorded) {
        // The vote did not land. Re-read rather than keeping an optimistic
        // count the server does not have.
        void load();
        return;
      }
      const tally = res.data.tally;
      if (!tally) return;
      setShortlist((prev) =>
        prev
          ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, tally } : i)) }
          : prev,
      );
    },
    [tripId, load],
  );

  const openPlan = useCallback(() => {
    // Deferred one tick past the press so no state update and navigation share
    // a frame (scripts/check-close-then-navigate).
    setTimeout(() => router.push(`/trip/${tripId}`), NAVIGATE_DEFER_MS);
  }, [tripId]);

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.centre}>
        <Text style={s.muted}>{error}</Text>
        <Pressable onPress={() => void load()} style={s.retry} accessibilityRole="button">
          <Text style={s.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!shortlist || !shortlist.enabled) {
    return (
      <View style={s.centre}>
        <Text style={s.heading}>Deciding together</Text>
        <Text style={s.muted}>
          Shared shortlists and route recovery are not switched on yet.
        </Text>
      </View>
    );
  }

  const crew = visibleCrew(shortlist.crew);
  const entries = orderRecovery(recovery?.entries ?? []);

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* ── Crew: coarse areas only (§23) ─────────────────────────────────── */}
      {crew.length > 0 ? (
        <View style={s.card}>
          <Text style={s.sectionTitle}>Who's deciding</Text>
          {crew.map((m) => {
            const where = crewPresenceLine(m);
            return (
              <View key={m.userId} style={s.crewRow}>
                <Text style={s.crewName}>{m.name ?? 'Crew member'}</Text>
                {where ? <Text style={s.crewArea}>{where}</Text> : null}
              </View>
            );
          })}
          {shortlist.crewReadFailed ? (
            <Text style={s.footnote}>Areas unavailable right now.</Text>
          ) : null}
        </View>
      ) : null}

      {/* ── The shortlist ─────────────────────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.sectionTitle}>Shortlist</Text>
        <Text style={s.footnote}>{shortlistHeaderLine(shortlist.items, shortlist.truncated)}</Text>

        {shortlist.items.map((itemRow) => {
          const mine = myVoteState(itemRow.tally);
          const armed = confirmArmed(itemRow.tally);
          const busy = voting === itemRow.id;
          return (
            <View key={itemRow.id} style={s.item}>
              <Text style={s.itemTitle}>{itemRow.title}</Text>
              {itemRow.locationName ? (
                <Text style={s.itemWhere}>{itemRow.locationName}</Text>
              ) : null}
              <Text style={s.tally}>{tallyLine(itemRow.tally)}</Text>

              <View style={s.actions}>
                <Pressable
                  disabled={busy}
                  onPress={() => void vote(itemRow, 'accept')}
                  style={[s.voteBtn, mine.accepted && s.voteBtnOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`I'm in for ${itemRow.title}`}
                >
                  <Text style={[s.voteText, mine.accepted && s.voteTextOn]}>I'm in</Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => void vote(itemRow, 'decline')}
                  style={[s.voteBtn, mine.declined && s.voteBtnOff]}
                  accessibilityRole="button"
                  accessibilityLabel={`Not for me: ${itemRow.title}`}
                >
                  <Text style={[s.voteText, mine.declined && s.voteTextOn]}>Not for me</Text>
                </Pressable>
              </View>

              {armed ? (
                <Pressable onPress={openPlan} style={s.confirm} accessibilityRole="button">
                  {/* The status write is the plan's, not this screen's. */}
                  <Text style={s.confirmText}>Everyone's in — add it in the plan</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {shortlist.items.length === 0 ? (
          <Text style={s.muted}>Add a place to the trip to start a shortlist.</Text>
        ) : null}
      </View>

      {/* ── Along My Way ──────────────────────────────────────────────────── */}
      {alongMyWay ? (
        <View style={s.card}>
          <Text style={s.sectionTitle}>On your way</Text>
          <Text style={s.footnote}>{corridorSummaryLine(alongMyWay)}</Text>
          {alongMyWay.status === 'ready'
            ? alongMyWay.items.map((entry) => (
                <View key={entry.object.id} style={s.item}>
                  <Text style={s.itemTitle}>{entry.object.title}</Text>
                  {entry.object.subtitle ? (
                    <Text style={s.itemWhere}>{entry.object.subtitle}</Text>
                  ) : null}
                  {/* The server's own line, verbatim — it already says "Est." */}
                  {entry.detourLine ? <Text style={s.evidence}>{entry.detourLine}</Text> : null}
                </View>
              ))
            : null}
        </View>
      ) : null}

      {/* ── Recovery ──────────────────────────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.sectionTitle}>If a stop falls through</Text>
        {entries.length === 0 ? (
          <Text style={s.muted}>
            {recovery?.enabled === false
              ? 'Not switched on yet.'
              : 'Nothing on your plan looks blocked right now.'}
          </Text>
        ) : null}
        {entries.map((entry) => {
          const suggestion = recoverySuggestionLine(entry);
          return (
            <View key={entry.stopId} style={s.item}>
              <Text style={s.itemTitle}>{recoveryTitle(entry)}</Text>
              <Text style={s.evidence}>{recoveryEvidenceLine(entry)}</Text>
              {suggestion ? <Text style={s.suggestion}>{suggestion}</Text> : null}
            </View>
          );
        })}
        {recovery && recovery.weakEvidenceStops > 0 ? (
          <Text style={s.footnote}>
            {recovery.weakEvidenceStops} stop
            {recovery.weakEvidenceStops === 1 ? '' : 's'} had only early reports — not enough to
            act on.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  content: { padding: space.lg, gap: space.lg },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
  },
  sectionTitle: { ...t.heading, color: color.ink },
  heading: { ...t.title, color: color.ink },
  muted: { ...t.body, color: color.mute },
  footnote: { ...t.small, color: color.faint },
  crewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  crewName: { ...t.bodyStrong, color: color.ink },
  crewArea: { ...t.small, color: color.mute },
  item: {
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: space.md,
    marginTop: space.sm,
    gap: space.xs,
  },
  itemTitle: { ...t.bodyStrong, color: color.ink },
  itemWhere: { ...t.small, color: color.mute },
  tally: { ...t.small, color: color.deep },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  voteBtn: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  voteBtnOn: { backgroundColor: color.success, borderColor: color.success },
  voteBtnOff: { backgroundColor: color.mute, borderColor: color.mute },
  voteText: { ...t.small, color: color.ink },
  voteTextOn: { color: color.onInk },
  confirm: {
    marginTop: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.signal,
  },
  confirmText: { ...t.small, color: color.onInk, textAlign: 'center' },
  evidence: { ...t.small, color: color.mute },
  suggestion: { ...t.body, color: color.deep },
  retry: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: { ...t.small, color: color.ink },
});

export default JourneyDecisionPanel;
