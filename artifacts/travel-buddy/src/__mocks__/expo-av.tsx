/**
 * Stub for expo-av.
 *
 * expo-av requires the native ExponentAV module which is unavailable in the
 * jest-expo runner.  This stub exports null-render / no-op replacements so
 * any component that imports from expo-av (e.g. SharedVideoPlayer) can be
 * tested without crashing the suite.
 *
 * Tests that need to assert on Video behaviour (SharedVideoPlayer.component
 * .test.tsx) override this stub with a per-file jest.mock() factory.
 */
import React from 'react';
import { View } from 'react-native';

export const Video = React.forwardRef((_props: any, _ref: any) => (
  <View testID="mock-video" />
));
Video.displayName = 'Video';

export const ResizeMode = {
  COVER: 'cover',
  CONTAIN: 'contain',
  STRETCH: 'stretch',
  NONE: 'none',
};

export const Audio = {
  setAudioModeAsync: async () => {},
  Sound: {
    createAsync: async () => ({ sound: { playAsync: async () => {}, unloadAsync: async () => {} } }),
  },
};

export type AVPlaybackStatus = any;
