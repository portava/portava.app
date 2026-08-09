import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity.ts';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';

interface Props {
  senderId: string;
  senderHandle: string | null | undefined;
  senderName: string | null | undefined;
  senderAvatar?: string | null;
  previewText: string;
  onAccept: () => void;
  onDecline: () => void;
  loading?: boolean;
}

export function MessageRequestCard({
  senderId,
  senderHandle,
  senderName,
  senderAvatar,
  previewText,
  onAccept,
  onDecline,
  loading,
}: Props) {
  const { blockedIds } = useBlockedIds();
  if (blockedIds.has(senderId)) return null;

  const name = primaryIdentityText({ name: senderName, handle: senderHandle });
  const handleSubline = secondaryIdentityText({ name: senderName, handle: senderHandle });

  return (
    <View style={s.card}>
      <View style={s.row}>
        <AvatarImage
          uri={senderAvatar}
          user={{ displayName: senderName, handle: senderHandle }}
          size={44}
          style={s.avatar}
        />
        <View style={s.body}>
          <Text style={s.name} numberOfLines={1}>{name}</Text>
          {handleSubline ? <Text style={s.handle}>{handleSubline}</Text> : null}
          <Text style={s.preview} numberOfLines={2}>{previewText}</Text>
        </View>
      </View>
      <View style={s.actions}>
        <Pressable style={[s.btn, s.accept, loading && s.btnDisabled]} onPress={onAccept} disabled={loading}>
          <Text style={s.acceptText}>Accept</Text>
        </Pressable>
        <Pressable style={[s.btn, s.decline, loading && s.btnDisabled]} onPress={onDecline} disabled={loading}>
          <Text style={s.declineText}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  row: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  avatar: { width: avatar.lgXl, height: avatar.lgXl, borderRadius: avatar.lgXl / 2, backgroundColor: color.haze },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  name: { ...t.bodyStrong, fontSize: 14, color: color.ink },
  handle: { fontSize: 12, color: color.mute, fontFamily: 'Courier' },
  preview: { fontSize: 13, color: color.faint, lineHeight: 18, marginTop: 2 },
  actions: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1, alignItems: 'center', padding: space.sm, borderRadius: radius.md },
  btnDisabled: { opacity: 0.5 },
  accept: { backgroundColor: color.signal },
  decline: { backgroundColor: color.haze },
  acceptText: { ...t.bodyStrong, color: color.onInk, fontSize: 13 },
  declineText: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
});
