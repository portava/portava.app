import React, { useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Alert } from 'react-native';
import { MessageCircle, User, MoreHorizontal } from 'lucide-react-native';
import { router } from 'expo-router';
import type { CircleMember } from '../../services/circle';
import { color, radius, type as t } from '../../theme/tokens';

const STATUS_CONFIG: Record<string, { label: string; bg: string; textColor: string }> = {
  active:     { label: 'Active',      bg: '#E8F5E9', textColor: '#2E7D32' },
  arrived:    { label: 'Arrived',     bg: '#E3F2FD', textColor: '#1565C0' },
  with_group: { label: 'With group',  bg: '#E0F2F1', textColor: '#00695C' },
  leaving:    { label: 'Leaving',     bg: '#FFF3E0', textColor: '#E65100' },
  safe:       { label: 'Safe',        bg: '#E8F5E9', textColor: '#2E7D32' },
};

interface Props {
  member: CircleMember;
  isViewerRow?: boolean;
}

export function CircleMemberRow({ member, isViewerRow = false }: Props) {
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  const statusCfg = STATUS_CONFIG[member.status] ?? null;
  const locationLabel = member.venueLabel ?? member.approximateLabel ?? null;

  function handleProfile() {
    if (!member.canViewProfile && !isViewerRow) return;
    router.push(`/u/${encodeURIComponent(member.username)}` as any);
  }

  function handleMessage() {
    router.push(`/messages/dm?userId=${encodeURIComponent(member.userId)}` as any);
  }

  function handleOverflow() {
    Alert.alert(member.displayName || member.username, undefined, [
      { text: 'View profile', onPress: handleProfile },
      { text: 'Hide from my Circle', onPress: () => setHidden(true) },
      {
        text: 'Report',
        onPress: () =>
          router.push({
            pathname: '/report',
            params: { targetUserId: member.userId, targetType: 'user' },
          } as any),
      },
      { text: 'Block', style: 'destructive', onPress: () => Alert.alert('Block', 'Block feature available from their profile.') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  return (
    <View style={[s.row, isViewerRow && s.viewerRow]}>
      <Pressable onPress={handleProfile}>
        <View style={s.avatarWrap}>
          {member.avatarUrl ? (
            <Image source={{ uri: member.avatarUrl }} style={s.avatar} />
          ) : (
            <View style={s.avatarFallback}>
              <User size={18} color={color.mute} />
            </View>
          )}
          {member.isStale && <View style={s.staleDot} />}
        </View>
      </Pressable>

      <View style={s.info}>
        <View style={s.nameRow}>
          <Text style={s.displayName} numberOfLines={1}>
            {member.displayName || member.username}
          </Text>
          {isViewerRow && <Text style={s.youBadge}> (you)</Text>}
          {statusCfg ? (
            <View style={[s.chip, { backgroundColor: statusCfg.bg }]}>
              <Text style={[s.chipText, { color: statusCfg.textColor }]}>{statusCfg.label}</Text>
            </View>
          ) : member.presenceAbsent ? (
            <View style={[s.chip, { backgroundColor: color.haze }]}>
              <Text style={[s.chipText, { color: color.mute }]}>Not sharing</Text>
            </View>
          ) : null}
        </View>

        {locationLabel ? (
          <Text style={s.locationLabel} numberOfLines={1}>{locationLabel}</Text>
        ) : null}

        <Text style={[s.freshness, member.isStale && s.freshStale]}>
          {member.isStale ? '⚠ ' : ''}{member.freshnessLabel}
        </Text>
      </View>

      {!isViewerRow && (
        <View style={s.actions}>
          {member.canMessage && (
            <Pressable style={s.actionBtn} onPress={handleMessage} hitSlop={8}>
              <MessageCircle size={18} color={color.signal} />
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
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  staleDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
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
  locationLabel: { ...t.small, color: color.mute },
  freshness: { ...t.small, color: color.faint },
  freshStale: { color: '#FF8F00' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionBtn: { padding: 6 },
});
