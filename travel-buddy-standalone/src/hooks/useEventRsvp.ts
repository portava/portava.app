/**
 * useEventRsvp — manages the full RSVP / join / waitlist / leave state machine
 * for a single event, decoupled from any particular screen.
 */
import { useState, useCallback } from 'react';
import { Alert } from 'react-native';
import {
  rsvpEvent, leaveEvent, joinWaitlist, leaveWaitlist,
  acceptWaitlistOffer, requestToJoinEvent, joinEventChat,
  type EventDetail, type EventRsvpStatus,
} from '../services/events';

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

export function useEventRsvp(
  event: EventDetail | null,
  onRefresh: () => Promise<void>,
  onEventChange?: (updater: (e: EventDetail) => EventDetail) => void,
): UseEventRsvpReturn {
  const [busy, setBusy] = useState(false);

  const handleRsvp = useCallback(async (status: EventRsvpStatus) => {
    if (!event) return;
    setBusy(true);
    const res = await rsvpEvent(event.id, status);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('RSVP failed', res.message ?? 'Could not update RSVP');
      return;
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
  }, [event, onRefresh, onEventChange]);

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
    Alert.alert("You're in!", 'Your RSVP has been confirmed.');
    await onRefresh();
  }, [event, onRefresh]);

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
