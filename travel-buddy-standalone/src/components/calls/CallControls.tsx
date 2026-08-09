/**
 * calls/CallControls — shared in-call control row (spec §15, §29).
 * Pure presentation; state and handlers come from CallContext via props.
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import {
  Mic, MicOff, Video, VideoOff, SwitchCamera, Volume2, Phone, Minimize2,
} from 'lucide-react-native';
import { color, avatar } from '../../theme/tokens.ts';

export function CallControls({
  micMuted, cameraOn, speakerOn, showVideoControls, muteDisabled,
  onToggleMute, onToggleCamera, onFlipCamera, onToggleSpeaker, onHangUp, onMinimize,
}: {
  micMuted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
  /** Video controls hidden on voice-only calls. */
  showVideoControls: boolean;
  /** Event-room listeners: mic control disabled (publishing denied server-side). */
  muteDisabled?: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onFlipCamera: () => void;
  onToggleSpeaker: () => void;
  onHangUp: () => void;
  onMinimize?: () => void;
}) {
  return (
    <View style={s.row}>
      <Ctl
        label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
        active={micMuted}
        disabled={muteDisabled}
        onPress={onToggleMute}
      >
        {micMuted ? <MicOff size={22} color="#fff" /> : <Mic size={22} color="#fff" />}
      </Ctl>

      {showVideoControls ? (
        <Ctl
          label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          active={!cameraOn}
          onPress={onToggleCamera}
        >
          {cameraOn ? <Video size={22} color="#fff" /> : <VideoOff size={22} color="#fff" />}
        </Ctl>
      ) : null}

      {showVideoControls && cameraOn ? (
        <Ctl label="Flip camera" onPress={onFlipCamera}>
          <SwitchCamera size={22} color="#fff" />
        </Ctl>
      ) : null}

      <Ctl
        label={speakerOn ? 'Speaker off' : 'Speaker on'}
        active={speakerOn}
        onPress={onToggleSpeaker}
      >
        <Volume2 size={22} color="#fff" />
      </Ctl>

      {onMinimize ? (
        <Ctl label="Minimize call" onPress={onMinimize}>
          <Minimize2 size={22} color="#fff" />
        </Ctl>
      ) : null}

      <Pressable
        style={s.endBtn}
        onPress={onHangUp}
        accessibilityRole="button"
        accessibilityLabel="End call"
      >
        <Phone size={24} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
      </Pressable>
    </View>
  );
}

function Ctl({ label, active, disabled, onPress, children }: {
  label: string; active?: boolean; disabled?: boolean; onPress: () => void; children: React.ReactNode;
}) {
  return (
    <Pressable
      style={[s.ctl, active && s.ctlActive, disabled && s.ctlDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      hitSlop={6}
    >
      {children}
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 14, paddingVertical: 18,
  },
  ctl: {
    width: avatar.s52, height: avatar.s52, borderRadius: avatar.s52 / 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
  },
  ctlActive: { backgroundColor: 'rgba(255,255,255,0.38)' },
  ctlDisabled: { opacity: 0.4 },
  endBtn: {
    width: avatar.s64, height: avatar.s64, borderRadius: avatar.s64 / 2,
    backgroundColor: '#DC2626',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, elevation: 5,
  },
});
