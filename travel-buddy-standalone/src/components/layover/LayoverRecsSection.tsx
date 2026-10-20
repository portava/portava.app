/**
 * LayoverRecsSection — time-aware recommendations with safety badges and
 * one-tap "Add to plan".
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Compass, Plus, Check } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { fmtDur, REC_EMOJI, safetyColors } from './layoverFormat.ts'; import { routingTermsExist } from '../../lib/layoverRoutedMap.ts';
import type { LayoverLandsideSuppression, LayoverRecommendation } from '../../services/layover.ts'; import { typicalExperienceLine, typicalExperienceA11y } from './layoverExperienceFacts.ts'; import { LayoverActivityTimingNote } from './LayoverTimingEvidenceCard.tsx'; // census L75 — one line: :41-92 are cited by line

interface Props {
  recs: LayoverRecommendation[];
  loading: boolean;
  /**
   * census L294 (C2) — the SERVER's sentence when the read produced no
   * list, and `null` when it produced one (however short).
   *
   * Required, not optional, and that is the point. `GET /:id/recommendations`
   * refuses with `degraded_unavailable` rather than serving `[]` on a failed
   * read, because "there is nothing to do on your layover" is a claim about a
   * city. This card used to receive that refusal as an empty array and print
   * the claim. A caller now has to say which of the two it holds.
   */
  error: string | null;
  onRetry: () => void;
  canPlan: boolean;
  addedRecIds: Set<string>;
  addingRecId: string | null;
  onAddToPlan: (recId: string) => void; /** census L43 — why the SERVER withheld landside ideas (re-entry), or that it could not check; absent = nothing withheld. */ landsideSuppression?: LayoverLandsideSuppression | null;
}

type Filter = 'all' | 'inside' | 'outside';

export function LayoverRecsSection({
  recs, loading, error, onRetry, canPlan, addedRecIds, addingRecId, onAddToPlan, landsideSuppression = null,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all'); const pairing = useRecsSnapshotPairing(recs, onRetry);

  const filtered = useMemo(() => {
    if (filter === 'inside')  return recs.filter((r) => r.insideAirport);
    if (filter === 'outside') return recs.filter((r) => !r.insideAirport);
    return recs;
  }, [recs, filter]);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Compass size={18} color={color.ink} />
        <Text style={styles.heading}>What you can actually do</Text>
      </View>

      {/* The chips filter a list. With no list they filter nothing, and
          offering them next to a failure suggests the failure is a filtering
          result. */}
      {!error && (
      <View style={styles.filterRow}>
        {(['all', 'inside', 'outside'] as Filter[]).map((f) => (
          <Pressable key={f} style={[styles.filterChip, filter === f && styles.filterChipActive]} onPress={() => setFilter(f)}>
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === 'all' ? 'All' : f === 'inside' ? 'In airport' : 'Out in the city'}
            </Text>
          </Pressable>
        ))}
      </View>
      )}

      {!loading && !error && landsideSuppression?.reason === 'airport_reentered' && (
        <Text style={styles.empty} testID="layover-recs-landside-suppressed">
          You told us you're back at the airport, so ideas out in the city are hidden.
        </Text>
      )}
      {!loading && !error && landsideSuppression?.reason === 'checkpoints_unreadable' && (
        <Text style={styles.empty} testID="layover-recs-landside-unknown">
          We couldn't check whether you're back at the airport, so city ideas are still shown.
        </Text>
      )}

      {loading && <ActivityIndicator color={color.deep} style={{ marginVertical: space.lg }} />}{!error && <RecsSnapshotNotice pairing={pairing} loading={loading} onRetry={onRetry} />}

      {/* THE REFUSAL, IN THE SERVER'S OWN WORDS. Not "nothing fits" — that is a
          finished answer about a city, and this is the absence of one. */}
      {!loading && error && (
        <View style={styles.errorBox} testID="layover-recs-error">
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry loading layover ideas"
            testID="layover-recs-retry"
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {!loading && !error && filtered.length === 0 && (
        <Text style={styles.empty}>
          {filter === 'outside'
            ? 'Nothing outside fits this window — the buffers win this time.'
            : 'No recommendations yet for this layover.'}
        </Text>
      )}

      {!loading && !error && filtered.map((rec, idx) => {
        const sc = safetyColors(rec.safetyRating);
        const recId = rec.id ?? null;
        const added = recId ? addedRecIds.has(recId) : false;
        // census L75 — the §9 ExperiencePrimitive for the card's KIND, or null
        // when there is nothing honest to say. Never the card's own time there.
        const typical = typicalExperienceLine(rec.experience);
        return (
          <View key={recId ?? `${rec.title}-${idx}`} style={styles.recRow}>
            <Text style={styles.emoji}>{REC_EMOJI[rec.recType] ?? '📍'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.recTitle} numberOfLines={1}>{rec.title}</Text>
              {rec.description ? <Text style={styles.recDesc} numberOfLines={2}>{rec.description}</Text> : null}
              <View style={styles.recMeta}>
                <View style={[styles.safetyBadge, { backgroundColor: sc.bg }]}>
                  <Text style={[styles.safetyText, { color: sc.fg }]}>{rec.safetyLabel}</Text>
                </View>
                {/* census-layover L293 / spec §2.1 "degrades VISIBLY". A card
                    with no measured journey used to render NOTHING here, which
                    on a row that otherwise says "15m away" reads as "no travel
                    needed". The absence is now stated in words. */}
                {!rec.insideAirport && (
                  rec.routing !== undefined ? <Text style={styles.metaStamp}>{routingTermsExist(rec.routing) ? `${rec.routing!.outboundMinutes}m away` : 'Travel time could not be measured right now'}</Text> : rec.travelTimeMin !== null && rec.travelTimeMin > 0
                    ? <Text style={styles.metaStamp}>{rec.travelTimeMin}m away</Text>
                    : <Text style={styles.metaStamp}>travel time not measured</Text>
                )}
                {rec.activityTimeMin !== null && (
                  <Text style={styles.metaStamp}>{fmtDur(rec.activityTimeMin)} there</Text>
                )}
              </View>
              {/* Its own line, under the card's facts: typical for this kind of
                  place, not measured for this one (layoverExperienceFacts.ts). */}
              {typical ? (
                <Text style={styles.typical} accessibilityLabel={typicalExperienceA11y(typical)} testID={`layover-rec-typical-${idx}`}>
                  {typical}
                </Text>
              ) : null}
              <LayoverActivityTimingNote routing={rec.routing} />{rec.routing?.band === 'BLOCKED' ? <Text style={styles.warning}>Unavailable — {rec.routing.reason ?? rec.warningReason ?? 'This route does not fit the return deadline.'}</Text> : rec.warningReason ? <Text style={styles.warning}>{rec.warningReason}</Text> : null}
            </View>
            {canPlan && recId && rec.safetyRating !== 'not_recommended' && rec.routing?.band !== 'BLOCKED' && !pairing.expired && (
              added ? (
                <View style={styles.addedBadge}><Check size={15} color={color.success} /></View>
              ) : (
                <Pressable
                  style={styles.addBtn}
                  disabled={addingRecId === recId}
                  onPress={() => { holdRecommendationSnapshot(recId, rec.snapshotId); onAddToPlan(recId); }}
                  accessibilityLabel={`Add ${rec.title} to plan`}
                >
                  {addingRecId === recId
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <Plus size={16} color={color.deep} />}
                </Pressable>
              )
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:   { ...t.heading, color: color.ink },
  filterRow: { flexDirection: 'row', gap: space.sm },
  filterChip:{ borderWidth: 1, borderColor: color.haze, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.paper },
  filterChipActive: { backgroundColor: color.ink, borderColor: color.ink },
  filterText:{ ...t.small, color: color.mute },
  filterTextActive: { color: color.onInk },
  empty:     { ...t.small, color: color.faint, marginTop: space.sm },
  errorBox:  { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: space.sm, marginTop: space.sm },
  errorText: { ...t.small, color: color.mute },
  retryBtn:  { alignSelf: 'flex-start', borderWidth: 1, borderColor: color.deep, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  retryText: { ...t.small, fontWeight: '700', color: color.deep },

  recRow:    { flexDirection: 'row', gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, alignItems: 'flex-start' },
  emoji:     { fontSize: 22, marginTop: 2 },
  recTitle:  { ...t.bodyStrong, color: color.ink },
  recDesc:   { ...t.small, color: color.mute, marginTop: 2 },
  recMeta:   { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6, flexWrap: 'wrap' },
  safetyBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  safetyText:{ ...t.stamp },
  metaStamp: { ...t.stamp, color: color.faint },
  typical:   { ...t.small, color: color.faint, marginTop: 4 },
  warning:   { ...t.small, color: color.warn, marginTop: 4 },

  addBtn:    { width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2, borderWidth: 1.5, borderColor: color.deep, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  addedBadge:{ width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2, backgroundColor: 'rgba(46,125,91,0.12)', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
});

// ═══════════════════════════════════════════════════════════════════════════
// census-layover L296 — Appendix C5, the client half. Appended at the TAIL so
// no cited line above moves; ESM hoists the import.
//
// Every card carries the snapshot it was returned with, and "Add to plan" holds
// THAT snapshot for the add (`holdRecommendationSnapshot`). When the server
// refuses the add with 409 RECOMMENDATION_EXPIRED — the ideas were regenerated
// since this list was served — the list switches to a "refreshed — reload"
// state: its Add controls go, and the ideas are reloaded through `onRetry`
// exactly once for that snapshot. The add itself is never retried: the
// traveller sees the current card before anything is added under it.
// ═══════════════════════════════════════════════════════════════════════════
import {
  holdRecommendationSnapshot,
  isRecommendationSnapshotExpired,
  subscribeRecommendationExpiry,
} from '../../services/layover.ts';

interface RecsSnapshotPairing {
  /** An add under the snapshot this list was served with was refused RECOMMENDATION_EXPIRED. */
  expired: boolean;
  /** This list arrived by the reload an expiry triggered. */
  refreshed: boolean;
}

function useRecsSnapshotPairing(recs: LayoverRecommendation[], onRetry: () => void): RecsSnapshotPairing {
  const snapshotId = recs.find((r) => typeof r.snapshotId === 'string')?.snapshotId ?? null;
  const [expired, setExpired] = useState(() => isRecommendationSnapshotExpired(snapshotId));
  // The expired snapshot a reload replaced, and the first snapshot that replaced
  // it: the "refreshed" line is said about THAT list only, not every later one.
  const [reload, setReload] = useState<{ from: string; to: string | null } | null>(null);
  const reloadedFor = useRef<string | null>(null);

  useEffect(() => {
    const update = () => setExpired(isRecommendationSnapshotExpired(snapshotId));
    update();
    return subscribeRecommendationExpiry(update);
  }, [snapshotId]);

  // Refetch, once per expired snapshot. Not a retry of the add.
  useEffect(() => {
    if (!expired || snapshotId === null || reloadedFor.current === snapshotId) return;
    reloadedFor.current = snapshotId;
    setReload({ from: snapshotId, to: null });
    onRetry();
  }, [expired, snapshotId, onRetry]);

  useEffect(() => {
    if (reload && reload.to === null && snapshotId !== null && snapshotId !== reload.from) setReload({ from: reload.from, to: snapshotId });
  }, [reload, snapshotId]);

  return { expired, refreshed: !expired && reload !== null && reload.to !== null && reload.to === snapshotId };
}

function RecsSnapshotNotice({ pairing, loading, onRetry }: { pairing: RecsSnapshotPairing; loading: boolean; onRetry: () => void }) {
  if (pairing.expired) {
    return (
      <View style={styles.errorBox} testID="layover-recs-expired">
        <Text style={styles.errorText}>
          These ideas were refreshed since you opened them, so nothing was added. Reload them and check the card before adding it.
        </Text>
        {!loading && (
          <Pressable
            style={styles.retryBtn}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Reload layover ideas"
            testID="layover-recs-reload"
          >
            <Text style={styles.retryText}>Reload ideas</Text>
          </Pressable>
        )}
      </View>
    );
  }
  if (pairing.refreshed && !loading) {
    return (
      <Text style={styles.empty} testID="layover-recs-refreshed">
        Your ideas were refreshed. Check the card, then add it again.
      </Text>
    );
  }
  return null;
}
