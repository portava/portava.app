/**
 * useMediaComposer — policy limits, item lifecycle, and sheet visibility tests.
 */
import { renderHook, act } from '@testing-library/react-native';
import { useMediaComposer } from '../../hooks/useMediaComposer.ts';
import type * as ImagePickerNS from 'expo-image-picker';

// NOTE: intentionally exhaustive — only permission request functions are referenced
// by useMediaComposer's limited-library prompt; launch functions are never called
// in the onPickResult / removeItem / reorderItems paths exercised here.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted' }),
  ),
  requestCameraPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted' }),
  ),
}));

// NOTE: intentionally exhaustive — uploadItem/uploadAll are not called in these
// limit and lifecycle tests; only state-management functions are exercised.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn(() => Promise.resolve({ ok: false, message: 'not tested' })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAsset(id = 'a'): ImagePickerNS.ImagePickerAsset {
  return {
    uri: `file:///test/${id}.jpg`,
    type: 'image',
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    fileName: `${id}.jpg`,
    fileSize: 102400,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

// ── Policy limits ─────────────────────────────────────────────────────────────

describe('useMediaComposer — policy maxItems enforcement', () => {
  it('pulse: rejects a second item (maxItems=1)', async () => {
    const { result } = await renderHook(() => useMediaComposer('pulse'));
    await act(async () => { result.current.onPickResult(makeAsset('a')); });
    await act(async () => { result.current.onPickResult(makeAsset('b')); });
    expect(result.current.items).toHaveLength(1);
  });

  it('memory: accepts up to 10 items and rejects the 11th', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      for (let i = 0; i < 12; i++) {
        result.current.onPickResult(makeAsset(String(i)));
      }
    });
    expect(result.current.items).toHaveLength(10);
  });

  it('canAddMore is false once maxItems is reached', async () => {
    const { result } = await renderHook(() => useMediaComposer('pulse'));
    expect(result.current.canAddMore).toBe(true);
    await act(async () => { result.current.onPickResult(makeAsset('a')); });
    expect(result.current.canAddMore).toBe(false);
  });
});

// ── Item operations ────────────────────────────────────────────────────────────

describe('useMediaComposer — item lifecycle', () => {
  it('adds items and exposes them in items array', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('img1'));
      result.current.onPickResult(makeAsset('img2'));
    });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0].uri).toBe('file:///test/img1.jpg');
  });

  it('removeItem removes the item with the given id', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('rm1'));
      result.current.onPickResult(makeAsset('rm2'));
    });
    const idToRemove = result.current.items[0].id;
    await act(async () => { result.current.removeItem(idToRemove); });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].id).not.toBe(idToRemove);
  });

  it('reorderItems swaps two items', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('first'));
      result.current.onPickResult(makeAsset('second'));
    });
    const firstId  = result.current.items[0].id;
    const secondId = result.current.items[1].id;
    await act(async () => { result.current.reorderItems(0, 1); });
    expect(result.current.items[0].id).toBe(secondId);
    expect(result.current.items[1].id).toBe(firstId);
  });

  it('setCover marks exactly one item as cover and clears others', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('c1'));
      result.current.onPickResult(makeAsset('c2'));
    });
    const secondId = result.current.items[1].id;
    await act(async () => { result.current.setCover(secondId); });
    expect(result.current.items[0].isCover).toBe(false);
    expect(result.current.items[1].isCover).toBe(true);
  });

  it('setAltText updates the alt-text field for the correct item', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => { result.current.onPickResult(makeAsset('at1')); });
    const itemId = result.current.items[0].id;
    await act(async () => { result.current.setAltText(itemId, 'A tall mountain'); });
    expect(result.current.items[0].altText).toBe('A tall mountain');
  });

  it('clearAll resets items to an empty array', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('x1'));
      result.current.onPickResult(makeAsset('x2'));
    });
    await act(async () => { result.current.clearAll(); });
    expect(result.current.items).toHaveLength(0);
  });

  it('primaryItem returns the cover item when one is explicitly marked', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('p1'));
      result.current.onPickResult(makeAsset('p2'));
    });
    const secondId = result.current.items[1].id;
    await act(async () => { result.current.setCover(secondId); });
    expect(result.current.primaryItem?.id).toBe(secondId);
  });
});


// ── Cover auto-assignment ──────────────────────────────────────────────────────

describe('useMediaComposer — cover auto-assignment', () => {
  it('first item is marked as cover when policy supportsCover=true', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => { result.current.onPickResult(makeAsset('first')); });
    expect(result.current.items[0].isCover).toBe(true);
  });

  it('subsequent items are NOT auto-cover', async () => {
    const { result } = await renderHook(() => useMediaComposer('memory'));
    await act(async () => {
      result.current.onPickResult(makeAsset('f'));
      result.current.onPickResult(makeAsset('s'));
    });
    expect(result.current.items[0].isCover).toBe(true);
    expect(result.current.items[1].isCover).toBe(false);
  });

  it('first item is NOT marked as cover when policy supportsCover=false', async () => {
    const { result } = await renderHook(() => useMediaComposer('pulse'));
    await act(async () => { result.current.onPickResult(makeAsset('nc')); });
    expect(result.current.items[0].isCover).toBe(false);
  });
});
