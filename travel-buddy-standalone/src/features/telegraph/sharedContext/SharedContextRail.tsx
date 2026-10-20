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
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { useSession } from '../../../context/SessionContext.tsx';
import { onAuthChange } from '../../../services/auth.ts';
import { useTelegraphPalette, statusLabelFor, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { fetchSharedContext } from './api.ts';
import {
  detectCriticalChanges,
  resolveRailPresentation,
  type CriticalChange,
} from './railBehavior.ts'; import { detectChangesSinceSeen, nextSeenSnapshot, type SeenSnapshot } from './railBehavior.ts';
import { captureRailSeenScope, readRailSeen, writeRailSeen, type RailSeenScope } from './railSeenStore.ts';
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

export function SharedContextRail(props: SharedContextRailProps) {
  const { userId } = useSession();
  const authEpoch = useRef(0);
  const observedOwner = useRef(userId);
  const [authState, setAuthState] = useState<{ userId: string | null; epoch: number } | null>(null);
  useLayoutEffect(() => {
    const unsubscribe = onAuthChange((nextUserId) => {
      if (observedOwner.current === nextUserId) return;
      observedOwner.current = nextUserId;
      authEpoch.current++;
      setAuthState({ userId: nextUserId, epoch: authEpoch.current });
    });
    return unsubscribe;
  }, []);
  const ownerId = authState && authState.userId !== userId ? null : userId;
  const epoch = authState?.epoch ?? 0;
  const scope = useMemo(() => ({ ownerId, threadId: props.threadId, epoch }), [ownerId, props.threadId, epoch]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const initialScope = useRef(scope);
  const isScopeCurrent = useCallback(() => currentScope.current === scope && authEpoch.current === scope.epoch, [scope]);
  if (!ownerId) return null;
  return <ScopedSharedContextRail
    {...props}
    key={JSON.stringify([ownerId, props.threadId, epoch])}
    ownerId={ownerId}
    isScopeCurrent={isScopeCurrent}
    initialResponse={initialScope.current === scope ? props.initialResponse : null}
  />;
}

function ScopedSharedContextRail({
  threadId,
  scrolled = false,
  onOpenObject,
  onSeeAll,
  initialResponse = null,
  ownerId,
  isScopeCurrent,
}: SharedContextRailProps & { ownerId: string; isScopeCurrent: () => boolean }) {
  const palette = useTelegraphPalette();
  const reduceMotion = useReducedMotionSetting();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [response, setResponse] = useState<SharedContextResponse | null>(initialResponse);
  // T264: the last projection shown by THIS mount, and what this account last SAW in this conversation on this device.
  const lastShown = useRef<{ projection: TelegraphSharedContextProjection | null; seen: SeenSnapshot | null; scope: RailSeenScope | null; found: CriticalChange[] }>({ projection: null, seen: null, scope: null, found: [] });
  const [changes, setChanges] = useState<CriticalChange[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const acknowledgedRef = useRef<string[]>([]);
  const [loading, setLoading] = useState(initialResponse === null);
  const [failed, setFailed] = useState(false);

  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = useCallback(() => mounted.current && isScopeCurrent(), [isScopeCurrent]);

  useEffect(() => {
    let active = true;
    let ownerScope: RailSeenScope | null = null;
    const requestCurrent = () => active && isCurrent() && (ownerScope?.isCurrent() ?? true);
    const load = async () => {
      try {
        ownerScope = await captureRailSeenScope(threadId, ownerId);
        if (!ownerScope || !requestCurrent()) {
          ownerScope?.dispose();
          return;
        }
        setLoading(true);
        const result = await fetchSharedContext(threadId);
        if (!requestCurrent()) return;
        if (!result.ok || result.data.sharedContext.conversationId !== threadId) {
          setFailed(true);
          return;
        }
        const current = result.data.sharedContext;
        // §11.2 row 5 across an absence: compare with what was last SEEN here (kept per account), so a plan moved or
        // called off while the member was away is promoted when they return; with no record, only this mount's last fetch.
        const stored = await readRailSeen(ownerScope);
        if (!requestCurrent()) return;
        const seen = stored.state === 'seen' ? stored.snapshot : null;
        const found = seen ? detectChangesSinceSeen(seen, current) : detectCriticalChanges(lastShown.current.projection, current);
        // An unreadable record is not "never seen": nothing is written over it.
        const scope = stored.state === 'none' || stored.state === 'seen' ? ownerScope : null;
        lastShown.current = { projection: current, seen, scope, found };
        if (scope) void writeRailSeen(scope, nextSeenSnapshot(seen, current, found, acknowledgedRef.current));
        setChanges(found);
        setResponse(result.data);
        setFailed(false);
      } catch {
        if (requestCurrent()) setFailed(true);
      } finally {
        if (active && isCurrent()) setLoading(false);
      }
    };
    if (initialResponse === null) void load();
    return () => { active = false; ownerScope?.dispose(); };
  }, [initialResponse, isCurrent, ownerId, threadId]);

  const acknowledge = useCallback((key: string) => {
    const shown = lastShown.current;
    if (!isCurrent() || !shown.scope?.isCurrent() || !shown.found.some((change) => change.changeKey === key)) return;
    if (!acknowledgedRef.current.includes(key)) acknowledgedRef.current = [...acknowledgedRef.current, key];
    setAcknowledged(acknowledgedRef.current);
    // T264: an acknowledged change is seen — the record takes the new value, so it is not promoted again.
    if (shown.projection) void writeRailSeen(shown.scope, nextSeenSnapshot(shown.seen, shown.projection, shown.found, acknowledgedRef.current));
  }, [isCurrent]);

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
          onPress={() => { if (isCurrent()) onSeeAll?.(response.sharedContext); }}
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
          onPress={() => { if (isCurrent()) onSeeAll?.(response.sharedContext); }}
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
              onPress={() => { if (isCurrent()) onOpenObject?.(item); }}
            />
          ))}
          {presentation.seeAllCount > 0 ? (
            <Pressable
              testID="telegraph-rail-see-all"
              accessibilityRole="button"
              accessibilityLabel={`See all shared context, ${presentation.seeAllCount} more`}
              onPress={() => { if (isCurrent()) onSeeAll?.(response.sharedContext); }}
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

function eventAttendanceLabel(item: SharedContextItem): string | null {
  if (item.objectType !== 'EVENT') return null;
  const attendance = item.eventAttendance;
  if (!Array.isArray(attendance) || attendance.some((person) =>
    !person || typeof person.userId !== 'string' || !person.userId.trim() ||
    typeof person.label !== 'string' || !person.label.trim())) return 'Attendance unavailable';
  if (attendance.length === 0) return 'No visible Going members from this conversation';
  return `Going from this conversation: ${attendance.map((person) => person.label).join(', ')}`;
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
  const attendance = eventAttendanceLabel(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bandWord}: ${item.title}${attendance ? `. ${attendance}` : ''}`}
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
      {attendance ? <Text style={styles.cardAttendance}>{attendance}</Text> : null}
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
    cardAttendance: { ...t.small, color: p.recvText },
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
