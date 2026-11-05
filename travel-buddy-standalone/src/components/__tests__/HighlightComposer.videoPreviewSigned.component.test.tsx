/**
 * HighlightComposer — the video preview follows the one playback rule (2026-10-24, video on every surface).
 *
 * The composer previewed a video by handing its uri straight to <Video> when the rule called it loadable, and by
 * drawing NOTHING otherwise: a private-bucket ref (bare or the API relay URL) never played. The preview now signs
 * through the same hook every other surface uses (services/mediaUrl.ts useHydratedMedia → playbackUriState).
 *
 *   RM-C1  a private ref: no preview <Video> while the signature is in flight, then the signed URL — never the ref
 *   RM-C2  a relay URL: the same
 *   RM-C3  CONTROL: a device file plays as it is, with no signature request
 *
 * The verifier's original RM-C definition was not available to this builder; this is the closest equivalent (the
 * race mutant on the Composer surface).
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// NOTE: intentional stub — requireActual pulls native-module internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: intentionally exhaustive — the composer reads only signOut (on a 401), never pressed here.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ signOut: jest.fn() }),
}));

// NOTE: intentionally exhaustive — nothing is submitted; only the pick is under test.
jest.mock('../../services/highlights.ts', () => ({
  createHighlight: jest.fn(),
}));

// NOTE: intentionally exhaustive — the server-driven lifetime list is not under test.
jest.mock('../../features/highlights/HighlightLifetimePicker.tsx', () => ({
  HighlightLifetimePicker: () => null,
}));

// NOTE: intentional stub — the picker sheet launches native pickers; the test hands the composer a pick directly.
let mockDeliver: ((asset: any) => void) | null = null;
jest.mock('../ui/MediaPickerButton.tsx', () => ({
  MediaPickerButton: ({ composer }: { composer: { onPickResult: (a: any) => void } }) => {
    mockDeliver = composer.onPickResult;
    return null;
  },
}));

// NOTE: intentional stub — the editor is a full-screen Modal; the test only asks whether it opened.
jest.mock('../MediaFilterEditor.tsx', () => ({
  MediaFilterEditor: () => {
    const { View } = require('react-native');
    return <View testID="filter-editor" />;
  },
}));

// NOTE: intentional stub — expo-av's Video is native; the stub keeps the uri it was given.
jest.mock('expo-av', () => ({
  ResizeMode: { COVER: 'cover' },
  Video: ({ source }: { source?: { uri?: string } }) => {
    const { View } = require('react-native');
    return <View testID="video-preview" {...{ uri: source?.uri }} />;
  },
}));

// NOTE: intentional stub — the network call is the only stand-in; useHydratedMedia and hydrateMediaUrls are real.
let mockSignCalls: string[][] = [];
let mockSignAnswer: (urls: string[]) => Promise<Map<string, string>> = async (urls) => new Map(urls.map((u) => [u, u]));
jest.mock('../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../lib/batchSignMedia.ts'),
  batchSignUrls: (urls: string[]) => { mockSignCalls.push([...urls]); return mockSignAnswer(urls); },
}));

import { HighlightComposer } from '../HighlightComposer.tsx';

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const SIGNED = 'https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/object/sign/post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov?token=t';
const asset = (uri: string) => ({ uri, type: 'video', mimeType: 'video/quicktime', fileName: 'clip.mov', fileSize: 8_000_000, width: 1080, height: 1920, duration: 6_000 });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('HighlightComposer — the video preview is signed before it plays', () => {
  beforeEach(() => { mockDeliver = null; mockSignCalls = []; });

  it.each([['RM-C1 bare ref', MOV], ['RM-C2 relay URL', `/api/media/file/${MOV}`]])('%s', async (_n, ref) => {
    let release!: () => void;
    mockSignAnswer = (urls) => new Promise((r) => { release = () => r(new Map(urls.map((u) => [u, SIGNED]))); });
    await render(<HighlightComposer visible onClose={() => {}} />);
    await act(async () => { mockDeliver!(asset(ref)); });
    await flush();
    expect(mockSignCalls).toEqual([[ref]]);
    expect(screen.queryByTestId('video-preview')).toBeNull();
    await act(async () => { release(); });
    await flush();
    expect((screen.getByTestId('video-preview') as any).props.uri).toBe(SIGNED);
  });

  it('RM-C3 CONTROL: a device file plays as it is, with no signature request', async () => {
    await render(<HighlightComposer visible onClose={() => {}} />);
    await act(async () => { mockDeliver!(asset('file:///var/mobile/tmp/clip.mov')); });
    await flush();
    expect(mockSignCalls).toEqual([]);
    expect((screen.getByTestId('video-preview') as any).props.uri).toBe('file:///var/mobile/tmp/clip.mov');
  });
});
