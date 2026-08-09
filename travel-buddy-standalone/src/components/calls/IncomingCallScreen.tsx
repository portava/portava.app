/**
 * calls/IncomingCallScreen — full-screen incoming call UI (spec §12).
 * Voice calls: Decline / Accept. Video calls: Decline / Accept Voice /
 * Accept Video — the camera never turns on without explicit action.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { CallAvatar } from './CallAvatar.tsx';
import { Phone, PhoneOff, Video } from 'lucide-react-native';
import type { IncomingCallInfo } from '../../context/CallContext.tsx';
import { avatar } from '../../theme/tokens.ts';
import { PassportVerificationStamp } from '../PassportVerificationStamp.tsx';

export function IncomingCallScreen({
  info, visible, onAcceptVoice, onAcceptVideo, onDecline,
}: {
  info: IncomingCallInfo | null;
  visible: boolean;
  onAcceptVoice: () => void;
  onAcceptVideo: () => void;
  onDecline: () => void;
}) {
  if (!info) return null;
  const isVideo = info.callType === 'video';
  const displayName = info.caller.name
    ?? (info.caller.handle ? `@${info.caller.handle}` : 'Traveler');

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onDecline}>
      <View style={s.root}>
        <View style={s.top}>
          <CallAvatar uri={info.caller.avatarUrl} name={displayName} size={118} initialsSize={36} />
          <View style={s.nameRow}>
            <Text style={s.name} numberOfLines={1}>{displayName}</Text>
            {info.caller.verified ? <PassportVerificationStamp status="verified" /> : null}
          </View>
          <Text style={s.kind}>
            {isVideo ? 'Incoming video call' : 'Incoming voice call'}
          </Text>
          <Text style={s.context}>
            {info.contextType === 'rent_a_buddy' ? 'Rent a Buddy · Portava' : 'Telegraph · Portava'}
          </Text>
        </View>

        <View style={s.actions}>
          <ActionBtn color="#DC2626" label="Decline" onPress={onDecline}>
            <PhoneOff size={26} color="#fff" />
          </ActionBtn>
          <ActionBtn color="#159447" label={isVideo ? 'Accept as voice' : 'Accept'} onPress={onAcceptVoice}>
            <Phone size={26} color="#fff" />
          </ActionBtn>
          {isVideo ? (
            <ActionBtn color="#2563EB" label="Accept with video" onPress={onAcceptVideo}>
              <Video size={26} color="#fff" />
            </ActionBtn>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function ActionBtn({ color: bg, label, onPress, children }: {
  color: string; label: string; onPress: () => void; children: React.ReactNode;
}) {
  return (
    <View style={s.actionWrap}>
      <Pressable
        style={[s.actionBtn, { backgroundColor: bg }]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {children}
      </Pressable>
      <Text style={s.actionLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1, backgroundColor: '#101828',
    justifyContent: 'space-between', paddingVertical: 90, paddingHorizontal: 24,
  },
  top: { alignItems: 'center', gap: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  name: { fontSize: 26, fontWeight: '800', color: '#fff', maxWidth: 260 },
  kind: { fontSize: 15, color: '#D1D5DB' },
  context: { fontSize: 12.5, color: '#6B7280', letterSpacing: 0.4 },
  actions: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 34,
  },
  actionWrap: { alignItems: 'center', gap: 8, width: 92 },
  actionBtn: {
    width: avatar.s64, height: avatar.s64, borderRadius: avatar.s64 / 2,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, elevation: 6,
  },
  actionLabel: { fontSize: 12.5, color: '#E5E7EB', textAlign: 'center' },
});
