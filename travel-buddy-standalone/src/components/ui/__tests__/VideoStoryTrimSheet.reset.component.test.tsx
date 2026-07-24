/**
 * VideoStoryTrimSheet — state-reset regression tests.
 *
 * Verifies that `loading` and `hasError` are cleared when:
 *   1. A new asset URI arrives (re-pick scenario).
 *   2. The sheet visibility toggles from false → true (re-open scenario).
 *
 * Uses a callback-capturing Video stub so tests can trigger playback errors
 * without a native runtime.
 *
 * Note: state updates inside modals require `await act(async () => { ... })`
 * to commit in the React 19 + RNTL v14 + jest-expo renderer — a bare/sync
 * act() schedules updates that never render (React 19 renderer budget).
 */
import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { VideoStoryTrimSheet } from '../VideoStoryTrimSheet.tsx';
import type { ImagePickerAsset } from 'expo-image-picker';

// ── Mock ────────────────────────────────────────────────────────────────────

// NOTE: intentionally captures the playback callback from props so tests can
// fire error/load events without needing a real native AV runtime. The variable
// is written at render time (not factory-definition time) so it is safely
// accessible inside each test body.
let mockPlaybackCallback: ((status: any) => void) | null = null;

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Video: React.forwardRef((props: any, _ref: any) => {
      mockPlaybackCallback = props.onPlaybackStatusUpdate ?? null;
      return React.createElement(View, { testID: 'video-player' });
    }),
    ResizeMode: { COVER: 'cover' },
  };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const ASSET_A: ImagePickerAsset = {
  uri: 'file:///clip-a.mp4',
  type: 'video',
  mimeType: 'video/mp4',
  fileName: 'clip-a.mp4',
  fileSize: 5_000_000,
  width: 1080,
  height: 1920,
  duration: 15,
  assetId: null,
  base64: null,
  exif: null,
  pairedVideoAsset: undefined,
} as unknown as ImagePickerAsset;

const ASSET_B: ImagePickerAsset = {
  ...ASSET_A,
  uri: 'file:///clip-b.mp4',
  fileName: 'clip-b.mp4',
};

beforeEach(() => {
  mockPlaybackCallback = null;
  jest.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('VideoStoryTrimSheet — state reset', () => {
  it('clears hasError and re-enables confirm when a new asset URI is provided after an error', async () => {
    const onConfirm = jest.fn();
    const onReject  = jest.fn();

    const { getByLabelText, queryByText, rerender } = await render(
      <VideoStoryTrimSheet
        visible
        asset={ASSET_A}
        onConfirm={onConfirm}
        onReject={onReject}
      />,
    );

    // Confirm button starts present (not yet errored).
    expect(getByLabelText('Use this video')).toBeTruthy();

    // Trigger a playback error. `await act(async () => {...})` is required for
    // state updates inside a Modal to commit in the React 19 + RNTL renderer.
    await act(async () => {
      mockPlaybackCallback?.({ isLoaded: false, error: 'NETWORK_ERROR' });
    });

    // Error overlay should appear.
    await waitFor(() => {
      expect(queryByText('Could not load video preview')).toBeTruthy();
    });

    // Provide a new asset (simulates the user re-picking a different clip).
    await rerender(
      <VideoStoryTrimSheet
        visible
        asset={ASSET_B}
        onConfirm={onConfirm}
        onReject={onReject}
      />,
    );

    // Error overlay must be gone and confirm re-enabled after the URI changes.
    await waitFor(() => {
      expect(queryByText('Could not load video preview')).toBeNull();
    });
    expect(getByLabelText('Use this video')).toBeTruthy();
  });

  it('clears hasError when the sheet is closed then reopened with the same asset', async () => {
    const onConfirm = jest.fn();
    const onReject  = jest.fn();

    const { queryByText, rerender } = await render(
      <VideoStoryTrimSheet
        visible
        asset={ASSET_A}
        onConfirm={onConfirm}
        onReject={onReject}
      />,
    );

    // Trigger a playback error.
    await act(async () => {
      mockPlaybackCallback?.({ isLoaded: false, error: 'TIMEOUT' });
    });

    await waitFor(() => {
      expect(queryByText('Could not load video preview')).toBeTruthy();
    });

    // Close the sheet (visible=false), then reopen (visible=true).
    await rerender(
      <VideoStoryTrimSheet
        visible={false}
        asset={ASSET_A}
        onConfirm={onConfirm}
        onReject={onReject}
      />,
    );
    await rerender(
      <VideoStoryTrimSheet
        visible
        asset={ASSET_A}
        onConfirm={onConfirm}
        onReject={onReject}
      />,
    );

    // Error overlay must be cleared after re-open.
    await waitFor(() => {
      expect(queryByText('Could not load video preview')).toBeNull();
    });
  });
});
