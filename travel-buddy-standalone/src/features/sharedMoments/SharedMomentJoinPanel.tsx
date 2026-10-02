/**
 * SharedMomentJoinPanel — what a NON-member sees on a Shared Moment (HM-F17).
 *
 * Driven entirely by `GET /shared-moments/:id/preview`, which answers only an
 * invitee, a requester, a member, the holder of an offered suggestion, or —
 * for an active approval-required Moment — anyone not blocked. Its `myStatus`
 * decides the one action offered:
 *
 *   invited            → Accept / Decline   (POST /:id/respond)
 *   requested          → "waiting for the organiser"
 *   approval_required  → Ask to join        (POST /:id/request)
 *   otherwise          → invitation only; nothing to press.
 *
 * Nobody is joined or added by opening this screen: every change is a press.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t, typography } from '../../theme/tokens.ts';
import {
  requestToJoinSharedMoment, respondToSharedMomentInvite, type SharedMomentPreview,
} from '../../services/sharedMoments.ts';

export function SharedMomentJoinPanel({ preview, onJoined }: { preview: SharedMomentPreview; onJoined: () => void }) {
  const [status, setStatus] = useState<string | null>(preview.myStatus);
  const [busy, setBusy] = useState<'accept' | 'decline' | 'request' | null>(null);
  const { moment } = preview;
  const open = moment.status === 'active';

  const respond = async (response: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(response);
    const ok = await respondToSharedMomentInvite(moment.id, response);
    setBusy(null);
    if (!ok) { Alert.alert(response === 'accept' ? 'Couldn’t join this Moment' : 'Couldn’t decline', 'The invitation may have changed. Please try again.'); return; }
    if (response === 'accept') onJoined(); else setStatus('declined');
  };

  const request = async () => {
    if (busy) return;
    setBusy('request');
    const ok = await requestToJoinSharedMoment(moment.id);
    setBusy(null);
    if (!ok) { Alert.alert('Couldn’t send your request', 'Please try again.'); return; }
    setStatus('requested');
  };

  return (
    <View style={s.wrap} testID="moment-join-panel">
      <Text style={s.heading}>{moment.title}</Text>
      {moment.description ? <Text style={s.body}>{moment.description}</Text> : null}
      {!open ? (
        <Text style={s.body}>This Moment has been archived.</Text>
      ) : status === 'invited' ? (
        <View style={s.card}>
          <Text style={s.title}>You were invited to this Moment</Text>
          <Text style={s.body}>Joining lets you see what members shared and add your own. Nothing of yours is added unless you choose it.</Text>
          <View style={s.row}>
            <Pressable testID="moment-invite-accept" onPress={() => respond('accept')} disabled={busy !== null} style={[s.primary, busy !== null && s.dim]} accessibilityRole="button">
              {busy === 'accept' ? <ActivityIndicator color={color.paper} /> : <Text style={s.primaryText}>Accept</Text>}
            </Pressable>
            <Pressable testID="moment-invite-decline" onPress={() => respond('decline')} disabled={busy !== null} style={[s.secondary, busy !== null && s.dim]} accessibilityRole="button">
              {busy === 'decline' ? <ActivityIndicator color={color.ink} /> : <Text style={s.secondaryText}>Decline</Text>}
            </Pressable>
          </View>
        </View>
      ) : status === 'declined' ? (
        <Text style={s.body}>You declined this invitation.</Text>
      ) : status === 'requested' ? (
        <Text style={s.body}>Your request is waiting for the organiser.</Text>
      ) : moment.joinPolicy === 'approval_required' ? (
        <View style={s.card}>
          <Text style={s.body}>The organiser approves who joins.</Text>
          <Pressable testID="moment-request-join" onPress={request} disabled={busy !== null} style={[s.primary, busy !== null && s.dim]} accessibilityRole="button">
            {busy === 'request' ? <ActivityIndicator color={color.paper} /> : <Text style={s.primaryText}>Ask to join</Text>}
          </Pressable>
        </View>
      ) : (
        <Text style={s.body}>This Moment accepts invitations only.</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  heading: { ...t.heading, color: color.ink },
  title: { ...t.bodyStrong, color: color.ink },
  body: { ...typography.body, color: color.mute },
  card: { backgroundColor: color.paperRaised, borderColor: color.haze, borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm },
  primary: { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  primaryText: { ...t.bodyStrong, color: color.paper },
  secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  secondaryText: { ...t.bodyStrong, color: color.ink },
  dim: { opacity: 0.5 },
});
