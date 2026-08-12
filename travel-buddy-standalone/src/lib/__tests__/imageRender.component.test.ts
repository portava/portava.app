/**
 * imageRender — fail-closed EXIF-strip red-proof.
 *
 * renderAvatarImage / renderCoverImage strip EXIF (including GPS) by
 * re-encoding through expo-image-manipulator. If the manipulator throws, the
 * function must refuse (throw ImageStripFailedError) rather than fall back
 * to the ORIGINAL uri — a fallback would silently upload unstripped
 * EXIF/GPS metadata to the server.
 *
 * expo-image-manipulator is a native module and cannot be imported under
 * plain node:test, so this runs under jest-expo (pnpm test:component).
 *
 * Run with: pnpm test:component
 */
import { renderAvatarImage, renderCoverImage, ImageStripFailedError } from '../imageRender.ts';

const mockManipulateAsync = jest.fn();

// NOTE: intentionally exhaustive — requireActual pulls native-module
// internals that are not safe under jest.
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulateAsync(...args),
  SaveFormat: { JPEG: 'jpeg' },
}));

const ORIGINAL_URI = 'file:///tmp/original-with-gps-exif.jpg';

beforeEach(() => {
  mockManipulateAsync.mockReset();
});

describe('imageRender — fail-closed EXIF strip', () => {
  describe('renderAvatarImage', () => {
    it('happy path: returns the re-encoded (stripped) result, not the original uri', async () => {
      mockManipulateAsync.mockResolvedValueOnce({
        uri: 'file:///tmp/stripped-avatar.jpg',
        width: 512,
        height: 512,
      });

      const result = await renderAvatarImage(ORIGINAL_URI);

      expect(result.uri).toBe('file:///tmp/stripped-avatar.jpg');
      expect(result.uri).not.toBe(ORIGINAL_URI);
      expect(result.mimeType).toBe('image/jpeg');
    });

    it('fail-closed: throws ImageStripFailedError and never returns the original uri when re-encode fails', async () => {
      mockManipulateAsync.mockRejectedValueOnce(new Error('manipulator crashed'));

      await expect(renderAvatarImage(ORIGINAL_URI)).rejects.toBeInstanceOf(ImageStripFailedError);
    });
  });

  describe('renderCoverImage', () => {
    it('happy path: returns the re-encoded (stripped) result, not the original uri', async () => {
      mockManipulateAsync.mockResolvedValueOnce({
        uri: 'file:///tmp/stripped-cover.jpg',
        width: 1200,
        height: 800,
      });

      const result = await renderCoverImage(ORIGINAL_URI, 1920);

      expect(result.uri).toBe('file:///tmp/stripped-cover.jpg');
      expect(result.uri).not.toBe(ORIGINAL_URI);
    });

    it('fail-closed: throws ImageStripFailedError and never returns the original uri when re-encode fails', async () => {
      mockManipulateAsync.mockRejectedValueOnce(new Error('manipulator crashed'));

      let thrown: unknown = null;
      let resolved: unknown = undefined;
      try {
        resolved = await renderCoverImage(ORIGINAL_URI, 1920);
      } catch (err) {
        thrown = err;
      }

      expect(resolved).toBeUndefined();
      expect(thrown).toBeInstanceOf(ImageStripFailedError);
    });
  });
});
