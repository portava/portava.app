/**
 * ContextThreadView — the compact bridge beneath a feed object (Wall spec §8).
 *
 * Renders ONLY what the server's §9 eligibility gate already admitted; it does
 * not re-decide relevance. It is deliberately quieter than the post it hangs
 * under (spec §35): one line, a kind icon, a freshness label that never relies
 * on colour alone (spec §36), an optional "why", and at most one action that
 * bridges into a surrounding surface. A stale/unknown fact is shown without a
 * live label (spec §4).
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import {
  Radio,
  Plane,
  Gem,
  Users,
  UserCheck,
  Map as MapIcon,
  Clock,
  Compass,
  ChevronRight,
} from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../theme/tokens.ts';
import {
  trackContextThreadActed,
  trackContextThreadIgnored,
  trackContextThreadShown,
} from '../services/wallAnalytics.ts';
import { askCompassFromWall } from '../services/wallCompass.ts';
import { runWallAction } from './objects/wallItemShared.tsx';
import type { ContextThread, ContextThreadKind } from '../types/contextThread.ts';
import type { FreshnessState, WallProjection } from '../types/wallProjection.ts';

const KIND_ICON: Record<ContextThreadKind, React.ComponentType<{ size: number; color: string }>> = {
  live_place: Radio,
  trip_relevance: Plane,
  hidden_gem: Gem,
  social_presence: Users,
  buddy: UserCheck,
  map: MapIcon,
  memory: Clock,
  compass: Compass,
};

/** A text freshness label — never colour-only (spec §36). Null = show nothing. */
function freshnessLabel(freshness?: FreshnessState): string | null {
  switch (freshness) {
    case 'live':
      return 'Live';
    case 'recent':
      return 'Recent';
    case 'aging':
      return 'Earlier';
    case 'stale':
    case 'unknown':
    case undefined:
    default:
      return null; // no stale "live" label (spec §4)
  }
}

export function ContextThreadView({
  thread,
  projection,
}: {
  thread: ContextThread;
  projection: WallProjection;
}) {
  // A Context Thread earns its space or it does not: track "shown" on mount, and
  // "ignored" on unmount when it was scrolled past without being acted on (§32).
  const actedRef = React.useRef(false);
  React.useEffect(() => {
    trackContextThreadShown(thread.kind);
    return () => {
      if (!actedRef.current) trackContextThreadIgnored(thread.kind);
    };
  }, [thread.kind]);

  const Icon = KIND_ICON[thread.kind] ?? Compass;
  const fresh = freshnessLabel(thread.freshness);

  // A compass-kind thread is actionable even without an explicit action: it
  // hands the object to Compass (spec §21). Every other kind needs an action.
  const isCompass = thread.kind === 'compass';
  const actionable = !!thread.action || isCompass;

  const onAct = () => {
    if (!actionable) return;
    actedRef.current = true;
    trackContextThreadActed(thread.kind);
    if (isCompass) {
      // Hand the canonical object to the Compass ask surface (spec §21).
      askCompassFromWall(projection);
      return;
    }
    if (thread.action) runWallAction(thread.action, projection);
  };

  const body = (
    <View style={s.row}>
      <Icon size={icon.s16} color={color.deep} />
      <View style={s.textCol}>
        <Text style={s.label} numberOfLines={2}>
          {thread.label}
          {fresh ? (
            <Text style={s.freshness}>{`  ·  ${fresh}`}</Text>
          ) : null}
        </Text>
        {thread.reason ? (
          <Text style={s.reason} numberOfLines={1}>
            {thread.reason}
          </Text>
        ) : null}
      </View>
      {actionable ? <ChevronRight size={icon.s16} color={color.faint} /> : null}
    </View>
  );

  if (!actionable) {
    return (
      <View style={s.container} testID={`wall-context-${thread.kind}`}>
        {body}
      </View>
    );
  }
  const actionLabel = thread.action?.label ?? (isCompass ? 'Ask Compass' : '');
  return (
    <Pressable
      style={s.container}
      onPress={onAct}
      accessibilityRole="button"
      accessibilityLabel={`${thread.label}${actionLabel ? `, ${actionLabel}` : ''}`}
      testID={`wall-context-${thread.kind}`}
    >
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  container: {
    marginTop: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  textCol: { flex: 1, minWidth: 0 },
  label: { ...t.small, color: color.ink, fontWeight: '600' },
  freshness: { ...t.small, color: color.deep, fontWeight: '700' },
  reason: { ...t.small, color: color.faint },
});
