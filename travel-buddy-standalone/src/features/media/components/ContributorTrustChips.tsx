/**
 * ContributorTrustChips — Media v2 Phase 10 (§25 Creator Popularity vs
 * Intelligence Trust).
 *
 * Where a contributor/perspective is shown, this surfaces the three §25
 * INTELLIGENCE-TRUST dimensions — Contributor Reliability / Place Expertise /
 * Live Accuracy — as calm trust CONTEXT (GET /api/v1/media/contributors/:id/
 * reputation). It is EXPLICITLY NOT a follower/like count, NOT a leaderboard,
 * NOT a vanity metric: the data carries no social field and the caption states
 * the boundary in words ("Intelligence trust · not popularity").
 *
 * FLAG-GATED + DEGRADE (§19/§33/§46): reads `media_request_a_view_enabled`;
 * hidden when off/unknown, so existing screens are untouched. A 404 / empty /
 * error, or an empty reputation (pre-launch, no signal), renders NOTHING — never
 * a hollow "0% trust" row, never a throw.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import { REQUEST_A_VIEW_FLAG } from './RequestAViewPrompt.tsx';
import {
  fetchContributorReputation,
  reputationDisplayDimensions,
  REPUTATION_TRUST_CAPTION,
} from '../services/viewRequest.ts';
import type { ContributorReputation, ReputationDimension } from '../types/viewRequest.ts';

export interface ContributorTrustChipsProps {
  /** The contributor's user id (a UUID). Required. */
  contributorId: string;
  /** Optional place/subject id to scope the Place-Expertise dimension. */
  subjectId?: string | null;
}

export function ContributorTrustChips({ contributorId, subjectId = null }: ContributorTrustChipsProps) {
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled(REQUEST_A_VIEW_FLAG);

  const [reputation, setReputation] = useState<ContributorReputation | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !contributorId) {
      setReputation(null);
      return;
    }
    const controller = new AbortController();
    void fetchContributorReputation(contributorId, { subjectId, signal: controller.signal }).then((res) => {
      if (controller.signal.aborted || !mounted.current) return;
      setReputation(res.ok ? res.data : null);
    });
    return () => controller.abort();
  }, [enabled, contributorId, subjectId]);

  const dimensions: ReputationDimension[] = reputationDisplayDimensions(reputation);
  // Nothing extra renders when off / empty / error (§46 calm, no hollow rows).
  if (dimensions.length === 0) return null;

  return (
    <View style={s.wrap} accessibilityRole="summary" accessibilityLabel="Intelligence trust context">
      <View style={s.rows}>
        {dimensions.map((d) => (
          <View key={d.key} style={s.row}>
            <View style={s.labelCol}>
              <Text style={s.label} numberOfLines={1}>{d.label}</Text>
              <Text style={s.desc} numberOfLines={1}>{d.description}</Text>
            </View>
            <View style={s.meterCol}>
              <View style={s.track}>
                <View style={[s.fill, { width: `${Math.round(d.value * 100)}%` }]} />
              </View>
              <Text style={s.pct}>{d.percentLabel}</Text>
            </View>
          </View>
        ))}
      </View>
      {/* The boundary, stated plainly. This is trust context, not popularity. */}
      <Text style={s.caption}>{REPUTATION_TRUST_CAPTION}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginTop: space.sm,
    padding: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.sm,
    gap: space.xs,
  },
  rows: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  labelCol: { flex: 1, minWidth: 0 },
  label: { ...t.small, color: color.ink, fontWeight: '700' },
  desc: { fontSize: 11, lineHeight: 14, color: color.faint },
  meterCol: { width: 108, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    overflow: 'hidden',
  },
  fill: { height: 6, borderRadius: radius.pill, backgroundColor: color.deep },
  pct: { ...t.stamp, color: color.mute, width: 34, textAlign: 'right' },
  caption: { fontSize: 11, lineHeight: 14, color: color.faint, fontStyle: 'italic' },
});
