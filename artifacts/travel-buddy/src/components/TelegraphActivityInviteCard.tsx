/**
 * TelegraphActivityInviteCard — rendered for activity_invite messages.
 * Shows the activity title, proposed time, and accept/decline buttons.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CalendarCheck, X, Check } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';

interface Props {
  activityTitle: string;
  activityTime?: string;
  inviteStatus?: 'pending' | 'accepted' | 'declined';
  isMine: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
}

export function TelegraphActivityInviteCard({
  activityTitle, activityTime, inviteStatus = 'pending', isMine, onAccept, onDecline,
}: Props) {
  const resolved = inviteStatus !== 'pending';

  return (
    <View style={[styles.card, isMine && styles.cardMine]}>
      <View style={styles.row}>
        <CalendarCheck size={16} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Activity Invite</Text>
          <Text style={styles.title} numberOfLines={2}>{activityTitle}</Text>
          {activityTime ? (
            <Text style={styles.time}>
              {new Date(activityTime).toLocaleDateString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </Text>
          ) : null}
        </View>
      </View>

      {!isMine && !resolved && (
        <View style={styles.actions}>
          <Pressable style={[styles.btn, styles.declineBtn]} onPress={onDecline}>
            <X size={13} color={color.mute} />
            <Text style={styles.declineTxt}>Decline</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.acceptBtn]} onPress={onAccept}>
            <Check size={13} color={color.onInk} />
            <Text style={styles.acceptTxt}>Accept</Text>
          </Pressable>
        </View>
      )}

      {resolved && (
        <View style={styles.statusRow}>
          <Text style={[
            styles.statusText,
            inviteStatus === 'accepted' ? styles.accepted : styles.declined,
          ]}>
            {inviteStatus === 'accepted' ? '✓ Accepted' : '✗ Declined'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.md,
    maxWidth: '85%',
    alignSelf: 'flex-start',
  },
  cardMine: { alignSelf: 'flex-end' },
  row: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  label: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 10, fontFamily: 'Courier', letterSpacing: 0.5 },
  title: { ...t.bodyStrong, color: color.ink, marginTop: 2 },
  time: { ...t.small, color: color.mute, marginTop: 4 },
  actions: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, paddingVertical: 8, borderRadius: radius.pill },
  declineBtn: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  acceptBtn: { backgroundColor: color.signal },
  declineTxt: { ...t.small, color: color.mute, fontWeight: '700' },
  acceptTxt: { ...t.small, color: color.onInk, fontWeight: '700' },
  statusRow: { alignItems: 'flex-start' },
  statusText: { ...t.small, fontFamily: 'Courier', fontWeight: '700' },
  accepted: { color: '#2E7D5B' },
  declined: { color: color.mute },
});
