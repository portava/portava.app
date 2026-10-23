/**
 * HighlightComposer — a picked VIDEO goes straight to the composer; only a photo opens the filter editor.
 *
 * The owner's iPhone froze on a just-recorded video for a Highlight (2026-10-23). A video is only relabelled after the
 * pick, so the composer opened MediaFilterEditor's full-screen Modal in the same tick the camera and the source sheet
 * were dismissing. PulseCreate has always skipped the editor for video (its video "filter" is metadata only and its
 * preview is an <Image>, which cannot show one); the Highlight composer now does the same.
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

import { HighlightComposer } from '../HighlightComposer.tsx';

const recorded = {
  uri: 'file:///var/mobile/Containers/Data/tmp/camera-recording.mov',
  type: 'video', mimeType: 'video/quicktime', fileName: 'camera-recording.mov',
  fileSize: 8_000_000, width: 1080, height: 1920, duration: 6_000,
};
const photo = {
  uri: 'file:///var/mobile/Containers/Data/tmp/camera-photo.jpg',
  type: 'image', mimeType: 'image/jpeg', fileName: 'camera-photo.jpg',
  fileSize: 900_000, width: 3024, height: 4032, duration: null,
};

describe('HighlightComposer — pick routing', () => {
  beforeEach(() => { mockDeliver = null; });

  it('a recorded video skips the filter editor and is previewed in the composer at once', async () => {
    await render(<HighlightComposer visible onClose={() => {}} />);
    expect(mockDeliver).toBeTruthy();
    await act(async () => { mockDeliver!(recorded); });
    expect(screen.queryByTestId('filter-editor')).toBeNull();
    expect((screen.getByTestId('video-preview') as any).props.uri).toBe(recorded.uri);
  });

  it('a photo still opens the filter editor', async () => {
    await render(<HighlightComposer visible onClose={() => {}} />);
    await act(async () => { mockDeliver!(photo); });
    expect(screen.getByTestId('filter-editor')).toBeTruthy();
    expect(screen.queryByTestId('video-preview')).toBeNull();
  });
});
