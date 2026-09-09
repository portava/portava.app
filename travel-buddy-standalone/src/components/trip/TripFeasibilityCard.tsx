/**
 * TripFeasibilityCard — §7 on screen.
 *
 * WHY THE VERDICTS ARE NOT STYLED SYMMETRICALLY
 * =============================================
 * Only one of the three verdicts is a proof. INFEASIBLE is derived from a
 * straight-line lower bound, so a schedule that fails it cannot be rescued by
 * any real route — that is a fact and it is drawn like one. The other two are
 * not:
 *
 *   FEASIBLE_UNVERIFIED is "not impossible on paper". The real journey is
 *   longer than the number it was checked against, by an unknown amount, and
 *   the server's own `disclosure` says so. It is drawn in the muted style and
 *   the disclosure is not optional decoration — it is the rest of the sentence.
 *
 *   UNKNOWN is not reassurance either. It is rendered, not hidden, because a
 *   card that disappears when it cannot check anything reads exactly like a
 *   card that checked and found nothing wrong.
 *
 * A read that FAILS gets the same treatment for the same reason: it says so,
 * rather than vanishing. "You cannot get there in time" is precisely the kind
 * of finding an empty state must never be allowed to swallow.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { AlertTriangle, HelpCircle, CheckCircle2, CloudOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  fetchTripFeasibility,
  feasibilityHeadline,
  feasibilityUnknownDetail,
  type FeasibilityRead,
} from '../../services/tripFeasibility.ts';

interface Props {
  tripId: string;
  /** Test seam — the real fetcher by default. */
  load?: typeof fetchTripFeasibility;
}

export function TripFeasibilityCard({ tripId, load = fetchTripFeasibility }: Props) {
  const [read, setRead] = useState<FeasibilityRead | undefined>(undefined);

  const run = useCallback(async () => {
    setRead(undefined);
    try {
      setRead(await load(tripId));
    } catch (e: any) {
      // fetchTripFeasibility does not throw, but an unexpected throw must not
      // become "off" — that is the collapse this whole pass removed.
      setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') });
    }
  }, [tripId, load]);

  useEffect(() => { void run(); }, [run]);

  if (read === undefined) {
    return (
      <View style={s.wrap} testID="trip-feasibility-loading">
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  // The ONLY case that renders nothing: the feature is not available here, so
  // nothing was measured and nothing is being withheld.
  if (read.state === 'off') return null;

  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-feasibility-unavailable">
        <View style={s.row}>
          <CloudOff size={16} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Schedule check unavailable</Text>
            <Text style={s.detail}>
              We couldn&apos;t check whether this trip&apos;s timings work. This is not a sign that they do.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const report = read.report;
  const infeasible = report.verdict === 'INFEASIBLE';
  const unknown = report.verdict === 'UNKNOWN';
  const Icon = infeasible ? AlertTriangle : unknown ? HelpCircle : CheckCircle2;
  const iconColor = infeasible ? color.signal : unknown ? color.faint : color.success;

  return (
    <View style={[s.wrap, infeasible && s.wrapAlarm]} testID="trip-feasibility-card">
      <View style={s.row}>
        <Icon size={16} color={iconColor} />
        <View style={{ flex: 1 }}>
          <Text style={[s.title, infeasible && { color: color.signal }]}>
            {feasibilityHeadline(report)}
          </Text>

          {unknown ? (
            <Text style={s.detail}>{feasibilityUnknownDetail(report)}</Text>
          ) : (
            // Not optional. FEASIBLE_UNVERIFIED without this sentence reads as
            // "checked and fine", which is a measurement nobody made.
            <Text style={s.detail}>{report.disclosure}</Text>
          )}

          {infeasible && report.offendingHopIndex !== null && (
            <Text style={s.detail}>
              The tightest hop is #{report.offendingHopIndex + 1} of {report.evaluatedHops}.
            </Text>
          )}

          {report.unresolvedPlaceIds.length > 0 && (
            // A dangling place id is a data defect, and it changes what the
            // verdict is worth: those hops were not checked at all.
            <Text style={s.detail}>
              {report.unresolvedPlaceIds.length} commitment
              {report.unresolvedPlaceIds.length === 1 ? '' : 's'} point at a place we can&apos;t find, so
              {report.unresolvedPlaceIds.length === 1 ? ' it was' : ' they were'} not checked.
            </Text>
          )}
        </View>
      </View>
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
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
});
