/**
 * calls/CallSurface — the ONE root-level presenter for all call UI (spec §12,
 * §13, §16). Mounted once inside <CallProvider> in the root layout, so the
 * incoming/outgoing screens and the minimized pill overlay any screen and
 * survive navigation without a second call instance ever being created.
 */
import React, { useEffect, useRef } from 'react';
import { Alert, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallState, useCallActions } from '../../context/CallContext.tsx';
import { useSession } from '../../context/SessionContext.tsx';
import { IncomingCallScreen } from './IncomingCallScreen.tsx';
import { OutgoingCallScreen } from './OutgoingCallScreen.tsx';
import { ActiveCallPill } from './ActiveCallPill.tsx';
import { ensureCallMediaPermissions } from '../../services/callPermissions.ts';

const IN_CALL_PHASES = new Set(['outgoing_ringing', 'connecting', 'connected', 'reconnecting']);

export function CallSurface() {
  const state = useCallState();
  const actions = useCallActions();
  const { isAuthed } = useSession();
  const insets = useSafeAreaInsets();

  // Restore an in-progress call after app relaunch (once per sign-in).
  const restored = useRef(false);
  useEffect(() => {
    if (!isAuthed || restored.current) return;
    restored.current = true;
    actions.restoreActiveCall().catch(() => {});
  }, [isAuthed, actions]);

  // Surface call outcomes/errors exactly once ("No answer", "Call declined", …).
  const lastError = useRef<string | null>(null);
  useEffect(() => {
    if (!state.error || state.error === lastError.current) {
      if (!state.error) lastError.current = null;
      return;
    }
    lastError.current = state.error;
    Alert.alert('Call', state.error, [{ text: 'OK', onPress: () => actions.dismissError() }]);
  }, [state.error, actions]);

  const inCall = IN_CALL_PHASES.has(state.phase);
  const isVideo = state.session?.callType === 'video';
  const peerName = state.peer?.name ?? 'Traveler';

  async function acceptWith(asVideo: boolean) {
    const inc = state.incoming;
    if (!inc) return;
    const wanted = asVideo && inc.callType === 'video' ? 'video' : 'voice';
    const allowed = await ensureCallMediaPermissions(wanted);
    if (allowed === null) return; // mic denied — keep ringing so they can retry/decline
    await actions.accept(allowed === 'video');
  }

  return (
    <>
      <IncomingCallScreen
        info={state.incoming}
        visible={state.phase === 'incoming_ringing'}
        onAcceptVoice={() => { void acceptWith(false); }}
        onAcceptVideo={() => { void acceptWith(true); }}
        onDecline={() => { void actions.decline(); }}
      />

      <OutgoingCallScreen
        visible={inCall && !state.minimized}
        phase={state.phase}
        isVideo={!!isVideo}
        elapsedSec={state.elapsedSec}
        peerName={peerName}
        peerAvatarUrl={state.peer?.avatarUrl ?? null}
        micMuted={state.micMuted}
        cameraOn={state.cameraOn}
        speakerOn={state.speakerOn}
        onToggleMute={() => { void actions.toggleMute(); }}
        onToggleCamera={() => { void actions.toggleCamera(); }}
        onFlipCamera={() => { void actions.flipCamera(); }}
        onToggleSpeaker={() => { void actions.toggleSpeaker(); }}
        onHangUp={() => { void actions.hangUp(); }}
        onMinimize={() => actions.setMinimized(true)}
      />

      {inCall && state.minimized ? (
        <View style={[s.pillWrap, { top: insets.top }]} pointerEvents="box-none">
          <ActiveCallPill
            label={`Call with ${peerName}`}
            elapsedSec={state.elapsedSec}
            micMuted={state.micMuted}
            reconnecting={state.phase === 'reconnecting'}
            onPress={() => actions.setMinimized(false)}
            onToggleMute={() => { void actions.toggleMute(); }}
            onHangUp={() => { void actions.hangUp(); }}
          />
        </View>
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  pillWrap: { position: 'absolute', left: 0, right: 0, zIndex: 999, elevation: 12 },
});
