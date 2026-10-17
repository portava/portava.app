import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { encodeImageVariants } from "../lib/media/imageVariants/encoder.js";
import { encodeImageVariantsIsolated } from "../lib/media/imageVariants/isolatedEncoder.js";
import { IMAGE_VARIANTS_LIMITS } from "../lib/media/imageVariants/contracts.js";

const sentinel = "IMAGE_VARIANTS_PRIVATE_SENTINEL";
test("real isolated Sharp emits oriented, stripped JPEG/WebP/AVIF responsive bytes without modifying the source", async () => {
  const input = await sharp({ create: { width: 1800, height: 900, channels: 3, background: "#c43" } })
    .withExif({ IFD0: { Copyright: sentinel }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const original = Buffer.from(input);
  assert.equal((await sharp(input).metadata()).orientation, 6);
  assert.equal(input.includes(Buffer.from(sentinel)), true);
  const result = await encodeImageVariantsIsolated(input, new AbortController().signal);
  assert.deepEqual(input, original);
  assert.equal(result.manifest.sourceSha256, createHash("sha256").update(original).digest("hex"));
  assert.match(result.manifest.phash, /^[a-f0-9]{16}$/);
  assert.deepEqual([result.manifest.width, result.manifest.height], [900, 1800]);
  assert.equal(Object.keys(result.buffers).length, 8);
  for (const [name, bytes] of Object.entries(result.buffers)) {
    const metadata = await sharp(bytes).metadata();
    const expected = result.manifest.files[name];
    const bound = name === "thumb.jpg" ? 400 : name === "feed.jpg" ? 1500 : Number(name.match(/\d+/)![0]);
    assert.deepEqual([metadata.width, metadata.height], [Math.round(bound / 2), bound], name);
    assert.equal(metadata.format, name.endsWith(".avif") ? "heif" : name.endsWith(".webp") ? "webp" : "jpeg");
    if (name.endsWith(".avif")) assert.equal(metadata.compression, "av1");
    for (const key of ["exif", "xmp", "iptc", "icc", "orientation"] as const) assert.equal(metadata[key], undefined, `${name}: ${key}`);
    assert.equal(bytes.includes(Buffer.from(sentinel)), false, name);
    assert.equal(bytes.includes(Buffer.from("Exif\0\0")), false, name);
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    const decoded = await sharp(bytes).raw().toBuffer();
    assert.ok(decoded.length > 0);
  }
});

test("real Sharp preserves transparent WebP/AVIF, never enlarges, and deterministically hashes", async () => {
  const input = await sharp({ create: { width: 60, height: 30, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
  const first = await encodeImageVariants(input);
  const second = await encodeImageVariants(input);
  assert.deepEqual(first.manifest, second.manifest);
  for (const [name, buffer] of Object.entries(first.buffers)) {
    const metadata = await sharp(buffer).metadata();
    assert.deepEqual([metadata.width, metadata.height], [60, 30]);
    if (!name.endsWith(".jpg")) assert.equal(metadata.hasAlpha, true);
  }
});

test("decoder rejects corrupt, oversized, animated and unsupported inputs", async () => {
  await assert.rejects(encodeImageVariants(Buffer.from([255, 216, 255, 1])));
  await assert.rejects(encodeImageVariants(Buffer.alloc(IMAGE_VARIANTS_LIMITS.inputBytes + 1)));
  const big = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(encodeImageVariants(big), /pixel limit|dimensions/i);
  const pixels = Buffer.concat([Buffer.alloc(4 * 4 * 3, 30), Buffer.alloc(4 * 4 * 3, 180)]);
  const animation = await sharp(pixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).webp({ loop: 0, delay: [10, 10] }).toBuffer();
  assert.equal((await sharp(animation).metadata()).pages, 2);
  await assert.rejects(encodeImageVariants(animation), /frames/);
  const svg = Buffer.from('<svg width="3" height="3" xmlns="http://www.w3.org/2000/svg"/>');
  await assert.rejects(encodeImageVariants(svg), /unsupported/);
});

test("isolated native work is killed on timeout and pre-aborted jobs never start", async () => {
  const input = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(encodeImageVariantsIsolated(input, new AbortController().signal, { timeoutMs: 1 }), /cancelled/);
  await assert.rejects(encodeImageVariantsIsolated(input, AbortSignal.abort()));
});
