/**
 * normalizeUpload.core — every picked photo or video becomes something the server takes, without distortion.
 *
 * The owner's iPhone (2026-10-22) could upload nothing: HEIC photos, HEVC `.MOV` library videos and the camera's `.mov`
 * were all "Unsupported media type". These pin what the normalizer guarantees:
 *   N1  the aspect ratio never changes and nothing is enlarged — only the longest edge is capped, by ONE dimension;
 *   N2  formats the server cannot decode become JPEG; PNG / WebP / JPEG keep theirs;
 *   N3  a photo over the size cap steps its quality down until it fits; a PNG that cannot fit falls back to JPEG;
 *   N4  a photo that cannot be re-encoded is handed back untouched (validateMedia then refuses it by name);
 *   N5  videos are never re-encoded here; the camera's `.mov` is labelled QuickTime, `.m4v` MP4;
 *   N6  every other field of the picker asset survives.
 *
 * Run: node --import tsx/esm --test src/lib/media/__tests__/normalizeUpload.core.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitLongestEdge, planImage, videoMimeFor, normalizeForUploadWith, IMAGE_MAX_EDGE_PX, IMAGE_QUALITY_STEPS, type NormalizeDeps,
} from '../normalizeUpload.core.ts';

/** A manipulator that behaves like the real one: given ONE dimension it scales the other proportionally. */
function fakeManipulator(src: { width: number; height: number }, sizes: number[]) {
  const calls: Array<{ actions: unknown[]; options: { compress: number; format: string } }> = [];
  let i = 0;
  const deps: NormalizeDeps = {
    manipulate: async (_uri, actions, options) => {
      calls.push({ actions, options });
      let { width, height } = src;
      const r = (actions[0] as { resize?: { width?: number; height?: number } } | undefined)?.resize;
      if (r?.width) { height = Math.round((height * r.width) / width); width = r.width; }
      else if (r?.height) { width = Math.round((width * r.height) / height); height = r.height; }
      return { uri: `file:///out-${calls.length}.${options.format}`, width, height };
    },
    fileSize: async () => sizes[Math.min(i++, sizes.length - 1)] ?? null,
  };
  return { deps, calls };
}

describe('N1 — never distorted, never enlarged', () => {
  it('caps the LONGEST edge by one dimension only, landscape and portrait', () => {
    assert.deepEqual(fitLongestEdge(8064, 6048), { width: IMAGE_MAX_EDGE_PX });
    assert.deepEqual(fitLongestEdge(6048, 8064), { height: IMAGE_MAX_EDGE_PX });
    assert.deepEqual(fitLongestEdge(5000, 5000), { width: IMAGE_MAX_EDGE_PX });
  });

  it('leaves a photo already within the cap alone, and never enlarges', () => {
    assert.equal(fitLongestEdge(4032, 3024), null);
    assert.equal(fitLongestEdge(400, 300), null);
    assert.equal(fitLongestEdge(null, 300), null);
  });

  it('the re-encoded photo keeps its aspect ratio (48 MP 4:3, 9:16 portrait, panorama)', async () => {
    for (const src of [{ width: 8064, height: 6048 }, { width: 2160, height: 3840 }, { width: 16000, height: 3000 }]) {
      const { deps } = fakeManipulator(src, [2_000_000]);
      const out = await normalizeForUploadWith({ uri: 'file:///in.heic', mimeType: 'image/heic', ...src }, deps);
      assert.ok(Math.max(out.width!, out.height!) <= IMAGE_MAX_EDGE_PX);
      assert.ok(Math.abs(out.width! / out.height! - src.width / src.height) < 0.002, `${src.width}x${src.height} → ${out.width}x${out.height}`);
    }
  });
});

describe('N2 — formats', () => {
  it('HEIC / HEIF / TIFF / unknown become JPEG; PNG, WebP and JPEG keep theirs', () => {
    assert.equal(planImage({ uri: 'a', mimeType: 'image/heic' }).format, 'jpeg');
    assert.equal(planImage({ uri: 'a', mimeType: 'image/heif' }).format, 'jpeg');
    assert.equal(planImage({ uri: 'a', mimeType: 'image/tiff' }).format, 'jpeg');
    assert.equal(planImage({ uri: 'file:///IMG_0001.HEIC', mimeType: null }).format, 'jpeg');
    assert.equal(planImage({ uri: 'a', mimeType: 'image/png' }).format, 'png');
    assert.equal(planImage({ uri: 'file:///shot.png', mimeType: null }).format, 'png');
    assert.equal(planImage({ uri: 'a', mimeType: 'image/webp' }).format, 'webp');
    assert.equal(planImage({ uri: 'a', mimeType: 'image/jpeg' }).format, 'jpeg');
  });

  it('a HEIC photo comes back as a JPEG the server takes, renamed', async () => {
    const { deps, calls } = fakeManipulator({ width: 4032, height: 3024 }, [2_400_000]);
    const out = await normalizeForUploadWith({ uri: 'file:///IMG_0001.HEIC', mimeType: 'image/heic', fileName: 'IMG_0001.HEIC', width: 4032, height: 3024, fileSize: 1_900_000 }, deps);
    assert.equal(out.mimeType, 'image/jpeg');
    assert.equal(out.fileName, 'IMG_0001.jpg');
    assert.equal(out.fileSize, 2_400_000);
    assert.equal(out.uri, 'file:///out-1.jpeg');
    assert.deepEqual(calls[0], { actions: [], options: { compress: IMAGE_QUALITY_STEPS[0], format: 'jpeg' } });
  });
});

describe('N3 — fits the size cap', () => {
  it('steps the quality down until the photo fits, and stops there', async () => {
    const { deps, calls } = fakeManipulator({ width: 8064, height: 6048 }, [14_000_000, 11_000_000, 9_000_000, 1]);
    const out = await normalizeForUploadWith({ uri: 'file:///big.jpg', mimeType: 'image/jpeg', width: 8064, height: 6048 }, deps);
    assert.deepEqual(calls.map((c) => c.options.compress), IMAGE_QUALITY_STEPS.slice(0, 3));
    assert.equal(out.fileSize, 9_000_000);
    assert.deepEqual(calls[0].actions, [{ resize: { width: IMAGE_MAX_EDGE_PX } }]);
  });

  it('a PNG that will not fit losslessly is re-tried as JPEG', async () => {
    const { deps, calls } = fakeManipulator({ width: 3000, height: 3000 }, [15_000_000, 4_000_000]);
    const out = await normalizeForUploadWith({ uri: 'file:///s.png', mimeType: 'image/png', fileName: 's.png', width: 3000, height: 3000 }, deps);
    assert.deepEqual(calls.map((c) => c.options.format), ['png', 'jpeg']);
    assert.equal(out.mimeType, 'image/jpeg');
    assert.equal(out.fileName, 's.jpg');
  });

  it('when nothing fits, the smallest attempt is returned (validateMedia then states its real size)', async () => {
    const { deps, calls } = fakeManipulator({ width: 4000, height: 3000 }, [20_000_000]);
    const out = await normalizeForUploadWith({ uri: 'file:///x.jpg', mimeType: 'image/jpeg', width: 4000, height: 3000 }, deps);
    assert.equal(calls.length, IMAGE_QUALITY_STEPS.length);
    assert.equal(out.fileSize, 20_000_000);
    assert.equal(calls.at(-1)!.options.compress, IMAGE_QUALITY_STEPS.at(-1));
  });
});

describe('N4 / N5 / N6', () => {
  it('N4: a photo that cannot be re-encoded is handed back untouched', async () => {
    const asset = { uri: 'file:///IMG.HEIC', mimeType: 'image/heic', width: 4032, height: 3024 };
    const out = await normalizeForUploadWith(asset, { manipulate: async () => { throw new Error('decode failed'); }, fileSize: async () => 1 });
    assert.deepEqual(out, asset);
  });

  it('N5: videos are never re-encoded; .mov is QuickTime and .m4v MP4', async () => {
    let called = false;
    const deps: NormalizeDeps = { manipulate: async () => { called = true; return { uri: '', width: 0, height: 0 }; }, fileSize: async () => 0 };
    const mov = await normalizeForUploadWith({ uri: 'file:///rec.mov', type: 'video', mimeType: null, duration: 12 }, deps);
    assert.equal(mov.mimeType, 'video/quicktime');
    const m4v = await normalizeForUploadWith({ uri: 'file:///clip.m4v', type: 'video', mimeType: 'video/x-m4v' }, deps);
    assert.equal(m4v.mimeType, 'video/mp4');
    assert.equal(called, false);
    assert.equal(videoMimeFor({ uri: 'file:///ExportedAsset.mp4', mimeType: 'video/mp4' }), 'video/mp4');
    assert.equal(videoMimeFor({ uri: 'file:///x', mimeType: 'video/quicktime' }), 'video/quicktime');
  });

  it('N6: every other picker field survives', async () => {
    const { deps } = fakeManipulator({ width: 1000, height: 800 }, [100]);
    const out = await normalizeForUploadWith({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', width: 1000, height: 800, assetId: 'PH-1', exif: null } as never, deps) as unknown as Record<string, unknown>;
    assert.equal(out.assetId, 'PH-1');
    assert.equal(out.type, 'image');
  });
});
