import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Avatar } from '../ui/Avatar.tsx';
import { MessageCircle, MoreHorizontal } from 'lucide-react-native';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import { router } from 'expo-router';
import type { CircleMember } from '../../services/circle.ts';
import { blockUser } from '../../services/blocks.ts';
import { reportContent } from '../../services/reports.ts';
import { openDirectThread } from '../../services/messaging.ts';
import { color, radius, type as t, dot } from '../../theme/tokens.ts';
import { errorCopy } from '../../lib/errorCopy.ts';

const STATUS_CONFIG: Record<string, { label: string; bg: string; textColor: string }> = {
  active:     { label: 'Available',   bg: '#E8F5E9', textColor: '#2E7D32' },
  arrived:    { label: 'Checked in',  bg: '#E3F2FD', textColor: '#1565C0' },
  with_group: { label: 'With group',  bg: '#E0F2F1', textColor: '#00695C' },
  leaving:    { label: 'Leaving',     bg: '#FFF3E0', textColor: '#E65100' },
  safe:       { label: 'Safe',        bg: '#E8F5E9', textColor: '#2E7D32' },
  paused:     { label: 'Paused',      bg: '#F5F5F5', textColor: '#9E9E9E' },
  offline:    { label: 'Offline',     bg: '#F5F5F5', textColor: '#9E9E9E' },
  unknown:    { label: 'Not sharing', bg: '#F5F5F5', textColor: '#9E9E9E' },
};

const STALE_CHIP = { label: 'Stale', bg: '#FFF8E1', textColor: '#FF8F00' };

interface Props {
  member: CircleMember;
  isViewerRow?: boolean;
}

export function CircleMemberRow({ member, isViewerRow = false }: Props) {
  const [hidden, setHidden] = useState(false);
  const [messaging, setMessaging] = useState(false);

  if (hidden) return null;

  // Stale overrides the status chip with an amber "Stale" indicator
  const statusCfg = member.isStale
    ? STALE_CHIP
    : member.presenceAbsent
    ? STATUS_CONFIG['unknown']
    : STATUS_CONFIG[member.status] ?? null;

  // Visibility-aware location label
  let locationLabel: string | null = null;
  if (member.venueLabel) {
    locationLabel = `At ${member.venueLabel}`;
  } else if (member.approximateLabel) {
    locationLabel = member.approximateLabel;
  }

  function handleProfile() {
    if (!member.canViewProfile && !isViewerRow) return;
    router.push(`/u/${encodeURIComponent(member.username)}` as any);
  }

  async function handleMessage() {
    if (messaging) return;
    setMessaging(true);
    try {
      const res = await openDirectThread(member.userId);
      if (res.ok && res.data) {
        const params = new URLSearchParams({
          threadType: 'direct',
          title: member.displayName || member.username,
          otherUserId: member.userId,
        });
        router.push(`/messages/${res.data.threadId}?${params.toString()}` as any);
      } else {
        Alert.alert('Cannot open chat', res.message ?? 'Something went wrong. Please try again.');
      }
    } catch {
      Alert.alert('Cannot open chat', 'Network error. Please try again.');
    } finally {
      setMessaging(false);
    }
  }

  function handleBlock() {
    Alert.alert(
      `Block ${member.displayName || member.username}?`,
      'They won\'t be able to message you or see your content.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            await blockUser(member.userId);
            setHidden(true);
          },
        },
      ],
    );
  }

  async function submitUserReport(reason: 'harassment' | 'spam' | 'other') {
    const res = await reportContent({
      target_type: 'user',
      target_id: member.userId,
      reason_code: reason,
    });
    if (res.ok) {
      Alert.alert('Report sent', 'Thanks — our safety team will review it.');
    } else {
      Alert.alert('Could not send report', errorCopy(res.error, 'Please try again.'));
    }
  }

  function handleOverflow() {
    Alert.alert(member.displayName || member.username, undefined, [
      { text: 'View profile', onPress: handleProfile },
      { text: 'Hide from my Circle', onPress: () => setHidden(true) },
      {
        text: 'Report',
        onPress: () => {
          // Inline reason picker → real moderation report (no /report route exists).
          Alert.alert('Report this traveler', 'Why are you reporting them?', [
            { text: 'Harassment', onPress: () => submitUserReport('harassment') },
            { text: 'Spam', onPress: () => submitUserReport('spam') },
            { text: 'Something else', onPress: () => submitUserReport('other') },
            { text: 'Cancel', style: 'cancel' },
          ]);
        },
      },
      { text: 'Block', style: 'destructive', onPress: handleBlock },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  return (
    <View style={[s.row, isViewerRow && s.viewerRow]}>
      <Pressable onPress={handleProfile}>
        <View style={s.avatarWrap}>
          <Avatar uri={member.avatarUrl} name={member.displayName || member.username} size={44} />
          {member.isStale && <View style={s.staleDot} />}
        </View>
      </Pressable>

      <View style={s.info}>
        <View style={s.nameRow}>
          <Text style={s.displayName} numberOfLines={1}>
            {member.displayName || member.username}
          </Text>
          {member.verified ? <VerifiedStamp size="sm" /> : null}
          {isViewerRow && <Text style={s.youBadge}> (you)</Text>}
          {statusCfg && (
            <View style={[s.chip, { backgroundColor: statusCfg.bg }]}>
              <Text style={[s.chipText, { color: statusCfg.textColor }]}>{statusCfg.label}</Text>
            </View>
          )}
        </View>

        {member.username ? (
          <Text style={s.username} numberOfLines={1}>@{member.username}</Text>
        ) : null}

        {locationLabel ? (
          <Text style={s.locationLabel} numberOfLines={1}>{locationLabel}</Text>
        ) : null}

        {!member.presenceAbsent && (
          <Text style={[s.freshness, member.isStale && s.freshStale]}>
            {member.isStale ? '⚠ ' : ''}{member.freshnessLabel}
          </Text>
        )}
      </View>

      {!isViewerRow && (
        <View style={s.actions}>
          {member.canMessage && (
            <Pressable style={s.actionBtn} onPress={handleMessage} disabled={messaging} hitSlop={8}>
              {messaging
                ? <ActivityIndicator size="small" color={color.signal} />
                : <MessageCircle size={18} color={color.signal} />}
            </Pressable>
          )}
          <Pressable style={s.actionBtn} onPress={handleOverflow} hitSlop={8}>
            <MoreHorizontal size={18} color={color.mute} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
  },
  viewerRow: {
    backgroundColor: '#F8F9FF',
    borderRadius: radius.md,
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#E8EAFF',
  },
  avatarWrap: { position: 'relative' },
  staleDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    backgroundColor: '#FF8F00',
    borderWidth: 2,
    borderColor: '#fff',
  },
  info: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  displayName: { ...t.body, fontWeight: '600', color: color.ink, flexShrink: 1 },
  youBadge: { ...t.small, color: color.mute },
  chip: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20 },
  chipText: { fontSize: 11, fontWeight: '600' },
  username: { ...t.small, color: color.faint },
  locationLabel: { ...t.small, color: color.mute },
  freshness: { ...t.small, color: color.faint },
  freshStale: { color: '#FF8F00' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionBtn: { padding: 6 },
});
