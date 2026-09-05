/**
 * EventPassportShareCard — the OWNER's side of the temporary event Passport
 * (spec §25 "Share Passport options", §31 "Explicitly expire … event Passport,
 * temporary sharing", Phase 8).
 *
 * Mounted on an event screen. Three states, and the card is deliberately
 * self-effacing in two of them:
 *
 *   • capability off, or the traveler is not attending, or the event is over →
 *     the card renders NOTHING. There is no affordance to press and no error
 *     to read; the server said no and that is the whole answer.
 *   • no live share → a single "Share my Passport here" action.
 *   • live share → the QR (which encodes ONLY the opaque deep link), the
 *     remaining time stated in words, and Revoke.
 *
 * The card never decides who may see the share. It shows the owner what they
 * are sharing and how long for; every resolve is re-checked server-side.
 */
import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { QrCode as QrIcon, Clock, Ban } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import { PassportQrCode } from './PassportQrCode.tsx';
import {
  createEventPassportShare,
  revokeEventPassportShare,
  getMyEventPassportShare,
  type EventPassportShare,
} from './eventPassport.ts';
import { eventPassportDeepLink, isShareLive, shareRemainingLabel } from './eventPassportShareUtils.ts';

export interface EventPassportShareCardProps {
  eventId: string;
  /** Test seam: skip the initial read and start from this state. */
  initialShare?: EventPassportShare | null;
  /** Test seam: skip the initial read entirely. */
  initialAvailable?: boolean;
}

export function EventPassportShareCard({
  eventId,
  initialShare,
  initialAvailable,
}: EventPassportShareCardProps) {
  const [available, setAvailable] = React.useState<boolean | null>(
    initialAvailable === undefined ? null : initialAvailable,
  );
  const [share, setShare] = React.useState<EventPassportShare | null>(initialShare ?? null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (initialAvailable !== undefined) return;
    let cancelled = false;
    (async () => {
      const res = await getMyEventPassportShare(eventId);
      if (cancelled) return;
      if (!res.enabled) { setAvailable(false); return; }
      setAvailable(true);
      setShare(res.ok ? res.data : null);
    })();
    return () => { cancelled = true; };
  }, [eventId, initialAvailable]);

  const onShare = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await createEventPassportShare(eventId);
    setBusy(false);
    if (!res.enabled) { setAvailable(false); return; }
    if (!res.ok || !res.data) {
      // A refusal (not attending, event over) hides the affordance rather than
      // inviting a retry that would be refused identically.
      setAvailable(false);
      setError(null);
      return;
    }
    setShare(res.data);
  }, [busy, eventId]);

  const onRevoke = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await revokeEventPassportShare(eventId);
    setBusy(false);
    if (!res.enabled) { setAvailable(false); return; }
    if (!res.ok) { setError('Could not stop sharing. Try again.'); return; }
    setShare(null);
  }, [busy, eventId]);

  // Nothing to offer: capability off, not attending, or the event is done.
  if (available === false) return null;
  if (available === null) return null; // first read still in flight — draw nothing

  // §31: a share the client already knows has lapsed is never shown as current.
  const live = isShareLive(share);
  const remaining = shareRemainingLabel(share);

  return (
    <View style={s.card} testID="event-passport-share-card">
      <View style={s.headerRow}>
        <QrIcon size={icon.s18} color={color.ink} />
        <Text style={s.title}>Event Passport</Text>
      </View>

      {live && share ? (
        <>
          <PassportQrCode value={eventPassportDeepLink(share.token)} size={180} />
          <View style={s.metaRow}>
            <Clock size={12} color={color.mute} />
            <Text style={s.meta}>{remaining}</Text>
          </View>
          <Text style={s.body}>
            Anyone at this event can scan this to see your name, photo and what you are up for.
            It stops working when the event ends.
          </Text>
          <Pressable
            style={s.secondaryBtn}
            onPress={onRevoke}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Stop sharing my event Passport"
          >
            {busy ? <ActivityIndicator color={color.ink} /> : <Ban size={icon.s16} color={color.ink} />}
            <Text style={s.secondaryText}>Stop sharing</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={s.body}>
            Share a temporary Passport with people at this event. It expires when the event
            ends, and you can stop sharing at any time.
          </Text>
          <Pressable
            style={s.primaryBtn}
            onPress={onShare}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Share my Passport at this event"
          >
            {busy ? <ActivityIndicator color={color.onInk} /> : <QrIcon size={icon.s16} color={color.onInk} />}
            <Text style={s.primaryText}>Share my Passport here</Text>
          </Pressable>
        </>
      )}

      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    alignItems: 'center',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start' },
  title: { ...t.heading, color: color.ink },
  body: { ...t.small, color: color.mute, textAlign: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  meta: { ...t.small, color: color.mute },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.ink,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
  },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  secondaryText: { ...t.body, color: color.ink },
  error: { ...t.small, color: color.signal, textAlign: 'center' },
});
