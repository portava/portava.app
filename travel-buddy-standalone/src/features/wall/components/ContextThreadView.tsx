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
import { truthQualifierLabel } from '../types/wallProjection.ts';

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
  // Sensing §108: a prediction, an inference or an unconfirmed state must never
  // render indistinguishably from an observation. The qualifier is TEXT (spec
  // §36 — live state must not rely on colour alone) and is derived purely from
  // the truth class the SERVER carried; the client computes no world truth of
  // its own (Sensing S6). An observed/corroborated fact needs no qualifier and
  // gets none, so the annotation appears exactly where it changes the meaning.
  const qualifier = truthQualifierLabel(thread.truthClass);

  // §37 "paid/promoted content is explicitly labeled and separated from factual
  // live confidence". The SEPARATION already happened on the server (a
  // promotional source class can only produce a non-observation truth class);
  // this is the LABEL, which is the half a viewer can actually see. It is the
  // server's string rendered verbatim — the client classifies nothing — and it
  // renders BEFORE the truth qualifier, because "who is telling you this"
  // changes how the rest of the row should be read.
  const promotion = thread.promotionLabel ?? null;

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
          {promotion ? (
            <Text style={s.promotion} testID={`wall-context-promotion-${thread.kind}`}>
              {`  ·  ${promotion}`}
            </Text>
          ) : null}
          {qualifier ? (
            <Text style={s.qualifier} testID={`wall-context-truth-${thread.kind}`}>
              {`  ·  ${qualifier}`}
            </Text>
          ) : null}
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
      accessibilityLabel={`${thread.label}${promotion ? `, ${promotion}` : ''}${
        qualifier ? `, ${qualifier}` : ''
      }${actionLabel ? `, ${actionLabel}` : ''}`}
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
  // Deliberately the QUIET colour: a "Scheduled"/"Inferred" qualifier must be
  // legible, never louder than the fact it qualifies (spec §35).
  qualifier: { ...t.small, color: color.mute, fontWeight: '700' },
  // Same weight and colour as the truth qualifier: a disclosure that whispers is
  // not a disclosure. `mute` clears AA on both Wall surfaces (see the contrast
  // suite in WallAccessibility.component.test.tsx), and it is not the accent —
  // a sponsored row must not read as a promoted-looking highlight.
  promotion: { ...t.small, color: color.mute, fontWeight: '700' },
  reason: { ...t.small, color: color.mute },
});
