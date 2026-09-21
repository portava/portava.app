/**
 * Telegraph §3 — the Shared Context Rail, at the top of a conversation.
 *
 * Spec:
 *   §2.2   the rail is the band between the header and the message stream
 *   §3     "show mutually relevant events, plans, Trips and related Portava
 *           objects created or joined by both sides"
 *   §11.1  "Use horizontal rails only for short, high-value context sets;
 *           provide 'See all' for expansion."
 *   §11.2  the five behaviours (expanded NOW / compact upcoming / collapsed
 *           summary / collapse on scroll / promoted change until acknowledged)
 *   §11.3  "Do not encode delivery/availability solely by color" — every band
 *           renders its WORD (`statusLabelFor`), the colour only reinforces it;
 *           "Provide reduced-motion behavior" — the promoted change card does
 *           not animate when the OS asks for reduced motion.
 *
 * All decisions live in `railBehavior.ts`; this file renders them. That split
 * is what lets §11.2 be tested without a device.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useReducedMotionSetting } from '../../wall/hooks/useReducedMotionSetting.ts';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, statusLabelFor, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { fetchSharedContext } from './api.ts';
import {
  detectCriticalChanges,
  resolveRailPresentation,
  type CriticalChange,
} from './railBehavior.ts';
import type {
  SharedContextItem,
  SharedContextResponse,
  TelegraphSharedContextProjection,
} from './types.ts';

export interface SharedContextRailProps {
  threadId: string;
  /** §11.2 row 4 — true once the message list has scrolled past the threshold. */
  scrolled?: boolean;
  /** Tapping a card hands the object to whoever owns it; the rail never mutates. */
  onOpenObject?: (item: SharedContextItem) => void;
  onSeeAll?: (projection: TelegraphSharedContextProjection) => void;
  /** Test seam: pre-supplied response instead of a fetch. */
  initialResponse?: SharedContextResponse | null;
}

export function SharedContextRail({
  threadId,
  scrolled = false,
  onOpenObject,
  onSeeAll,
  initialResponse = null,
}: SharedContextRailProps) {
  const palette = useTelegraphPalette();
  const reduceMotion = useReducedMotionSetting();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [response, setResponse] = useState<SharedContextResponse | null>(initialResponse);
  const [previous, setPrevious] = useState<TelegraphSharedContextProjection | null>(null);
  const [changes, setChanges] = useState<CriticalChange[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [loading, setLoading] = useState(initialResponse === null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchSharedContext(threadId);
    if (r.ok) {
      setResponse((prevResponse) => {
        const prevProjection = prevResponse?.sharedContext ?? null;
        setPrevious(prevProjection);
        setChanges(detectCriticalChanges(prevProjection, r.data.sharedContext));
        return r.data;
      });
      setFailed(false);
    } else {
      // "Could not tell" is not "nothing shared": render nothing at all.
      setFailed(true);
    }
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    if (initialResponse !== null) return;
    void load();
  }, [initialResponse, load]);

  const acknowledge = useCallback((key: string) => {
    setAcknowledged((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  if (loading && !response) {
    return (
      <View style={styles.loadingWrap} accessibilityLabel="Loading shared context">
        <ActivityIndicator size="small" color={palette.operational} />
      </View>
    );
  }
  if (failed || !response) return null;

  const presentation = resolveRailPresentation({
    projection: response.sharedContext,
    railMode: response.railMode,
    collapsedSummary: response.collapsedSummary,
    incomplete: response.incomplete,
    scrolled,
    acknowledgedChangeKeys: acknowledged,
    criticalChanges: changes,
  });

  if (presentation.mode === 'EMPTY' && !presentation.promotedChange) return null;

  const change = presentation.promotedChange;

  return (
    <View style={styles.wrap} testID="telegraph-shared-context-rail">
      {change ? (
        <View
          testID="telegraph-rail-change-card"
          style={[styles.changeCard, reduceMotion ? null : styles.changeCardEmphasis]}
          accessibilityRole="alert"
          accessibilityLabel={`${changeWord(change)}: ${change.title}`}
        >
          <Text style={styles.changeWord}>{changeWord(change)}</Text>
          <Text style={styles.changeTitle} numberOfLines={1}>
            {change.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Acknowledge change"
            onPress={() => acknowledge(change.changeKey)}
            style={styles.ackButton}
          >
            <Text style={styles.ackText}>Got it</Text>
          </Pressable>
        </View>
      ) : null}

      {presentation.mode === 'MINIMIZED' ? (
        <Pressable
          testID="telegraph-rail-minimized"
          accessibilityRole="button"
          accessibilityLabel={`Shared context: ${presentation.summary || 'shared plans'}`}
          onPress={() => onSeeAll?.(response.sharedContext)}
          style={styles.minimized}
        >
          <Text style={styles.minimizedText} numberOfLines={1}>
            {presentation.summary || 'Shared context'}
          </Text>
        </Pressable>
      ) : null}

      {presentation.mode === 'COLLAPSED_SUMMARY' ? (
        <Pressable
          testID="telegraph-rail-summary"
          accessibilityRole="button"
          accessibilityLabel={`Shared context: ${presentation.summary}`}
          onPress={() => onSeeAll?.(response.sharedContext)}
          style={styles.summary}
        >
          <Text style={styles.summaryText} numberOfLines={1}>
            {presentation.summary}
          </Text>
        </Pressable>
      ) : null}

      {presentation.mode === 'EXPANDED_NOW' || presentation.mode === 'COMPACT_UPCOMING' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.railRow}
          testID="telegraph-rail-cards"
        >
          {presentation.cards.map((item, index) => (
            <RailCard
              key={item.objectId}
              item={item}
              expanded={presentation.mode === 'EXPANDED_NOW' && index === 0}
              palette={palette}
              styles={styles}
              onPress={() => onOpenObject?.(item)}
            />
          ))}
          {presentation.seeAllCount > 0 ? (
            <Pressable
              testID="telegraph-rail-see-all"
              accessibilityRole="button"
              accessibilityLabel={`See all shared context, ${presentation.seeAllCount} more`}
              onPress={() => onSeeAll?.(response.sharedContext)}
              style={styles.seeAll}
            >
              <Text style={styles.seeAllText}>See all · {presentation.seeAllCount}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}

      {presentation.incomplete ? (
        <Text style={styles.incomplete} testID="telegraph-rail-incomplete">
          Some shared context could not be loaded
        </Text>
      ) : null}
    </View>
  );
}

function changeWord(change: CriticalChange): string {
  return change.reason === 'CANCELLED' ? 'Cancelled' : 'Time changed';
}

function RailCard({
  item,
  expanded,
  palette,
  styles,
  onPress,
}: {
  item: SharedContextItem;
  expanded: boolean;
  palette: TelegraphPalette;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}) {
  const bandWord = statusLabelFor(item.orderBand);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bandWord}: ${item.title}`}
      onPress={onPress}
      style={[styles.card, expanded ? styles.cardExpanded : null]}
      testID={`telegraph-rail-card-${item.objectId}`}
    >
      {/* §11.3: the band is a WORD first; the rule beside it only reinforces it. */}
      <View style={[styles.bandRule, { backgroundColor: palette.operational }]} />
      <Text style={styles.bandWord}>{bandWord}</Text>
      <Text style={styles.cardTitle} numberOfLines={expanded ? 2 : 1}>
        {item.title}
      </Text>
      {item.availableActions.length > 0 ? (
        <Text style={styles.cardActions} numberOfLines={1}>
          {item.availableActions.slice(0, expanded ? 3 : 1).map(prettyAction).join(' · ')}
        </Text>
      ) : null}
    </Pressable>
  );
}

function prettyAction(a: string): string {
  return a
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    wrap: {
      backgroundColor: p.surfaceRaised,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.hairline,
      paddingVertical: space.sm,
    },
    loadingWrap: { paddingVertical: space.md, alignItems: 'center' },
    railRow: { paddingHorizontal: space.lg, gap: space.sm },
    card: {
      minWidth: 148,
      maxWidth: 220,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.recvBorder,
      backgroundColor: p.surface,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      gap: 2,
    },
    cardExpanded: { minWidth: 232, maxWidth: 300 },
    bandRule: { height: 2, width: 18, borderRadius: 2, marginBottom: 4 },
    bandWord: { ...t.small, color: p.mute, letterSpacing: 0.4 },
    cardTitle: { ...t.body, color: p.recvText, fontWeight: '700' },
    cardActions: { ...t.small, color: p.operational },
    seeAll: {
      justifyContent: 'center',
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.hairline,
      backgroundColor: p.chipFill,
    },
    seeAllText: { ...t.small, color: p.recvText },
    summary: { paddingHorizontal: space.lg, paddingVertical: space.xs },
    summaryText: { ...t.small, color: p.mute },
    minimized: { paddingHorizontal: space.lg, paddingVertical: 2 },
    minimizedText: { ...t.small, color: p.mute },
    changeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      marginHorizontal: space.lg,
      marginBottom: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.md,
      backgroundColor: p.chipFill,
      borderWidth: 1,
      // §11.1: stronger attention is RESERVED for safety and urgent change.
      // This card is the urgent-change case, and the only place in the rail
      // that uses it.
      borderColor: p.attention,
    },
    changeCardEmphasis: { borderWidth: 2 },
    changeWord: { ...t.small, color: p.attention, fontWeight: '800' },
    changeTitle: { ...t.small, color: p.recvText, flexShrink: 1 },
    ackButton: {
      marginLeft: 'auto',
      paddingHorizontal: space.sm,
      paddingVertical: 4,
      borderRadius: radius.pill,
      backgroundColor: p.attention,
    },
    ackText: { ...t.small, color: p.attentionOn, fontWeight: '700' },
    incomplete: { ...t.small, color: p.mute, paddingHorizontal: space.lg, paddingTop: space.xs },
  });
}

export default SharedContextRail;
