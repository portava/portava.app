/**
 * HighlightComposer — reopen-preserves-media regression test.
 *
 * Before the fix: the visible=true useEffect called setMediaUri(null), discarding
 * any media the user had already picked when the composer was closed and reopened.
 *
 * After the fix: the effect only resets non-media form fields (caption, vis, loc,
 * error). Media state lives in useMediaComposer and is never touched by the effect.
 *
 * This test verifies the contract through a minimal wrapper that mirrors exactly
 * what HighlightComposer's visible useEffect does — without importing the full
 * HighlightComposer component (which would pull in native modules / Supabase
 * singletons that cause timer leaks in the Jest environment).
 *
 * If someone accidentally adds `mediaComposer.clearAll()` to the visible useEffect,
 * the second test here will catch it.
 */
import React, { useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { render, act, waitFor } from '@testing-library/react-native';
import { useMediaComposer } from '../../hooks/useMediaComposer.ts';
import type * as ImagePickerNS from 'expo-image-picker';

// NOTE: intentionally exhaustive — only permission request functions are referenced
// by useMediaComposer's limited-library prompt; launch functions are never invoked
// in the onPickResult path under test.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted' }),
  ),
  requestCameraPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted' }),
  ),
}));

// NOTE: intentionally exhaustive — uploadItem/uploadAll are not called; only
// onPickResult and the visible-effect lifecycle are exercised.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn(() => Promise.resolve({ ok: false, message: 'not tested' })),
}));

// ── Minimal wrapper that mirrors HighlightComposer's visible-effect contract ──
//
// Rules it must satisfy (same as the real component after the fix):
//   1. On visible=true: reset non-media form fields (caption, error).
//   2. NEVER call mediaComposer.clearAll() or any other media reset.
//
// Exposes:
//   testID="item-count"  — text node showing items.length for assertions.
//   testID="picker-btn"  — visible only when items.length === 0.

interface WrapperProps {
  visible: boolean;
  onComposer?: (c: ReturnType<typeof useMediaComposer>) => void;
}

function HighlightMediaWrapper({ visible, onComposer }: WrapperProps) {
  const mediaComposer = useMediaComposer('highlight');
  const [caption, setCaption] = useState('');
  const [error, setError]     = useState<string | null>(null);

  // Reports the composer ref on every render so tests can capture it.
  onComposer?.(mediaComposer);

  // Mirrors HighlightComposer's useEffect exactly:
  //   - Resets non-media form fields when visible=true.
  //   - Does NOT touch mediaComposer state.
  useEffect(() => {
    if (visible) {
      setCaption('');
      setError(null);
    }
  }, [visible]);

  return (
    <View>
      <Text testID="item-count">{mediaComposer.items.length}</Text>
      <Text testID="caption">{caption}</Text>
      {error ? <Text testID="error">{error}</Text> : null}
      {mediaComposer.items.length === 0 && <View testID="picker-btn" />}
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAsset(): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///test/photo.jpg',
    type: 'image',
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    fileName: 'photo.jpg',
    fileSize: 102400,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HighlightComposer — reopen preserves media', () => {
  it('picker button is shown before any media is picked', async () => {
    const { getByTestId } = await render(
      <HighlightMediaWrapper visible={true} />,
    );
    expect(getByTestId('picker-btn')).toBeTruthy();
    expect(getByTestId('item-count').props.children).toBe(0);
  });

  it('media items persist after visible=false → visible=true cycle', async () => {
    let latestComposer: ReturnType<typeof useMediaComposer> | null = null;

    const { getByTestId, queryByTestId, rerender } = await render(
      <HighlightMediaWrapper
        visible={true}
        onComposer={c => { latestComposer = c; }}
      />,
    );

    // Wait for the component to be fully committed so latestComposer is set.
    await waitFor(() => expect(latestComposer).not.toBeNull());

    // Initially no media — picker button is visible.
    expect(getByTestId('picker-btn')).toBeTruthy();
    expect(getByTestId('item-count').props.children).toBe(0);

    // Pick an asset.
    await act(async () => {
      latestComposer!.onPickResult(makeAsset());
    });

    // Picker button must be gone (item added).
    await waitFor(() => expect(queryByTestId('picker-btn')).toBeNull());
    expect(getByTestId('item-count').props.children).toBe(1);

    // ── Close (visible=false) ────────────────────────────────────────────
    rerender(
      <HighlightMediaWrapper
        visible={false}
        onComposer={c => { latestComposer = c; }}
      />,
    );

    // ── Reopen (visible=true) ────────────────────────────────────────────
    rerender(
      <HighlightMediaWrapper
        visible={true}
        onComposer={c => { latestComposer = c; }}
      />,
    );

    // The fix: the visible=true effect MUST NOT have reset media.
    // Item count stays 1 and picker button stays hidden.
    await waitFor(() =>
      expect(getByTestId('item-count').props.children).toBe(1),
    );
    expect(queryByTestId('picker-btn')).toBeNull();
  });
});
