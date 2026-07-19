/**
 * livekitBridge — the real LiveKitBridge implementation over
 * @livekit/react-native.
 *
 * CallContext owns all call state; this module only translates the bridge
 * port's verbs into LiveKit SDK calls. The native WebRTC module is absent in
 * Expo Go and on web, so everything is loaded lazily with require() inside
 * try/catch (dynamic `await import()` breaks under jest-expo) and
 * createLiveKitBridge() returns null when the SDK is unavailable — CallContext
 * then fails gracefully with its "not available in this build" message.
 */
import { Platform } from 'react-native';
import type { LiveKitBridge } from '../context/CallContext.tsx';

type LiveKitModule = typeof import('@livekit/react-native');

let _mod: LiveKitModule | null | undefined;

function loadSdk(): LiveKitModule | null {
  if (_mod !== undefined) return _mod;
  if (Platform.OS === 'web') { _mod = null; return _mod; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@livekit/react-native') as LiveKitModule;
    // registerGlobals wires the WebRTC primitives; throws in Expo Go where the
    // native module is missing.
    mod.registerGlobals();
    _mod = mod;
  } catch {
    _mod = null;
  }
  return _mod;
}

/** Null when the native LiveKit SDK is unavailable (Expo Go / web). */
export function createLiveKitBridge(): LiveKitBridge | null {
  const sdk = loadSdk();
  if (!sdk) return null;

  // livekit-client is a transitive dependency of @livekit/react-native.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Room, RoomEvent, ConnectionState } = require('livekit-client');

  let room: any = null;
  let connListeners: Array<(s: 'connected' | 'reconnecting' | 'disconnected') => void> = [];

  const emit = (s: 'connected' | 'reconnecting' | 'disconnected') => {
    for (const cb of connListeners) cb(s);
  };

  return {
    async connect({ url, token, videoEnabled }) {
      if (room) { try { await room.disconnect(); } catch { /* already down */ } }
      room = new Room();
      room.on(RoomEvent.ConnectionStateChanged, (state: any) => {
        if (state === ConnectionState.Connected) emit('connected');
        else if (state === ConnectionState.Reconnecting) emit('reconnecting');
        else if (state === ConnectionState.Disconnected) emit('disconnected');
      });
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (videoEnabled) await room.localParticipant.setCameraEnabled(true);
      // Calls default to the earpiece-style audio session managed by the SDK;
      // speakerphone is a user toggle below.
      try { await sdk.AudioSession.startAudioSession(); } catch { /* non-critical */ }
    },

    async disconnect() {
      const r = room;
      room = null;
      connListeners = [];
      if (r) { try { await r.disconnect(); } catch { /* already down */ } }
      try { await sdk.AudioSession.stopAudioSession(); } catch { /* non-critical */ }
    },

    async setMicEnabled(on) {
      await room?.localParticipant?.setMicrophoneEnabled(on);
    },

    async setCameraEnabled(on) {
      await room?.localParticipant?.setCameraEnabled(on);
    },

    async flipCamera() {
      const pub = room?.localParticipant?.getTrackPublication?.('camera')
        ?? [...(room?.localParticipant?.videoTrackPublications?.values?.() ?? [])][0];
      const track: any = pub?.track;
      if (!track) return;
      const current = track.mediaStreamTrack?.getSettings?.().facingMode;
      await track.restartTrack?.({ facingMode: current === 'environment' ? 'user' : 'environment' });
    },

    async setSpeakerphone(on) {
      try {
        await sdk.AudioSession.configureAudio({
          android: { audioTypeOptions: on ? sdk.AndroidAudioTypePresets.media : sdk.AndroidAudioTypePresets.communication },
          ios: { defaultOutput: on ? 'speaker' : 'earpiece' },
        });
      } catch { /* non-critical */ }
    },

    onConnectionState(cb) {
      connListeners.push(cb);
      return () => { connListeners = connListeners.filter((x) => x !== cb); };
    },
  };
}
