/**
 * calls/GroupCallScreen — in-room UI for group voice rooms (Crew Calls).
 * Participant list with avatars, active-speaker indicator, participant
 * count, mute/speaker/leave controls, and minimize (spec Phase 4).
 */
import React from 'react';
import {
  View, Text, Image, StyleSheet, Modal, ActivityIndicator, FlatList,
} from 'react-native';
import type { CallPhase } from '../../context/CallContext.tsx';
import type { CallParticipantDto } from '../../services/calls.ts';
import { CallControls } from './CallControls.tsx';

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function participantLabel(p: CallParticipantDto): string {
  return p.name ?? (p.handle ? `@${p.handle}` : 'Traveler');
}

export function GroupCallScreen({
  visible, phase, elapsedSec, participants, participantCount, activeSpeakerIds,
  micMuted, speakerOn,
  onToggleMute, onToggleSpeaker, onHangUp, onMinimize,
}: {
  visible: boolean;
  phase: CallPhase;
  elapsedSec: number;
  participants: CallParticipantDto[];
  participantCount: number;
  activeSpeakerIds: string[];
  micMuted: boolean;
  speakerOn: boolean;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onHangUp: () => void;
  onMinimize: () => void;
}) {
  const statusLine =
    phase === 'connecting' ? 'Connecting…'
    : phase === 'reconnecting' ? 'Reconnecting…'
    : phase === 'connected' ? fmtElapsed(elapsedSec)
    : '';
  const count = Math.max(participantCount, 1);
  const speaking = new Set(activeSpeakerIds);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onMinimize}>
      <View style={s.root}>
        <View style={s.top}>
          <Text style={s.title}>Crew Call</Text>
          <Text style={s.count}>{count} {count === 1 ? 'person' : 'people'}</Text>
          <View style={s.statusRow}>
            {(phase === 'connecting' || phase === 'reconnecting') ? (
              <ActivityIndicator size="small" color="#D1D5DB" />
            ) : null}
            <Text style={s.status}>{statusLine}</Text>
          </View>
        </View>

        <FlatList
          data={participants}
          keyExtractor={(p) => p.userId}
          style={s.list}
          contentContainerStyle={s.listContent}
          renderItem={({ item }) => {
            const isSpeaking = speaking.has(item.userId);
            return (
              <View style={s.row} accessibilityLabel={`${participantLabel(item)}${isSpeaking ? ', speaking' : ''}`}>
                <View style={[s.avatarWrap, isSpeaking && s.avatarSpeaking]}>
                  {item.avatarUrl ? (
                    <Image source={{ uri: item.avatarUrl }} style={s.avatar} />
                  ) : (
                    <View style={[s.avatar, s.avatarFallback]}>
                      <Text style={s.initials}>{participantLabel(item).replace('@', '').slice(0, 2).toUpperCase()}</Text>
                    </View>
                  )}
                </View>
                <Text style={s.rowName} numberOfLines={1}>{participantLabel(item)}</Text>
                {isSpeaking ? <Text style={s.speakingTag}>Speaking</Text> : null}
              </View>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>Connecting to the room…</Text>}
        />

        <CallControls
          micMuted={micMuted}
          cameraOn={false}
          speakerOn={speakerOn}
          showVideoControls={false}
          onToggleMute={onToggleMute}
          onToggleCamera={() => {}}
          onFlipCamera={() => {}}
          onToggleSpeaker={onToggleSpeaker}
          onHangUp={onHangUp}
          onMinimize={onMinimize}
        />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1, backgroundColor: '#101828',
    justifyContent: 'space-between', paddingTop: 84, paddingBottom: 46,
  },
  top: { alignItems: 'center', gap: 4 },
  title: { fontSize: 24, fontWeight: '800', color: '#fff' },
  count: { fontSize: 14.5, color: '#9CA3AF', fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  status: { fontSize: 15, color: '#D1D5DB', fontVariant: ['tabular-nums'] },
  list: { flex: 1, marginTop: 18 },
  listContent: { paddingHorizontal: 24, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatarWrap: { borderRadius: 27, borderWidth: 2, borderColor: 'transparent', padding: 2 },
  avatarSpeaking: { borderColor: '#34D399' },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#1F2937' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 16, fontWeight: '700', color: '#9CA3AF' },
  rowName: { flex: 1, fontSize: 16, fontWeight: '600', color: '#F3F4F6' },
  speakingTag: { fontSize: 12, fontWeight: '700', color: '#34D399' },
  empty: { textAlign: 'center', color: '#6B7280', fontSize: 14, marginTop: 30 },
});
