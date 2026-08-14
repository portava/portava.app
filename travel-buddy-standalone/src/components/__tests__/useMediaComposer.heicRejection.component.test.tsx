/**
 * useMediaComposer — HEIC processed=false rejection path.
 *
 * When the server returns { ok: true, url, processed: false } for an image
 * upload (HEIC fail-soft: bytes stored but not decoded), uploadItem must:
 *   1. Set the item to uploadState='error' with uploadErrorKind='format_unsupported'.
 *   2. Return null so callers know not to include the URL in a submit payload.
 *
 * retryUpload must short-circuit for format_unsupported items — retrying the
 * identical file will always produce the same failure.
 *
 * Videos legitimately return processed=false and must NOT be treated as errors.
 */

import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { fireEvent } from '@testing-library/react-native';
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
const mockUploadMedia = jest.fn();
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: (...args: any[]) => mockUploadMedia(...args),
}));

const STORED_URL = 'https://cdn.example.com/post-media/user/1234.heic';

function makeImageAsset(mime = 'image/heic'): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///test/photo.heic',
    type: 'image',
    mimeType: mime,
    width: 4032,
    height: 3024,
    fileName: 'photo.heic',
    fileSize: 3_000_000,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

function makeVideoAsset(): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///test/clip.mp4',
    type: 'video',
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    fileName: 'clip.mp4',
    fileSize: 10_000_000,
    duration: 5000,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

// ── Harness ───────────────────────────────────────────────────────────────────

function UploadHarness({
  asset,
  onResult,
}: {
  asset: ImagePickerNS.ImagePickerAsset;
  onResult: (ret: { returnedResult: any; uploadState: string; uploadError: string | null }) => void;
}) {
  const { items, onPickResult, uploadItem } = useMediaComposer('pulse');

  React.useEffect(() => {
    onPickResult(asset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpload = () => {
    const item = items[0];
    if (!item) return;
    uploadItem(item.id).then((r) => {
      // Re-read items via the closure — uploadItem has already settled state.
      // We snapshot the state from the rendered items list on the next tick.
      setImmediate(() => {
        // items is captured via closure; the state update has already fired.
        onResult({
          returnedResult: r,
          uploadState: item.uploadState,   // stale snapshot — re-read via testID
          uploadError: item.uploadError,
        });
      });
    });
  };

  const item = items[0] ?? null;
  return (
    <>
      <TouchableOpacity testID="upload" onPress={handleUpload} />
      {item && (
        <Text testID="item-state">{item.uploadState}</Text>
      )}
      {item?.uploadError != null && (
        <Text testID="item-error">{item.uploadError}</Text>
      )}
      {item?.uploadErrorKind != null && (
        <Text testID="item-error-kind">{item.uploadErrorKind}</Text>
      )}
    </>
  );
}

// Harness that also exposes retryUpload so we can test the short-circuit.
function RetryHarness({
  asset,
}: {
  asset: ImagePickerNS.ImagePickerAsset;
}) {
  const { items, onPickResult, uploadItem, retryUpload } = useMediaComposer('pulse');

  React.useEffect(() => {
    onPickResult(asset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const item = items[0] ?? null;
  return (
    <>
      <TouchableOpacity
        testID="upload"
        onPress={() => { if (item) uploadItem(item.id); }}
      />
      <TouchableOpacity
        testID="retry"
        onPress={() => { if (item) retryUpload(item.id); }}
      />
      {item && <Text testID="item-state">{item.uploadState}</Text>}
      {item?.uploadErrorKind != null && (
        <Text testID="item-error-kind">{item.uploadErrorKind}</Text>
      )}
    </>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useMediaComposer — HEIC processed=false rejection', () => {
  beforeEach(() => {
    mockUploadMedia.mockReset();
  });

  it('sets uploadState to error when the server returns processed=false for an image', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
    });

    const view = await render(
      <UploadHarness asset={makeImageAsset()} onResult={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(view.getByTestId('item-state').props.children).toBe('error');
  });

  it('surfaces the re-upload prompt mentioning JPEG or PNG', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
    });

    const view = await render(
      <UploadHarness asset={makeImageAsset()} onResult={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    const errorText = view.getByTestId('item-error').props.children as string;
    expect(errorText).toMatch(/JPEG|PNG/i);
    // Message guides the user to remove the file and pick a new one — "re-upload"
    // was replaced with "remove" to match the new tray action.
    expect(errorText).toMatch(/remove|re-upload|not supported|isn't supported/i);
  });

  it('uploadItem returns null so the URL is never submitted as part of the post', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
    });

    const capturedResult: { value: any } = { value: undefined };

    function CapturingHarness() {
      const { items, onPickResult, uploadItem } = useMediaComposer('pulse');
      React.useEffect(() => { onPickResult(makeImageAsset()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <TouchableOpacity
          testID="upload"
          onPress={() => {
            const item = items[0];
            if (item) uploadItem(item.id).then((r) => { capturedResult.value = r; });
          }}
        />
      );
    }

    const view = await render(<CapturingHarness />);

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(capturedResult.value).toBeNull();
  });

  it('sets uploadErrorKind to format_unsupported on a HEIC image rejection', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
    });

    const view = await render(
      <UploadHarness asset={makeImageAsset()} onResult={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(view.getByTestId('item-error-kind').props.children).toBe('format_unsupported');
  });

  it('retryUpload does NOT call uploadMedia again for a format_unsupported item', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
    });

    const view = await render(
      <RetryHarness asset={makeImageAsset()} />,
    );

    // First: upload the item so it lands in format_unsupported error state.
    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(view.getByTestId('item-state').props.children).toBe('error');
    expect(view.getByTestId('item-error-kind').props.children).toBe('format_unsupported');

    const callCountAfterUpload = mockUploadMedia.mock.calls.length;

    // Now call retry — it must short-circuit without hitting the network.
    await act(async () => {
      fireEvent.press(view.getByTestId('retry'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(mockUploadMedia.mock.calls.length).toBe(callCountAfterUpload);
    // Item must remain in error state — not reset to idle.
    expect(view.getByTestId('item-state').props.children).toBe('error');
  });

  it('does NOT treat processed=false as an error for video uploads', async () => {
    // Videos legitimately return processed=false (no server-side transcode tier).
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: 'https://cdn.example.com/post-media/user/clip.mp4',
      processed: false,
      width: null,
      height: null,
    });

    const capturedResult: { value: any } = { value: undefined };

    function VideoHarness() {
      const { items, onPickResult, uploadItem } = useMediaComposer('pulse');
      React.useEffect(() => { onPickResult(makeVideoAsset()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
      const item = items[0] ?? null;
      return (
        <>
          <TouchableOpacity
            testID="upload"
            onPress={() => {
              if (item) uploadItem(item.id).then((r) => { capturedResult.value = r; });
            }}
          />
          {item && <Text testID="item-state">{item.uploadState}</Text>}
        </>
      );
    }

    const view = await render(<VideoHarness />);

    await act(async () => {
      fireEvent.press(view.getByTestId('upload'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    // Video should reach 'done', not 'error'
    expect(view.getByTestId('item-state').props.children).toBe('done');
    // And uploadItem should return the result, not null
    expect(capturedResult.value).not.toBeNull();
    expect(capturedResult.value?.url).toBe('https://cdn.example.com/post-media/user/clip.mp4');
  });
});
