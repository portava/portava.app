/**
 * useMediaComposer — optional-photo flow tests (pick, policy, state).
 *
 * Covers the text-only path and pick path for each optional-photo policy.
 * These tests use renderHook exclusively (no presses, no press-budget
 * constraints) and verify:
 *   - primaryItem is null before any photo is added (text-only path)
 *   - primaryItem.uri is set after onPickResult (pick path)
 *   - maxItems is enforced (additional picks beyond the limit are dropped)
 *   - canAddMore correctly reflects the limit
 *   - clearAll resets to the text-only state
 *
 * ## Upload URL path
 * The "photo URL reaches the submit payload" assertion is in the companion
 * file useMediaComposer.uploadUrl.component.test.tsx.  Those tests are
 * currently skipped — see that file's JSDoc for the full explanation of the
 * React 19 scheduling constraint that prevents uploadItem from being tested
 * in isolation.
 *
 * ## Skipped flows
 * communityPlace and safetyReport are NOT tested here; they are documented
 * as skipped in docs/media-phase0-report.md because the server endpoints
 * have no media column.
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

// ── tripCover — optional trip cover image ─────────────────────────────────────

describe("useMediaComposer 'tripCover' — optional cover photo flow", () => {
  it('text-only path: primaryItem is null when no photo is added', async () => {
    const { result } = await renderHook(() => useMediaComposer('tripCover'));
    expect(result.current.primaryItem).toBeNull();
  });

  it('photo path: primaryItem.uri is set after picking a cover image', async () => {
    const { result } = await renderHook(() => useMediaComposer('tripCover'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('cover'));
    });

    expect(result.current.primaryItem).not.toBeNull();
    expect(result.current.primaryItem?.uri).toBe('file:///test/cover.jpg');
  });

  it('respects maxItems=1 — rejects a second cover photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('tripCover'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('cover1'));
      result.current.onPickResult(makeImageAsset('cover2'));
    });

    expect(result.current.items).toHaveLength(1);
  });

  it('canAddMore is false once the cover is picked', async () => {
    const { result } = await renderHook(() => useMediaComposer('tripCover'));

    expect(result.current.canAddMore).toBe(true);

    await act(async () => {
      result.current.onPickResult(makeImageAsset('cover'));
    });

    expect(result.current.canAddMore).toBe(false);
  });
});

// ── review — optional evidence photos ────────────────────────────────────────

describe("useMediaComposer 'review' — optional evidence photo flow", () => {
  it('text-only path: primaryItem is null when no photo is added', async () => {
    const { result } = await renderHook(() => useMediaComposer('review'));
    expect(result.current.primaryItem).toBeNull();
  });

  it('photo path: primaryItem.uri is set after picking an evidence photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('review'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('evidence'));
    });

    expect(result.current.primaryItem?.uri).toBe('file:///test/evidence.jpg');
  });

  it('allows up to maxItems=3 evidence photos', async () => {
    const { result } = await renderHook(() => useMediaComposer('review'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('ev1'));
      result.current.onPickResult(makeImageAsset('ev2'));
      result.current.onPickResult(makeImageAsset('ev3'));
    });

    expect(result.current.items).toHaveLength(3);
    expect(result.current.canAddMore).toBe(false);
  });

  it('rejects a 4th photo — maxItems=3 enforced', async () => {
    const { result } = await renderHook(() => useMediaComposer('review'));

    await act(async () => {
      for (let i = 0; i < 4; i++) {
        result.current.onPickResult(makeImageAsset(String(i)));
      }
    });

    expect(result.current.items).toHaveLength(3);
  });

  it('text-only path still works after picking and clearing', async () => {
    const { result } = await renderHook(() => useMediaComposer('review'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('ev'));
    });
    expect(result.current.primaryItem).not.toBeNull();

    await act(async () => { result.current.clearAll(); });
    expect(result.current.primaryItem).toBeNull();
  });
});

// ── buddyApplication — optional profile photos ────────────────────────────────

describe("useMediaComposer 'buddyApplication' — optional profile photo flow", () => {
  it('text-only path: primaryItem is null when no photo is added', async () => {
    const { result } = await renderHook(() => useMediaComposer('buddyApplication'));
    expect(result.current.primaryItem).toBeNull();
  });

  it('photo path: primaryItem.uri is set after picking a profile photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('buddyApplication'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('profile'));
    });

    expect(result.current.primaryItem?.uri).toBe('file:///test/profile.jpg');
  });

  it('allows up to maxItems=3 profile photos', async () => {
    const { result } = await renderHook(() => useMediaComposer('buddyApplication'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('p1'));
      result.current.onPickResult(makeImageAsset('p2'));
      result.current.onPickResult(makeImageAsset('p3'));
    });

    expect(result.current.items).toHaveLength(3);
    expect(result.current.canAddMore).toBe(false);
  });
});

// ── hiddenGem — optional representative photo ─────────────────────────────────

describe("useMediaComposer 'hiddenGem' — optional gem photo flow", () => {
  it('text-only path: primaryItem is null when no photo is added', async () => {
    const { result } = await renderHook(() => useMediaComposer('hiddenGem'));
    expect(result.current.primaryItem).toBeNull();
  });

  it('photo path: primaryItem.uri is set after picking a gem photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('hiddenGem'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('gem'));
    });

    expect(result.current.primaryItem?.uri).toBe('file:///test/gem.jpg');
  });

  it('respects maxItems=1 — rejects a second gem photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('hiddenGem'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('gem1'));
      result.current.onPickResult(makeImageAsset('gem2'));
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.canAddMore).toBe(false);
  });

  it('clearAll resets to text-only state — no photo', async () => {
    const { result } = await renderHook(() => useMediaComposer('hiddenGem'));

    await act(async () => {
      result.current.onPickResult(makeImageAsset('gem'));
    });

    expect(result.current.primaryItem).not.toBeNull();

    await act(async () => { result.current.clearAll(); });

    expect(result.current.primaryItem).toBeNull();
  });
});
