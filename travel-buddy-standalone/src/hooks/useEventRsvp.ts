/**
 * useEventRsvp — manages the full RSVP / join / waitlist / leave state machine
 * for a single event, decoupled from any particular screen.
 *
 * OUTCOME REPORTING (spec §7 / signal-audit §3a)
 * ---------------------------------------------
 * This hook is the chokepoint every event RSVP passes through, so outcome
 * emission lives here rather than at each screen — the same reason the shared
 * admin guard and openDirectThread exist. Wire it once and no caller can
 * forget it.
 *
 * Why this matters: the signal audit found that attribution, not capture, is
 * the gap. Every outcome table exists, but none carries a reference back to
 * rank_events, so the funnel query ("of the impressions served in session X,
 * which led to a join?") has no key to join on. On this tree exactly ONE
 * outcome was being emitted anywhere — `save`, from SaveButton — which means
 * the instrumentation was biased toward precisely the passive-engagement
 * metric the spec rejects.
 *
 * WHAT EMITS, AND WHAT DELIBERATELY DOES NOT
 * ------------------------------------------
 * The outcome enum is tap | save | join | rsvp | attended. It has no way to
 * express degrees of intent, so anything ambiguous is left unemitted. Under-
 * reporting is recoverable later; over-reporting silently poisons the data the
 * v2 weights get fitted on, and nobody would ever see it.
 *
 *   handleRsvp('going')   → 'rsvp'   a definite commitment to attend
 *   handleAcceptOffer     → 'join'   waitlist offer accepted; now confirmed
 *
 *   handleRsvp('maybe' | 'interested')
 *       NOT emitted. Both are real but much weaker than 'going' — in the
 *       spec's hierarchy they sit below "saved place/plan", and the enum
 *       cannot say so. Emitting 'rsvp' for them would rank a shrug equal to a
 *       commitment.
 *   handleRsvp('cant_go')
 *       NOT emitted. It is a negative signal; recording it as an outcome
 *       would invert its meaning.
 *   handleRequestJoin
 *       NOT emitted. A request awaits host approval — it is intent, not an
 *       outcome. It becomes one only if the host accepts, which happens
 *       elsewhere.
 *   handleJoinWaitlist
 *       NOT emitted. Joining a queue is not joining an event.
 *   handleJoinChat
 *       NOT emitted. Genuine engagement, but the closest hierarchy rung is
 *       "Telegraph conversation" and no enum value expresses it. Left for a
 *       future outcome value rather than mapped onto a wrong one.
 *   handleLeave / handleLeaveWaitlist
 *       NOT emitted. Negative outcomes.
 *
 * Every emission is gated on the API call actually succeeding, so a failed
 * RSVP never reports one. fireRankOutcome is fire-and-forget and swallows its
 * own errors, so this can never block or break an RSVP.
 *
 * sessionId is optional and threads through from the feed that served the
 * impression. When absent the row still lands with (user_id, item_id), which
 * supports the time-window heuristic attribution described in signal-audit
 * §3a option 3 — less precise, but not nothing.
 */
import { useState, useCallback } from 'react';
import { Alert } from 'react-native';
import {
  rsvpEvent, leaveEvent, joinWaitlist, leaveWaitlist,
  acceptWaitlistOffer, requestToJoinEvent, joinEventChat,
  type EventDetail, type EventRsvpStatus,
} from '../services/events.ts';
import { fireRankOutcome } from './useRankOutcome.ts';

interface UseEventRsvpReturn {
  busy: boolean;
  handleRsvp: (status: EventRsvpStatus) => Promise<void>;
  handleLeave: () => Promise<void>;
  handleJoinWaitlist: () => Promise<void>;
  handleLeaveWaitlist: () => Promise<void>;
  handleAcceptOffer: () => Promise<void>;
  handleRequestJoin: (message?: string) => Promise<boolean>;
  handleJoinChat: (onThreadId: (threadId: string) => void) => Promise<void>;
}

interface UseEventRsvpOptions {
  /**
   * Session UUID from the feed response that served this event's impression.
   * Narrows outcome attribution to a specific feed load. Omit when the event
   * was reached directly (deep link, search, notification) — the outcome still
   * records and remains attributable heuristically.
   */
  sessionId?: string | null;
}

export function useEventRsvp(
  event: EventDetail | null,
  onRefresh: () => Promise<void>,
  onEventChange?: (updater: (e: EventDetail) => EventDetail) => void,
  options: UseEventRsvpOptions = {},
): UseEventRsvpReturn {
  const [busy, setBusy] = useState(false);
  const sessionId = options.sessionId ?? null;

  const handleRsvp = useCallback(async (status: EventRsvpStatus) => {
    if (!event) return;
    setBusy(true);
    const res = await rsvpEvent(event.id, status);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('RSVP failed', res.message ?? 'Could not update RSVP');
      return;
    }

    // Only 'going' is a commitment. See the header for why the weaker
    // statuses are deliberately silent rather than mapped onto 'rsvp'.
    if (status === 'going') {
      fireRankOutcome(event.id, 'events', 'rsvp', sessionId);
    }

    const data = res.data as any;
    if (data?.status === 'waitlisted') {
      Alert.alert('Added to waitlist', data.message ?? 'You are now on the waitlist.');
      await onRefresh();
      return;
    }
    if (onEventChange) {
      onEventChange((e) => ({
        ...e,
        myRsvp: status,
        counts: {
          ...e.counts,
          going: status === 'going' ? e.counts.going + 1
            : e.myRsvp === 'going' ? e.counts.going - 1
            : e.counts.going,
        },
      }));
    }
    await onRefresh();
  }, [event, onRefresh, onEventChange, sessionId]);

  const handleLeave = useCallback(async () => {
    if (!event) return;
    Alert.alert('Leave event?', 'Your RSVP will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive',
        onPress: async () => {
          setBusy(true);
          const res = await leaveEvent(event.id);
          setBusy(false);
          if (!res.ok) Alert.alert('Error', res.message ?? 'Could not leave event');
          else await onRefresh();
        },
      },
    ]);
  }, [event, onRefresh]);

  const handleJoinWaitlist = useCallback(async () => {
    if (!event) return;
    setBusy(true);
    const res = await joinWaitlist(event.id);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('Error', res.message ?? 'Could not join waitlist');
      return;
    }
    Alert.alert('Added to waitlist', `You are #${res.data?.position ?? '?'} in the queue.`);
    await onRefresh();
  }, [event, onRefresh]);

  const handleLeaveWaitlist = useCallback(async () => {
    if (!event) return;
    Alert.alert('Leave waitlist?', 'Your position in the queue will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive',
        onPress: async () => {
          setBusy(true);
          const res = await leaveWaitlist(event.id);
          setBusy(false);
          if (!res.ok) Alert.alert('Error', res.message ?? 'Could not leave waitlist');
          else await onRefresh();
        },
      },
    ]);
  }, [event, onRefresh]);

  const handleAcceptOffer = useCallback(async () => {
    if (!event) return;
    setBusy(true);
    const res = await acceptWaitlistOffer(event.id);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('Error', res.message ?? 'Could not accept offer');
      return;
    }

    // Accepting a waitlist offer converts a queue position into a confirmed
    // attendance — the strongest rung this hook can observe.
    fireRankOutcome(event.id, 'events', 'join', sessionId);

    Alert.alert("You're in!", 'Your RSVP has been confirmed.');
    await onRefresh();
  }, [event, onRefresh, sessionId]);

  const handleRequestJoin = useCallback(async (message?: string): Promise<boolean> => {
    if (!event) return false;
    setBusy(true);
    const res = await requestToJoinEvent(event.id, message);
    setBusy(false);
    if (!res.ok) { Alert.alert('Error', res.message ?? 'Could not send request'); return false; }
    Alert.alert('Request sent', 'The host will review your request.');
    return true;
  }, [event]);

  const handleJoinChat = useCallback(async (onThreadId: (id: string) => void) => {
    if (!event) return;
    setBusy(true);
    const res = await joinEventChat(event.id);
    setBusy(false);
    if (!res.ok) { Alert.alert('Error', res.message ?? 'Could not join chat'); return; }
    if (res.data?.threadId) onThreadId(res.data.threadId);
  }, [event]);

  return {
    busy,
    handleRsvp,
    handleLeave,
    handleJoinWaitlist,
    handleLeaveWaitlist,
    handleAcceptOffer,
    handleRequestJoin,
    handleJoinChat,
  };
}
