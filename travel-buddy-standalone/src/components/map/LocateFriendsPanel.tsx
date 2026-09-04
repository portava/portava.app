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
 * TWO SOURCES, ONE RENDERER
 * =========================
 * The panel renders from props (`session` + `members`, resolved locally through
 * `resolveMember`) OR from the server, by passing `live`. In live mode
 * `services/locateFriends.ts` owns the session: it polls the group, publishes
 * this device's position at whatever §12 rung is answering, and — critically —
 * stops both of those the moment this component unmounts or the session ends.
 * An interval that outlives the screen and keeps publishing somebody's location
 * after they closed it is the worst bug this file can have, so the effect that
 * starts the sync is the same effect that stops it, with nothing else able to
 * keep it alive.
 *
 * The panel does NOT re-derive anything the server already decided (§19): a
 * live member arrives as an already-resolved `LocateMemberState` and goes
 * straight to `describeMember`. `resolveMember` runs only on the props path.
 *
 * LEAVE IS NEVER GATED. In live mode the Leave control renders unconditionally
 * — including when the session reads as unavailable or ended, which is exactly
 * the state someone must be able to get out of. The DELETE route it calls is
 * the one server handler that ignores `locate_friends_enabled`, for the same
 * reason: a capability switch must not be able to strand an opted-in member.
 *
 * Dark-mode first (§4): near-black/navy chrome, translucent rounded card,
 * large touch targets.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type LocateSignal,
  type MemberDisplayState,
} from '../../features/map/presence/locateFriends.ts';
import {
  CURRENT_STACK_CAPABILITIES,
  type PrecisionGrant,
  type PresenceCapabilities,
  type PrivacyClass,
} from '../../features/map/presence/presenceLadder.ts';
import {
  IDLE_LIVE_STATE,
  createLocateFriendsSync,
  memberSnapshotToState,
  toLocateSession,
  type LocateFriendsLiveState,
  type LocateFriendsSync,
  type LocateFriendsTransport,
} from '../../services/locateFriends.ts';

const CHROME = '#0B1017';
const CHROME_RAISED = '#131A24';
const CHROME_EDGE = 'rgba(250,249,246,0.14)';

/** How often the countdown re-renders. A minute-resolution label needs no more. */
const TICK_MS = 15_000;

/**
 * Everything the panel needs to drive a real session.
 *
 * Passing this switches the panel to live mode: `session` and `members` are
 * ignored and the panel owns the read poll, the publish poll and the Leave
 * call for as long as it is mounted.
 */
export interface LocateFriendsLiveConfig {
  /** The server session id. */
  sessionId: string;
  /**
   * The viewer's own member id. REQUIRED, because the server excludes the
   * viewer from `members` — without it a valid solo session would look like a
   * session with nobody in it, which `createLocateSession` rejects.
   */
  viewerMemberId: string;
  /**
   * Sample this device's position for the publish tick. Return `null` to
   * publish nothing this tick. Omit entirely to read without ever publishing.
   */
  sampleSignal?: () => LocateSignal | null | Promise<LocateSignal | null>;
  /** The viewer's grant. Absent ⇒ §23's ungranted `approximate` ceiling. */
  grant?: PrecisionGrant | null;
  /** Test/preview seam. */
  transport?: Partial<LocateFriendsTransport> | null;
}

export interface LocateFriendsPanelProps {
  /**
   * The validated session. `null` renders the "no session" state.
   * Ignored when `live` is set — the server's summary is used instead.
   */
  session?: LocateSession | null;
  /** Ignored when `live` is set. */
  members?: readonly LocateMemberInput[];
  /** Drive the panel from the real §12 endpoints. See `LocateFriendsLiveConfig`. */
  live?: LocateFriendsLiveConfig | null;
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

/**
 * Own the sync for exactly as long as the panel is mounted.
 *
 * The effect that starts it is the effect that stops it, and `stop()` is
 * idempotent, so there is no path — re-render, prop change, session end,
 * unmount — that leaves an interval publishing a location behind a closed
 * screen. The sync itself also stops on `unavailable` and on an expired
 * session; the cleanup here is the backstop, not the only stop.
 */
function useLocateFriendsLive(
  live: LocateFriendsLiveConfig | null | undefined,
  capabilities: PresenceCapabilities,
): { state: LocateFriendsLiveState; sync: LocateFriendsSync | null } {
  const [state, setState] = useState<LocateFriendsLiveState>(IDLE_LIVE_STATE);
  const syncRef = useRef<LocateFriendsSync | null>(null);
  const [, force] = useState(0);

  // The sampler, the grant and the capabilities are read through refs and
  // getters so a caller passing an inline arrow function or an inline
  // capabilities object does not tear the sync down and rebuild it — and
  // therefore does not restart the publish clock — on every render. Only the
  // session id (and whether a sampler exists at all) can rebuild it.
  const configRef = useRef(live);
  configRef.current = live;
  const capsRef = useRef(capabilities);
  capsRef.current = capabilities;

  const sessionId = live?.sessionId ?? null;
  const publishes = Boolean(live?.sampleSignal);

  useEffect(() => {
    if (!sessionId) {
      syncRef.current = null;
      setState(IDLE_LIVE_STATE);
      return undefined;
    }
    const sync = createLocateFriendsSync({
      sessionId,
      onChange: setState,
      sampleSignal: publishes
        ? () => configRef.current?.sampleSignal?.() ?? null
        : undefined,
      get grant() {
        return configRef.current?.grant ?? null;
      },
      get capabilities() {
        return capsRef.current;
      },
      get transport() {
        return configRef.current?.transport ?? null;
      },
    });
    syncRef.current = sync;
    force((n) => n + 1);
    sync.start();
    // The one cleanup that matters: an interval must never outlive the screen.
    return () => {
      sync.stop();
      syncRef.current = null;
    };
  }, [sessionId, publishes]);

  return { state, sync: syncRef.current };
}

const NO_MEMBERS: readonly LocateMemberInput[] = Object.freeze([]);

export function LocateFriendsPanel({
  session = null,
  members = NO_MEMBERS,
  live = null,
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

  useEffect(() => {
    if (nowProp != null) return undefined;
    const id = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [nowProp]);

  const { state: liveState, sync } = useLocateFriendsLive(live, capabilities);
  const viewerId = live?.viewerMemberId ?? viewerMemberId;

  // In live mode the session model is rebuilt from the server summary through
  // `createLocateSession`, so §12's "temporary and auto-expiring" is enforced on
  // this path too rather than assumed because the server said so.
  const liveSession = useMemo(() => {
    if (!live || liveState.status !== 'ok') return null;
    const built = toLocateSession(liveState, live.viewerMemberId, now);
    return built.ok ? built.session : null;
  }, [live, liveState, now]);

  const effectiveSession = live ? liveSession : session;
  const active = isActive(effectiveSession, now);

  const rows = useMemo(() => {
    const empty = [] as Array<{ state: LocateMemberState; display: MemberDisplayState }>;
    if (live) {
      // §19: the server already resolved these. Re-running `resolveMember` here
      // would be a second implementation of the same privacy rule.
      return liveState.members.map((snapshot) => {
        const state = memberSnapshotToState(snapshot);
        return { state, display: describeMember(state) };
      });
    }
    if (!session) return empty;
    return members.map((m) => {
      const state = resolveMember(session, m, now, { capabilities, additionalBounds });
      return { state, display: describeMember(state) };
    });
  }, [live, liveState, session, members, now, capabilities, additionalBounds]);

  const missingRungs = useMemo(() => unsupportedRungs(capabilities), [capabilities]);
  const anyDegraded = rows.some((r) => r.display.degraded);
  const anyOffline = rows.some((r) => r.state.resolved.offline);
  const isStale = live ? liveState.stale : false;

  // LEAVE IS NOT GATED. In live mode it is always offered, whatever the session
  // reads as — including `unavailable`, which is precisely the state someone
  // could otherwise be stranded in.
  const leaveHandler = useCallback(() => {
    if (sync) void sync.leave();
    onLeave?.();
  }, [sync, onLeave]);
  const showLeave = Boolean(live) || Boolean(onLeave);

  if (!effectiveSession || !active) {
    const endedCopy = live
      ? liveState.status === 'unavailable'
        ? // ONE honest line for every cause. The server refuses to say which,
          // and reconstructing the difference here would rebuild the oracle.
          'This session is not available. If you were sharing, you have stopped.'
        : liveState.status === 'ok'
          ? 'This session has ended. Locations are no longer shared.'
          : 'Finding your group…'
      : session
        ? 'This session has ended. Locations are no longer shared.'
        : 'Start a temporary, group-only session to find each other. It expires on its own.';
    return (
      <View style={s.card} testID={testID}>
        <View style={s.header}>
          <Users size={icon.s18} color={color.onInk} strokeWidth={2.2} />
          <Text style={s.title}>Locate My Friends</Text>
        </View>
        <Text style={s.emptyBody}>{endedCopy}</Text>
        {onStartSession && !live ? (
          <Pressable
            onPress={onStartSession}
            style={s.primaryButton}
            accessibilityRole="button"
            accessibilityLabel="Start a Locate My Friends session"
          >
            <Text style={s.primaryButtonLabel}>Start a session</Text>
          </Pressable>
        ) : null}
        {/* Always reachable — see the file header. */}
        {showLeave ? (
          <Pressable
            onPress={leaveHandler}
            style={s.secondaryButton}
            accessibilityRole="button"
            accessibilityLabel="Leave this session"
          >
            <LogOut size={icon.s16} color={color.onInk} strokeWidth={2.2} />
            <Text style={s.secondaryButtonLabel}>Leave</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const remaining = describeSessionRemaining(effectiveSession, now);

  return (
    <View style={s.card} testID={testID}>
      {/* Header — who, and for how much longer. */}
      <View style={s.header}>
        <Users size={icon.s18} color={color.onInk} strokeWidth={2.2} />
        <View style={s.headerText}>
          <Text style={s.title} numberOfLines={1}>
            {effectiveSession.label ?? 'Locate My Friends'}
          </Text>
          <Text style={s.subtitle}>
            {effectiveSession.optedInMemberIds.length} sharing · group only
          </Text>
        </View>
        <View style={s.timerChip} accessibilityLabel={remaining}>
          <Clock size={icon.s14} color={color.onInk} strokeWidth={2.2} />
          <Text style={s.timerLabel}>{remaining}</Text>
        </View>
      </View>

      {/*
        §28 degraded / offline indicator. Shown whenever a lower rung answers —
        and, in live mode, whenever the last poll failed. A stale list that
        looks current is the failure §37 calls out ("do not let stale claims
        remain visually live"), so the staleness is said out loud rather than
        being handled by silently emptying the list.
      */}
      {(isStale || anyDegraded || anyOffline || missingRungs.length > 0) && (
        <View style={s.degradedBanner} accessibilityRole="alert">
          <WifiOff size={icon.s14} color={color.warn} strokeWidth={2.2} />
          <Text style={s.degradedText}>
            {isStale
              ? 'Cannot reach the group right now — showing the last update received.'
              : anyOffline
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
          <Text style={s.emptyBody}>
            {isStale
              ? 'No update yet — trying again.'
              : 'Nobody else has joined this session yet.'}
          </Text>
        ) : (
          rows.map(({ state, display }) => (
            <MemberRow
              key={state.memberId}
              state={state}
              display={display}
              isViewer={state.memberId === viewerId}
              onPress={onSelectMember ? () => onSelectMember(state.memberId) : undefined}
            />
          ))
        )}
      </ScrollView>

      {/*
        The way out. §12: temporary, and endable at any moment. In live mode
        Leave renders unconditionally — no flag, no capability, no status check
        stands between an opted-in member and revocation.
      */}
      <View style={s.footer}>
        {showLeave ? (
          <Pressable
            onPress={leaveHandler}
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
