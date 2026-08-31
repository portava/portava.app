/**
 * LocateFriendsPanel — the §12 "Locate My Friends" panel.
 *
 * WHAT §12 ASKS THIS SCREEN TO SHOW
 * =================================
 *   - the group's members, each at whatever rung of the fallback chain is
 *     actually answering ("Nearby ~40-80m", "Last seen 3m ago",
 *     "Checkpoint: Food Court"),
 *   - that the session is TEMPORARY, by showing the time it has left,
 *   - an explicit way out (Leave, or End for everyone),
 *   - and, per §28, an honest degraded/offline indicator when a lower rung is
 *     answering rather than a live fix.
 *
 * All of the judgement lives in `features/map/presence/locateFriends.ts`. This
 * file renders what that module decided and adds nothing: it never reads a
 * coordinate, never formats a distance, and never decides whether an avatar may
 * be drawn — `MemberPresenceMarker` asks `mayRenderIdentity` for that. A privacy
 * rule that a component could re-derive is a privacy rule with two
 * implementations, and the second one is always the one that leaks.
 *
 * Dark-mode first (§4): near-black/navy chrome, translucent rounded card,
 * large touch targets.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Users, Clock, WifiOff, LogOut, CircleSlash } from 'lucide-react-native';

import { color, radius, space, typography, avatar, icon } from '../../theme/tokens.ts';
import { MemberPresenceMarker } from './CheckpointPin.tsx';
import {
  describeMember,
  describeSessionRemaining,
  isActive,
  resolveMember,
  unsupportedRungs,
  RUNG_POLICY,
  type LocateMemberInput,
  type LocateMemberState,
  type LocateSession,
  type MemberDisplayState,
} from '../../features/map/presence/locateFriends.ts';
import {
  CURRENT_STACK_CAPABILITIES,
  type PresenceCapabilities,
  type PrivacyClass,
} from '../../features/map/presence/presenceLadder.ts';

const CHROME = '#0B1017';
const CHROME_RAISED = '#131A24';
const CHROME_EDGE = 'rgba(250,249,246,0.14)';

/** How often the countdown re-renders. A minute-resolution label needs no more. */
const TICK_MS = 15_000;

export interface LocateFriendsPanelProps {
  /** The validated session. `null` renders the "no session" state. */
  session: LocateSession | null;
  members: readonly LocateMemberInput[];
  /** The viewer, so the panel can offer Leave rather than End for everyone. */
  viewerMemberId?: string | null;
  /** Device capabilities; drives the §28/§66 "what is unavailable" line. */
  capabilities?: PresenceCapabilities;
  /** Any further ceiling in force (viewer preference, §24 suppression). */
  additionalBounds?: readonly PrivacyClass[];
  /** Injectable clock, for tests and for previews. */
  now?: number;
  onSelectMember?: (memberId: string) => void;
  /** The viewer leaves; the session continues for everyone else. */
  onLeave?: () => void;
  /** The session ends for the whole group. */
  onEndSession?: () => void;
  onStartSession?: () => void;
  testID?: string;
}

export function LocateFriendsPanel({
  session,
  members,
  viewerMemberId = null,
  capabilities = CURRENT_STACK_CAPABILITIES,
  additionalBounds,
  now: nowProp,
  onSelectMember,
  onLeave,
  onEndSession,
  onStartSession,
  testID,
}: LocateFriendsPanelProps) {
  const [tick, setTick] = useState(() => nowProp ?? Date.now());
  const now = nowProp ?? tick;

  const active = isActive(session, now);

  useEffect(() => {
    if (nowProp != null) return undefined;
    const id = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [nowProp]);

  const rows = useMemo(() => {
    if (!session) return [] as Array<{ state: LocateMemberState; display: MemberDisplayState }>;
    return members.map((m) => {
      const state = resolveMember(session, m, now, { capabilities, additionalBounds });
      return { state, display: describeMember(state) };
    });
  }, [session, members, now, capabilities, additionalBounds]);

  const missingRungs = useMemo(() => unsupportedRungs(capabilities), [capabilities]);
  const anyDegraded = rows.some((r) => r.display.degraded);
  const anyOffline = rows.some((r) => r.state.resolved.offline);

  if (!session || !active) {
    return (
      <View style={s.card} testID={testID}>
        <View style={s.header}>
          <Users size={icon.s18} color={color.onInk} strokeWidth={2.2} />
          <Text style={s.title}>Locate My Friends</Text>
        </View>
        <Text style={s.emptyBody}>
          {session
            ? 'This session has ended. Locations are no longer shared.'
            : 'Start a temporary, group-only session to find each other. It expires on its own.'}
        </Text>
        {onStartSession ? (
          <Pressable
            onPress={onStartSession}
            style={s.primaryButton}
            accessibilityRole="button"
            accessibilityLabel="Start a Locate My Friends session"
          >
            <Text style={s.primaryButtonLabel}>Start a session</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const remaining = describeSessionRemaining(session, now);

  return (
    <View style={s.card} testID={testID}>
      {/* Header — who, and for how much longer. */}
      <View style={s.header}>
        <Users size={icon.s18} color={color.onInk} strokeWidth={2.2} />
        <View style={s.headerText}>
          <Text style={s.title} numberOfLines={1}>
            {session.label ?? 'Locate My Friends'}
          </Text>
          <Text style={s.subtitle}>
            {session.optedInMemberIds.length} sharing · group only
          </Text>
        </View>
        <View style={s.timerChip} accessibilityLabel={remaining}>
          <Clock size={icon.s14} color={color.onInk} strokeWidth={2.2} />
          <Text style={s.timerLabel}>{remaining}</Text>
        </View>
      </View>

      {/* §28 degraded / offline indicator. Shown whenever a lower rung answers. */}
      {(anyDegraded || anyOffline || missingRungs.length > 0) && (
        <View style={s.degradedBanner} accessibilityRole="alert">
          <WifiOff size={icon.s14} color={color.warn} strokeWidth={2.2} />
          <Text style={s.degradedText}>
            {anyOffline
              ? 'Some people are not reachable right now — showing their last known state.'
              : anyDegraded
                ? 'Reduced accuracy: showing approximate positions and checkpoints.'
                : `Unavailable on this device: ${missingRungs
                    .map((r) => RUNG_POLICY[r].estimateState)
                    .join(', ')}.`}
          </Text>
        </View>
      )}

      {/* Members. */}
      <ScrollView
        style={s.list}
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
      >
        {rows.length === 0 ? (
          <Text style={s.emptyBody}>Nobody has joined this session yet.</Text>
        ) : (
          rows.map(({ state, display }) => (
            <MemberRow
              key={state.memberId}
              state={state}
              display={display}
              isViewer={state.memberId === viewerMemberId}
              onPress={onSelectMember ? () => onSelectMember(state.memberId) : undefined}
            />
          ))
        )}
      </ScrollView>

      {/* The way out. §12: temporary, and endable at any moment. */}
      <View style={s.footer}>
        {onLeave ? (
          <Pressable
            onPress={onLeave}
            style={s.secondaryButton}
            accessibilityRole="button"
            accessibilityLabel="Leave this session"
          >
            <LogOut size={icon.s16} color={color.onInk} strokeWidth={2.2} />
            <Text style={s.secondaryButtonLabel}>Leave</Text>
          </Pressable>
        ) : null}
        {onEndSession ? (
          <Pressable
            onPress={onEndSession}
            style={s.dangerButton}
            accessibilityRole="button"
            accessibilityLabel="End this session for everyone"
          >
            <CircleSlash size={icon.s16} color={color.paper} strokeWidth={2.2} />
            <Text style={s.dangerButtonLabel}>End for everyone</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function MemberRow({
  state,
  display,
  isViewer,
  onPress,
}: {
  state: LocateMemberState;
  display: MemberDisplayState;
  isViewer: boolean;
  onPress?: () => void;
}) {
  const name = state.displayName ?? 'Group member';
  const body = (
    <View style={s.row}>
      <MemberPresenceMarker member={state} size={avatar.s36} />
      <View style={s.rowText}>
        <Text style={s.rowName} numberOfLines={1}>
          {name}
          {isViewer ? ' (you)' : ''}
        </Text>
        <Text
          style={[s.rowState, display.kind === 'not_sharing' && s.rowStateMuted]}
          numberOfLines={1}
        >
          {display.text}
        </Text>
      </View>
      {display.degraded && display.kind !== 'not_sharing' ? (
        <View style={s.rowBadge} accessibilityLabel="Reduced accuracy">
          <Text style={s.rowBadgeLabel}>APPROX</Text>
        </View>
      ) : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}: ${display.text}`}
    >
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: CHROME,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHROME_EDGE,
    padding: space.lg,
    gap: space.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerText: { flex: 1, minWidth: 0 },
  title: { ...typography.sectionTitle, color: color.onInk },
  subtitle: { ...typography.metadata, color: color.onInkMute, marginTop: 2 },
  timerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: CHROME_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHROME_EDGE,
  },
  timerLabel: { ...typography.metadata, color: color.onInk },

  degradedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(200,133,26,0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,133,26,0.42)',
  },
  degradedText: { ...typography.caption, color: color.onInk, flex: 1 },

  list: { maxHeight: 320 },
  listContent: { gap: space.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    backgroundColor: CHROME_RAISED,
    minHeight: 56,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { ...typography.cardTitle, color: color.onInk },
  rowState: { ...typography.supporting, color: color.onInkMute, marginTop: 2 },
  rowStateMuted: { color: 'rgba(250,249,246,0.45)' },
  rowBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHROME_EDGE,
  },
  rowBadgeLabel: { ...typography.metadata, color: color.onInkMute },

  footer: { flexDirection: 'row', gap: space.sm },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
    minHeight: 48,
  },
  primaryButtonLabel: { ...typography.button, color: color.paper },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: CHROME_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHROME_EDGE,
    minHeight: 48,
  },
  secondaryButtonLabel: { ...typography.button, color: color.onInk },
  dangerButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
    minHeight: 48,
  },
  dangerButtonLabel: { ...typography.button, color: color.paper },

  emptyBody: { ...typography.body, color: color.onInkMute },
});

export default LocateFriendsPanel;
