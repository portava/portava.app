/**
 * Photo ceiling (MAX_IMAGE_DIM 2048 → 4096) + the EXIF/GPS strip that must
 * survive it.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT IS GUARDING AGAINST
 * ----------------------------------------------------
 * Raising the stored-original cap is a one-line change to a constant. The risk
 * is not that the constant is wrong — it is that a test written to prove the new
 * dimension passes while the privacy guarantee silently rots underneath it.
 * `processImage()` gets its EXIF strip *for free*, as a side effect of sharp
 * discarding metadata on re-encode. Nothing in the code says "strip EXIF"; there
 * is no line to delete. So the strip can be lost by a change that looks entirely
 * unrelated — adding `.keepMetadata()`, `.withMetadata()`, or `.keepExif()` to
 * preserve an ICC profile or an orientation tag would do it, and every
 * dimension assertion in this file would stay green while stored photos started
 * carrying capture coordinates again. That was the audit's most severe finding.
 *
 * Each test therefore asserts the strip THREE independent ways, one of which
 * does not use sharp's parser at all:
 *   1. sharp reports metadata.exif === undefined
 *   2. the raw bytes contain no `Exif\0\0` APP1 marker
 *   3. the raw bytes contain no ASCII sentinel that was planted in the input
 *
 * NON-VACUOUSNESS — VERIFIED, NOT ASSUMED
 * ---------------------------------------
 * These assertions were confirmed to fail when the strip is disabled. Adding
 * `.keepMetadata()` to the `processImage()` pipeline (mediaProcessing.ts) makes
 * this file go red on exactly the metadata assertions, e.g.:
 *
 *   ✖ oversized, EXIF-laden, mis-oriented JPEG: capped, oriented, stripped
 *     AssertionError: stored bytes must carry NO EXIF block at all
 *     + actual   - expected
 *     + <Buffer 45 78 69 66 00 00 ...>
 *     - undefined
 *
 * and the raw-marker and sentinel assertions fail alongside it, while the width/
 * height/orientation assertions stay GREEN — which is precisely the failure mode
 * described above, reproduced. Result under the negative control: 6 tests, 4
 * pass, 2 fail (the JPEG and WebP cases). The line was then removed and the
 * suite restored to 6/6. Do not weaken these three assertions to "one is
 * enough": the sharp-parser one and the raw-byte ones fail for different
 * reasons.
 *
 * Worth knowing from that run: the "derived thumbnail and feed variant" test
 * stayed GREEN while processImage() was leaking. That is correct, not a hole —
 * makeThumbnail()/makeFeedVariant() re-encode with sharp's default behaviour, so
 * they strip metadata independently of what processImage() did. It does mean
 * that test guards the derivative functions only, and cannot stand in for the
 * processImage() coverage above.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  processImage,
  makeThumbnail,
  makeFeedVariant,
  sniffMedia,
  MAX_IMAGE_DIM,
  FEED_DIM,
  THUMBNAIL_DIM,
} from "../lib/mediaProcessing.js";

/**
 * A distinctive ASCII string planted in EXIF so its survival can be checked
 * against the raw bytes, with no dependence on sharp's metadata parser.
 */
const SENTINEL = "PORTAVA_EXIF_SENTINEL_MUST_NOT_SURVIVE";
const EXIF_MARKER = Buffer.from("Exif\0\0", "latin1");

/** Every way we know how to look for leftover metadata. */
async function assertFullyStripped(buf: Buffer, what: string) {
  const meta = await sharp(buf).metadata();
  assert.equal(meta.exif, undefined, `${what}: stored bytes must carry NO EXIF block at all`);
  assert.equal(
    buf.includes(EXIF_MARKER),
    false,
    `${what}: raw bytes must contain no Exif APP1 marker (parser-independent check)`,
  );
  assert.equal(
    buf.includes(Buffer.from(SENTINEL, "latin1")),
    false,
    `${what}: the planted EXIF sentinel must not appear anywhere in the output`,
  );
  // The orientation tag must be GONE, not merely normalised to 1 — it lives in
  // the same EXIF block as GPS, so a surviving orientation tag means a surviving
  // block.
  assert.equal(meta.orientation, undefined, `${what}: orientation tag must not survive`);
}

/**
 * An oversized landscape JPEG carrying EXIF (including GPS) and an orientation
 * tag of 6 — "rotate 90° CW to display", which real phone cameras emit
 * constantly. 5000 × 2500 exceeds the 4096 cap on the long edge.
 */
async function oversizedOrientedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 5000, height: 2500, channels: 3, background: "#3a5" } })
    .withExif({
      IFD0: { Copyright: SENTINEL },
      GPS: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W" },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

describe("photo ceiling — MAX_IMAGE_DIM", () => {
  it("is 4096, the value that passes phone-native photos through unresampled", () => {
    // Pinned deliberately. 12MP phones emit 4032×3024 (iPhone/Galaxy) and
    // 4080×3072 (Pixel); both clear 3840 and both fit under 4096, so a 3840 cap
    // would resample essentially every real upload to save 4.8% of an edge.
    // Changing this number means re-reading that argument in mediaProcessing.ts.
    assert.equal(MAX_IMAGE_DIM, 4096);
  });

  it("leaves a phone-native 4032px source at its own size (no resample)", async () => {
    // The whole point of 4096 over 3840. Uses a cheap 1-channel image so the
    // 12MP allocation stays small.
    const src = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: "#246" } })
      .jpeg()
      .toBuffer();
    const sniffed = sniffMedia(src)!;
    const out = await processImage(src, sniffed);
    assert.equal(out.width, 4032, "a 4032px source must not be downscaled by a 4096 cap");
    assert.equal(out.height, 3024);
  });
});

describe("oversized photo: capped, auto-oriented, and fully EXIF/GPS-stripped", () => {
  it("oversized, EXIF-laden, mis-oriented JPEG: capped, oriented, stripped", async () => {
    const src = await oversizedOrientedJpeg();

    // Precondition: the fixture really does carry what we claim, or every
    // assertion below would pass against an input that never had metadata.
    const srcMeta = await sharp(src).metadata();
    assert.equal(srcMeta.width, 5000);
    assert.equal(srcMeta.height, 2500);
    assert.equal(srcMeta.orientation, 6, "fixture must carry an orientation tag");
    assert.ok((srcMeta.exif?.length ?? 0) > 0, "fixture must carry an EXIF block");
    assert.ok(src.includes(Buffer.from(SENTINEL, "latin1")), "fixture must carry the sentinel");

    const sniffed = sniffMedia(src);
    assert.equal(sniffed?.kind, "image");

    const out = await processImage(src, sniffed!);

    // AUTO-ORIENT: orientation 6 means the display image is portrait, so the
    // pixels must come back swapped. This assertion is what makes the cap
    // assertion meaningful — if auto-orient were dropped the result would be
    // 4096 × 2048, which is also "capped at 4096" but wrong.
    assert.ok(out.height > out.width, `auto-orient must swap axes; got ${out.width}×${out.height}`);

    // CAP: long edge sits exactly on the new ceiling, not the old 2048.
    assert.equal(Math.max(out.width, out.height), MAX_IMAGE_DIM);
    assert.equal(out.height, 4096);
    assert.equal(out.width, 2048);
    assert.notEqual(Math.max(out.width, out.height), 2048, "must not still be capped at the old 2048");

    // STRIP: three independent checks.
    await assertFullyStripped(out.buffer, "processed original");
  });

  it("the derived thumbnail and feed variant are stripped too", async () => {
    // Both derivatives are built from the PROCESSED buffer, so they inherit the
    // strip. That is an argument, not evidence — a future change could rebuild
    // either from the raw upload, which would write capture coordinates into a
    // second and third stored object. Checked, not reasoned about.
    const src = await oversizedOrientedJpeg();
    const out = await processImage(src, sniffMedia(src)!);

    const thumb = await makeThumbnail(out.buffer);
    assert.ok(Math.max(thumb.width, thumb.height) <= THUMBNAIL_DIM);
    await assertFullyStripped(thumb.buffer, "thumbnail");

    const feed = await makeFeedVariant(out.buffer);
    assert.ok(Math.max(feed.width, feed.height) <= FEED_DIM);
    await assertFullyStripped(feed.buffer, "feed variant");
  });

  it("WebP takes the same path: capped and stripped, format preserved", async () => {
    // The strip must not be a property of the JPEG encoder branch alone.
    const src = await sharp({ create: { width: 5000, height: 2500, channels: 3, background: "#c73" } })
      .withExif({ IFD0: { Copyright: SENTINEL } })
      .webp()
      .toBuffer();
    const sniffed = sniffMedia(src)!;
    assert.equal(sniffed.mime, "image/webp");

    const out = await processImage(src, sniffed);
    assert.equal(out.mime, "image/webp", "webp input must stay webp");
    assert.equal(Math.max(out.width, out.height), MAX_IMAGE_DIM);
    await assertFullyStripped(out.buffer, "processed webp");
  });

  it("a small photo is not upscaled to the new cap", async () => {
    // withoutEnlargement. Raising the ceiling must not turn a 600px upload into
    // a blurry 4096px one.
    const src = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer();
    const out = await processImage(src, sniffMedia(src)!);
    assert.equal(out.width, 600);
    assert.equal(out.height, 400);
  });
});
