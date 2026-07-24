/**
 * useMediaComposer — photo-URL upload path tests.
 *
 * Verifies that for each optional-photo policy the upload result URL is
 * available for inclusion in a submit payload after a successful upload.
 *
 * uploadItem now reads item data from an itemsRef snapshot (kept fresh via
 * useEffect) rather than relying on React's eager state evaluation.  This
 * makes the tests runnable under React 19 concurrent mode in jest-expo.
 */

import React from 'react';
import { TouchableOpacity } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { fireEvent } from '@testing-library/react-native';
import { useMediaComposer } from '../../hooks/useMediaComposer.ts';
import type { ContentMediaPolicyKey } from '../../lib/contentMediaPolicy.ts';
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

const UPLOADED_URL = 'https://cdn.example.com/uploads/test-photo.jpg';

// NOTE: exhaustive by design — only validateMedia and uploadMedia are exercised;
// spreading requireActual would pull in real Supabase / fetch network calls.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn(() =>
    Promise.resolve({ ok: true, url: UPLOADED_URL }),
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

function UploadHarness({
  policyKey,
  assetId = 'test',
  onDone,
}: {
  policyKey: ContentMediaPolicyKey;
  assetId?: string;
  onDone: (url: string | null) => void;
}) {
  const { items, onPickResult, uploadItem } = useMediaComposer(policyKey);

  React.useEffect(() => {
    onPickResult(makeImageAsset(assetId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpload = () => {
    const item = items[0];
    if (!item) return;
    uploadItem(item.id).then((r) => onDone(r?.url ?? null));
  };

  return <TouchableOpacity testID="upload" onPress={handleUpload} />;
}

describe('useMediaComposer — photo URL reaches submit payload', () => {
  it("'tripCover': upload result URL is passed to onDone after successful upload", async () => {
    const onDone = jest.fn();
    const view = await render(<UploadHarness policyKey="tripCover" assetId="cover" onDone={onDone} />);

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(onDone).toHaveBeenCalledWith(UPLOADED_URL);
  });

  it("'review': upload result URL is passed to onDone after successful upload", async () => {
    const onDone = jest.fn();
    const view = await render(<UploadHarness policyKey="review" assetId="ev1" onDone={onDone} />);

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(onDone).toHaveBeenCalledWith(UPLOADED_URL);
  });

  it("'buddyApplication': upload result URL is passed to onDone after successful upload", async () => {
    const onDone = jest.fn();
    const view = await render(<UploadHarness policyKey="buddyApplication" assetId="profile" onDone={onDone} />);

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(onDone).toHaveBeenCalledWith(UPLOADED_URL);
  });

  it("'hiddenGem': upload result URL is passed to onDone after successful upload", async () => {
    const onDone = jest.fn();
    const view = await render(<UploadHarness policyKey="hiddenGem" assetId="gem" onDone={onDone} />);

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(onDone).toHaveBeenCalledWith(UPLOADED_URL);
  });
});
