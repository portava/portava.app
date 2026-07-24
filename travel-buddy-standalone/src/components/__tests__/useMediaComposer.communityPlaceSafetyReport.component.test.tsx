/**
 * useMediaComposer — communityPlace and safetyReport optional-photo flow tests.
 *
 * Tests the text-only path and pick path for communityPlace and safetyReport
 * policy keys, matching the pattern in useMediaComposer.optionalPhoto.component.test.tsx.
 *
 * Covers:
 *   - primaryItem is null before any photo is added (text-only path)
 *   - primaryItem.uri is set after onPickResult (pick path)
 *   - maxItems enforced (communityPlace: 3, safetyReport: 1)
 *   - canAddMore reflects the limit correctly
 *   - clearAll resets to text-only state
 */

import { renderHook, act } from '@testing-library/react-native';
import { useMediaComposer } from '../../hooks/useMediaComposer.ts';
import type * as ImagePickerNS from 'expo-image-picker';

// NOTE: exhaustive by design — only the two permission functions are used here;
// spreading requireActual would pull in native expo-image-picker bindings that
// crash jest without a device or Expo Go context.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted' }),
  ),
  requestCameraPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted' }),
  ),
}));

// NOTE: exhaustive by design — only validateMedia and uploadMedia are exercised;
// spreading requireActual would pull in real Supabase / fetch network calls.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn(() =>
    Promise.resolve({ ok: true, url: 'https://cdn.example.com/uploads/test-photo.jpg' }),
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeImageAsset(id = 'img'): ImagePickerNS.ImagePickerAsset {
  return {
    uri: `file:///test/${id}.jpg`,
    type: 'image',
    mimeType: 'image/jpeg',
    width: 1200,
    height: 900,
    fileName: `${id}.jpg`,
    fileSize: 512000,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

// ── communityPlace — optional place submission photos ─────────────────────────

describe("useMediaComposer 'communityPlace' — optional place photo flow", () => {
  it('text-only path: primaryItem is null when no photo is added', async () => {
    const { result } = await renderHook(() => useMediaComposer('communityPlace'));
    expect(result.current.primaryItem).toBeNull();
  });

  it('photo path: primaryItem.uri is set after picking a place photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('communityPlace'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('place'));
    });

    expect(result.current.primaryItem).not.toBeNull();
    expect(result.current.primaryItem?.uri).toBe('file:///test/place.jpg');
  });

  it('allows up to maxItems=3 place photos', async () => {
    const { result } = await renderHook(() => useMediaComposer('communityPlace'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('p1'));
      result.current.onPickResult(makeImageAsset('p2'));
      result.current.onPickResult(makeImageAsset('p3'));
    });

    expect(result.current.items).toHaveLength(3);
    expect(result.current.canAddMore).toBe(false);
  });

  it('rejects a 4th photo — maxItems=3 enforced', async () => {
    const { result } = await renderHook(() => useMediaComposer('communityPlace'));

    await act(async () => {
      for (let i = 0; i < 4; i++) {
        result.current.onPickResult(makeImageAsset(String(i)));
      }
    });

    expect(result.current.items).toHaveLength(3);
  });

  it('clearAll resets to text-only state — no photos', async () => {
    const { result } = await renderHook(() => useMediaComposer('communityPlace'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('place'));
    });

    expect(result.current.primaryItem).not.toBeNull();

    await act(async () => { result.current.clearAll(); });

    expect(result.current.primaryItem).toBeNull();
    expect(result.current.items).toHaveLength(0);
  });

  it('canAddMore is true while under the 3-photo limit', async () => {
    const { result } = await renderHook(() => useMediaComposer('communityPlace'));

    expect(result.current.canAddMore).toBe(true);

    await act(async () => {
      result.current.onPickResult(makeImageAsset('p1'));
      result.current.onPickResult(makeImageAsset('p2'));
    });

    expect(result.current.canAddMore).toBe(true);

    await act(async () => {
      result.current.onPickResult(makeImageAsset('p3'));
    });

    expect(result.current.canAddMore).toBe(false);
  });
});

// ── safetyReport — optional evidence photo ────────────────────────────────────

describe("useMediaComposer 'safetyReport' — optional evidence photo flow", () => {
  it('text-only path: primaryItem is null when no photo is added', async () => {
    const { result } = await renderHook(() => useMediaComposer('safetyReport'));
    expect(result.current.primaryItem).toBeNull();
  });

  it('photo path: primaryItem.uri is set after picking an evidence photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('safetyReport'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('evidence'));
    });

    expect(result.current.primaryItem).not.toBeNull();
    expect(result.current.primaryItem?.uri).toBe('file:///test/evidence.jpg');
  });

  it('respects maxItems=1 — rejects a second evidence photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('safetyReport'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('ev1'));
      result.current.onPickResult(makeImageAsset('ev2'));
    });

    expect(result.current.items).toHaveLength(1);
  });

  it('canAddMore is false once the evidence photo is picked', async () => {
    const { result } = await renderHook(() => useMediaComposer('safetyReport'));

    expect(result.current.canAddMore).toBe(true);

    await act(async () => {
      result.current.onPickResult(makeImageAsset('ev'));
    });

    expect(result.current.canAddMore).toBe(false);
  });

  it('clearAll resets to text-only state — no evidence photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('safetyReport'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('ev'));
    });

    expect(result.current.primaryItem).not.toBeNull();

    await act(async () => { result.current.clearAll(); });

    expect(result.current.primaryItem).toBeNull();
    expect(result.current.items).toHaveLength(0);
  });
});
