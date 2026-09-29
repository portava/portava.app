/**
 * SharedEventLinkPreview — what a shared event link opens (PLAT-F29).
 *
 * A host or co-host shares `/event/<id>?share=<token>` (event screen
 * `handleShare`). When the viewer could not otherwise see the event (a private
 * or invite-only event answers GET /api/events/:id with the private sentinel),
 * the event screen mounts this card above the join request: it reads
 * GET /api/events/share-link/:token/preview, which checks the token's expiry
 * and use limit, refuses a viewer blocked with the host, and returns the
 * event's details.
 *
 * States are true: loading; the preview; a link that is over (expired, used up,
 * or the event is gone) said as such; any other failure with Retry.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CalendarClock, MapPin, Link } from 'lucide-react-native';
import { previewSharedEvent, type EventSummary } from '../../services/events.ts';
import { CachedImage } from '../CachedImage.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  token: string;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; event: EventSummary }
  | { status: 'ended'; message: string }
  | { status: 'error'; message: string };

/** The preview route's 404 answers: the link or its event is over — retrying cannot help. */
const ENDED = /expired|usage limit|not found/i;

function dateLine(iso: string | null): string {
  if (!iso) return 'Date to be announced';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SharedEventLinkPreview({ token }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const res = await previewSharedEvent(token);
    if (res.ok && res.data?.event) { setState({ status: 'ready', event: res.data.event }); return; }
    const message = res.message ?? "We couldn't open this share link.";
    setState(ENDED.test(message)
      ? { status: 'ended', message: 'This share link has expired or is no longer available.' }
      : { status: 'error', message });
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') {
    return <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} testID="shared-event-loading" />;
  }
  if (state.status === 'ended') {
    return (
      <View style={s.note} testID="shared-event-ended">
        <Link size={14} color={color.mute} />
        <Text style={s.noteText}>{state.message}</Text>
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View style={[s.note, { flexDirection: 'column' }]} testID="shared-event-error">
        <Text style={s.noteText}>{state.message}</Text>
        <Pressable style={s.retryBtn} onPress={load} accessibilityRole="button" accessibilityLabel="Retry">
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const ev = state.event;
  const place = [ev.locationName, ev.city].filter(Boolean).join(', ');
  return (
    <View style={s.card} testID="shared-event-preview">
      {ev.coverUrl ? <CachedImage source={{ uri: ev.coverUrl }} style={s.cover} accessibilityLabel={ev.title} /> : null}
      <View style={s.body}>
        <View style={s.badge}><Link size={11} color={color.deep} /><Text style={s.badgeText}>Shared with you</Text></View>
        <Text style={s.title}>{ev.title}</Text>
        <View style={s.meta}><CalendarClock size={13} color={color.mute} /><Text style={s.metaText}>{dateLine(ev.startsAt)}</Text></View>
        {place ? <View style={s.meta}><MapPin size={13} color={color.mute} /><Text style={s.metaText} numberOfLines={1}>{place}</Text></View> : null}
        {ev.hostHandle || ev.hostName ? <Text style={s.host}>{`Hosted by ${ev.hostName ?? `@${ev.hostHandle}`}`}</Text> : null}
        {ev.description ? <Text style={s.desc} numberOfLines={4}>{ev.description}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card:     { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  cover:    { width: '100%', height: 160 },
  body:     { padding: space.md, gap: space.xs },
  badge:    { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: '#EAF2F4', borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  badgeText:{ ...t.small, color: color.deep, fontWeight: '700', fontSize: 11 },
  title:    { ...t.title, color: color.ink, fontSize: 18 },
  meta:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { ...t.small, color: color.mute, flex: 1 },
  host:     { ...t.small, color: color.ink, fontWeight: '600' },
  desc:     { ...t.body, color: color.ink, marginTop: space.xs },
  note:     { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  noteText: { ...t.small, color: color.mute, flex: 1, textAlign: 'center' },
  retryBtn: { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill, marginTop: space.sm },
  retryText:{ ...t.small, color: color.onInk, fontWeight: '700' },
});
