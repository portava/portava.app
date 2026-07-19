/**
 * calls/OutgoingCallScreen — outgoing/in-call screen for direct calls
 * (spec §13, §15). Phase-driven copy: Calling… / Connecting… /
 * Reconnecting… / timer while connected. Never leaves the user stuck —
 * ring timeout and connect failures are handled by CallContext.
 */
import React from 'react';
import { View, Text, Image, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import type { CallPhase } from '../../context/CallContext.tsx';
import { CallControls } from './CallControls.tsx';

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function OutgoingCallScreen({
  visible, phase, isVideo, elapsedSec,
  peerName, peerAvatarUrl,
  micMuted, cameraOn, speakerOn,
  onToggleMute, onToggleCamera, onFlipCamera, onToggleSpeaker, onHangUp, onMinimize,
}: {
  visible: boolean;
  phase: CallPhase;
  isVideo: boolean;
  elapsedSec: number;
  peerName: string;
  peerAvatarUrl: string | null;
  micMuted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onFlipCamera: () => void;
  onToggleSpeaker: () => void;
  onHangUp: () => void;
  onMinimize: () => void;
}) {
  const statusLine =
    phase === 'outgoing_ringing' ? 'Calling…'
    : phase === 'connecting' ? 'Connecting…'
    : phase === 'reconnecting' ? 'Reconnecting…'
    : phase === 'connected' ? fmtElapsed(elapsedSec)
    : '';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onMinimize}>
      <View style={s.root}>
        {/* Video surface placeholder — the LiveKit bridge renders remote/local
            tracks into this layer during Phase 2 integration. */}
        <View style={s.mediaLayer} />

        <View style={s.top}>
          {peerAvatarUrl ? (
            <Image source={{ uri: peerAvatarUrl }} style={s.avatar} />
          ) : (
            <View style={[s.avatar, s.avatarFallback]}>
              <Text style={s.initials}>{peerName.slice(0, 2).toUpperCase()}</Text>
            </View>
          )}
          <Text style={s.name} numberOfLines={1}>{peerName}</Text>
          <View style={s.statusRow}>
            {(phase === 'connecting' || phase === 'reconnecting') ? (
              <ActivityIndicator size="small" color="#D1D5DB" />
            ) : null}
            <Text style={s.status}>{statusLine}</Text>
          </View>
        </View>

        <CallControls
          micMuted={micMuted}
          cameraOn={cameraOn}
          speakerOn={speakerOn}
          showVideoControls={isVideo}
          onToggleMute={onToggleMute}
          onToggleCamera={onToggleCamera}
          onFlipCamera={onFlipCamera}
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
    justifyContent: 'space-between', paddingTop: 110, paddingBottom: 46,
  },
  mediaLayer: { ...StyleSheet.absoluteFillObject },
  top: { alignItems: 'center', gap: 10 },
  avatar: { width: 110, height: 110, borderRadius: 55, backgroundColor: '#1F2937' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 34, fontWeight: '700', color: '#9CA3AF' },
  name: { fontSize: 24, fontWeight: '800', color: '#fff', maxWidth: 280, marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  status: { fontSize: 15, color: '#D1D5DB', fontVariant: ['tabular-nums'] },
});
