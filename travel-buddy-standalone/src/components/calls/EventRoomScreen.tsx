/**
 * calls/EventRoomScreen — in-room UI for Event Voice Rooms (spec Phase 5).
 *
 * Role-aware: listeners see a Raise-hand control and a mic that stays off
 * (publishing is denied at the token grant server-side); speakers get the
 * normal mute toggle; hosts/co-hosts additionally get a moderation sheet on
 * each participant (promote/demote, mute, remove) plus End room. All
 * moderation is authorized server-side through the canonical engine.
 */
import React from 'react';
import {
  View, Text, Image, StyleSheet, Modal, ActivityIndicator, SectionList,
  Pressable, Alert,
} from 'react-native';
import { Hand, MicOff } from 'lucide-react-native';
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

const SPEAKER_ROLES = new Set(['host', 'cohost', 'speaker']);

export interface EventRoomModeration {
  promote(userId: string): void;
  demote(userId: string): void;
  mute(userId: string): void;
  remove(userId: string): void;
  endRoom(): void;
}

export function EventRoomScreen({
  visible, phase, elapsedSec, participants, activeSpeakerIds,
  myRole, myUserId, handRaised, micMuted, speakerOn,
  onToggleMute, onToggleSpeaker, onToggleHand, onHangUp, onMinimize,
  moderation,
}: {
  visible: boolean;
  phase: CallPhase;
  elapsedSec: number;
  participants: CallParticipantDto[];
  activeSpeakerIds: string[];
  /** My room role: host | cohost | speaker | listener. */
  myRole: string | null;
  myUserId: string | null;
  handRaised: boolean;
  micMuted: boolean;
  speakerOn: boolean;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onToggleHand: () => void;
  onHangUp: () => void;
  onMinimize: () => void;
  /** Present only for hosts/co-hosts — drives the moderation sheet. */
  moderation?: EventRoomModeration;
}) {
  const statusLine =
    phase === 'connecting' ? 'Connecting…'
    : phase === 'reconnecting' ? 'Reconnecting…'
    : phase === 'connected' ? fmtElapsed(elapsedSec)
    : '';
  const speaking = new Set(activeSpeakerIds);
  const isListener = myRole === 'listener';
  const canModerate = !!moderation && (myRole === 'host' || myRole === 'cohost');

  const speakers = participants.filter((p) => SPEAKER_ROLES.has(p.role));
  const listeners = participants.filter((p) => !SPEAKER_ROLES.has(p.role));
  const listenerCount = listeners.length;
  const sections = [
    { title: 'Speakers', data: speakers },
    { title: `Listening · ${listenerCount}`, data: listeners },
  ];

  const openModeration = (p: CallParticipantDto) => {
    if (!canModerate || !moderation || p.userId === myUserId) return;
    const isStaff = p.role === 'host' || p.role === 'cohost';
    const isSpeaker = p.role === 'speaker';
    const buttons: Array<{ text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }> = [];
    if (!isStaff && !isSpeaker) buttons.push({ text: 'Invite to speak', onPress: () => moderation.promote(p.userId) });
    if (isSpeaker) buttons.push({ text: 'Move to listeners', onPress: () => moderation.demote(p.userId) });
    if (!isStaff) buttons.push({ text: 'Mute', onPress: () => moderation.mute(p.userId) });
    if (!isStaff) buttons.push({ text: 'Remove from room', style: 'destructive', onPress: () => moderation.remove(p.userId) });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(participantLabel(p), 'Moderate this participant', buttons);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onMinimize}>
      <View style={s.root}>
        <View style={s.top}>
          <Text style={s.title}>Live Voice Room</Text>
          <Text style={s.count}>{listenerCount} listening</Text>
          <View style={s.statusRow}>
            {(phase === 'connecting' || phase === 'reconnecting') ? (
              <ActivityIndicator size="small" color="#D1D5DB" />
            ) : null}
            <Text style={s.status}>{statusLine}</Text>
          </View>
        </View>

        <SectionList
          sections={sections}
          keyExtractor={(p) => p.userId}
          style={s.list}
          contentContainerStyle={s.listContent}
          renderSectionHeader={({ section }) => (
            <Text style={s.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item }) => {
            const isSpeaking = speaking.has(item.userId);
            const hasHand = !!item.handRaisedAt;
            return (
              <Pressable
                style={s.row}
                onLongPress={() => openModeration(item)}
                accessibilityRole={canModerate ? 'button' : undefined}
                accessibilityLabel={`${participantLabel(item)}${hasHand ? ', hand raised' : ''}${isSpeaking ? ', speaking' : ''}`}
              >
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
                {hasHand ? <Hand size={16} color="#FBBF24" /> : null}
                {isSpeaking ? <Text style={s.speakingTag}>Speaking</Text> : null}
              </Pressable>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>Connecting to the room…</Text>}
        />

        {isListener ? (
          <View style={s.listenerBar}>
            <View style={s.listenerNote}>
              <MicOff size={14} color="#9CA3AF" />
              <Text style={s.listenerNoteText}>You're listening</Text>
            </View>
            <Pressable
              style={[s.handBtn, handRaised && s.handBtnActive]}
              onPress={onToggleHand}
              accessibilityRole="button"
              accessibilityLabel={handRaised ? 'Lower hand' : 'Raise hand'}
            >
              <Hand size={17} color={handRaised ? '#101828' : '#FBBF24'} />
              <Text style={[s.handText, handRaised && s.handTextActive]}>
                {handRaised ? 'Lower hand' : 'Raise hand'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {canModerate ? (
          <Pressable
            style={s.endRoomBtn}
            onPress={() => {
              Alert.alert('End room', 'End this voice room for everyone?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'End room', style: 'destructive', onPress: () => moderation!.endRoom() },
              ]);
            }}
            accessibilityRole="button"
            accessibilityLabel="End room"
          >
            <Text style={s.endRoomText}>End room for everyone</Text>
          </Pressable>
        ) : null}

        <CallControls
          micMuted={micMuted}
          cameraOn={false}
          speakerOn={speakerOn}
          showVideoControls={false}
          muteDisabled={isListener}
          onToggleMute={isListener ? () => {} : onToggleMute}
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
  sectionHeader: {
    fontSize: 12.5, fontWeight: '800', color: '#6B7280',
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatarWrap: { borderRadius: 27, borderWidth: 2, borderColor: 'transparent', padding: 2 },
  avatarSpeaking: { borderColor: '#34D399' },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#1F2937' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 16, fontWeight: '700', color: '#9CA3AF' },
  rowName: { flex: 1, fontSize: 16, fontWeight: '600', color: '#F3F4F6' },
  speakingTag: { fontSize: 12, fontWeight: '700', color: '#34D399' },
  empty: { textAlign: 'center', color: '#6B7280', fontSize: 14, marginTop: 30 },
  listenerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24, marginBottom: 10,
  },
  listenerNote: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  listenerNoteText: { fontSize: 13, color: '#9CA3AF', fontWeight: '600' },
  handBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1.5, borderColor: '#FBBF24', borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 9,
  },
  handBtnActive: { backgroundColor: '#FBBF24' },
  handText: { fontSize: 14.5, fontWeight: '700', color: '#FBBF24' },
  handTextActive: { color: '#101828' },
  endRoomBtn: { alignSelf: 'center', marginBottom: 8, paddingVertical: 8, paddingHorizontal: 16 },
  endRoomText: { fontSize: 14, fontWeight: '700', color: '#F87171' },
});
