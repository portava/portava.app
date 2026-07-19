/**
 * livekitBridge — onActiveSpeakers maps LiveKit ActiveSpeakersChanged
 * participants to user ids (identity === userId per server token minting).
 */

const roomHandlers: Record<string, (arg: any) => void> = {};

// NOTE: no jest.requireActual spread — @livekit/react-native needs the native
// WebRTC module, which is absent under jest-expo; requiring the actual module
// would throw. The bridge only touches registerGlobals + AudioSession, mocked
// fully here.
jest.mock('@livekit/react-native', () => ({
  registerGlobals: jest.fn(),
  AudioSession: {
    startAudioSession: jest.fn(async () => {}),
    stopAudioSession: jest.fn(async () => {}),
    configureAudio: jest.fn(async () => {}),
  },
  AndroidAudioTypePresets: { media: {}, communication: {} },
}));

// NOTE: no jest.requireActual spread — livekit-client is a transitive native
// dep resolved only at runtime (mocked as virtual); the real module depends on
// browser/WebRTC globals unavailable in jest. The bridge uses only Room,
// RoomEvent, and ConnectionState, all provided below.
jest.mock('livekit-client', () => ({
  Room: class {
    localParticipant = {
      setMicrophoneEnabled: jest.fn(async () => {}),
      setCameraEnabled: jest.fn(async () => {}),
    };
    on(event: string, cb: (arg: any) => void) { roomHandlers[event] = cb; }
    async connect() {}
    async disconnect() {}
  },
  RoomEvent: {
    ConnectionStateChanged: 'connectionStateChanged',
    ActiveSpeakersChanged: 'activeSpeakersChanged',
  },
  ConnectionState: { Connected: 'connected', Reconnecting: 'reconnecting', Disconnected: 'disconnected' },
}), { virtual: true });

import { createLiveKitBridge } from '../livekitBridge.ts';

describe('livekitBridge onActiveSpeakers', () => {
  it('emits speaker identities as user ids and clears when speakers stop', async () => {
    const bridge = createLiveKitBridge();
    expect(bridge).not.toBeNull();
    const seen: string[][] = [];
    const unbind = bridge!.onActiveSpeakers!((ids) => seen.push(ids));

    await bridge!.connect({ url: 'wss://x', token: 't', videoEnabled: false });
    const fire = roomHandlers['activeSpeakersChanged'];
    expect(typeof fire).toBe('function');

    fire([{ identity: 'user-a' }, { identity: 'user-b' }]);
    expect(seen[seen.length - 1]).toEqual(['user-a', 'user-b']);

    // Non-string / empty identities are dropped, not passed through.
    fire([{ identity: '' }, { identity: null }, { identity: 'user-c' }]);
    expect(seen[seen.length - 1]).toEqual(['user-c']);

    // Everyone stopped speaking → empty list clears the indicator.
    fire([]);
    expect(seen[seen.length - 1]).toEqual([]);

    // Unbound listeners no longer receive events.
    unbind();
    const count = seen.length;
    fire([{ identity: 'user-d' }]);
    expect(seen.length).toBe(count);
  });

  it('drops speaker listeners on disconnect', async () => {
    const bridge = createLiveKitBridge();
    const seen: string[][] = [];
    bridge!.onActiveSpeakers!((ids) => seen.push(ids));
    await bridge!.connect({ url: 'wss://x', token: 't', videoEnabled: false });
    const fire = roomHandlers['activeSpeakersChanged'];
    await bridge!.disconnect();
    fire([{ identity: 'user-a' }]);
    expect(seen).toEqual([]);
  });
});
