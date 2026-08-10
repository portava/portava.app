/**
 * Media libs — sniffing, EXIF/GPS stripping, thumbnails, storage-URL
 * validation, and the display-media priority resolver.
 * Run: node --import tsx/esm --test src/test/mediaLib.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { sniffMedia, processImage, makeThumbnail, MAX_IMAGE_DIM, THUMBNAIL_DIM } from "../lib/mediaProcessing.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { resolveDisplayMedia } from "../lib/mediaAssets.js";

const OLD_SUPABASE_URL = process.env.SUPABASE_URL;
before(() => { process.env.SUPABASE_URL = "http://sb.example.test"; });
after(() => { process.env.SUPABASE_URL = OLD_SUPABASE_URL; });

async function makeJpegWithGps(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 120, b: 60 } } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: "test", Software: "cam" },
      GPS: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" },
    } as any)
    .toBuffer();
}

describe("sniffMedia", () => {
  it("detects jpeg / png / webp / mp4 by magic numbers", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#333" } }).jpeg().toBuffer();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#333" } }).png().toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#333" } }).webp().toBuffer();
    assert.equal(sniffMedia(jpeg)?.mime, "image/jpeg");
    assert.equal(sniffMedia(png)?.mime, "image/png");
    assert.equal(sniffMedia(webp)?.mime, "image/webp");
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom....")]);
    assert.equal(sniffMedia(mp4)?.mime, "video/mp4");
    assert.equal(sniffMedia(mp4)?.kind, "video");
  });

  it("rejects junk and too-short buffers", () => {
    assert.equal(sniffMedia(Buffer.from("hello world this is not media")), null);
    assert.equal(sniffMedia(Buffer.from([1, 2, 3])), null);
  });
});

describe("processImage — the EXIF/GPS strip", () => {
  it("output has NO EXIF (GPS gone) while input had it", async () => {
    const input = await makeJpegWithGps();
    const inMeta = await sharp(input).metadata();
    assert.ok(inMeta.exif, "test precondition: input must carry EXIF");
    const out = await processImage(input, sniffMedia(input)!);
    const outMeta = await sharp(out.buffer).metadata();
    assert.equal(outMeta.exif, undefined, "EXIF (incl. GPS) must be stripped");
    assert.equal(out.mime, "image/jpeg");
    assert.equal(out.width, 800);
    assert.equal(out.height, 600);
  });

  it("caps the longest edge at MAX_IMAGE_DIM without enlarging small images", async () => {
    // Source dimensions are DERIVED from MAX_IMAGE_DIM, not hardcoded. They used
    // to be a literal 4000×2000, which was oversized against the old 2048 cap and
    // is undersized against the current 4096 one — so raising the cap turned this
    // from a cap test into a no-op that happened to fail loudly. Deriving it means
    // the next cap change cannot quietly stop exercising the resize.
    const bigW = MAX_IMAGE_DIM + 500;
    const big = await sharp({ create: { width: bigW, height: Math.round(bigW / 2), channels: 3, background: "#222" } }).jpeg().toBuffer();
    const out = await processImage(big, sniffMedia(big)!);
    assert.equal(Math.max(out.width, out.height), MAX_IMAGE_DIM);
    const small = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#222" } }).jpeg().toBuffer();
    const outSmall = await processImage(small, sniffMedia(small)!);
    assert.equal(outSmall.width, 100, "small images must not be enlarged");
  });

  it("auto-orients: EXIF orientation 6 swaps width/height and is removed", async () => {
    const rotated = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#444" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await processImage(rotated, sniffMedia(rotated)!);
    assert.equal(out.width, 200, "orientation should be baked into pixels");
    assert.equal(out.height, 300);
    const meta = await sharp(out.buffer).metadata();
    assert.ok(!meta.orientation || meta.orientation === 1, "orientation tag must be gone/normalized");
  });

  it("throws on corrupt bytes claiming to be an image", async () => {
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]);
    await assert.rejects(() => processImage(junk, { kind: "image", mime: "image/jpeg", ext: "jpg" }));
  });
});

describe("makeThumbnail", () => {
  it("produces a ≤THUMBNAIL_DIM jpeg", async () => {
    const src = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#555" } }).jpeg().toBuffer();
    const t = await makeThumbnail(src);
    assert.ok(Math.max(t.width, t.height) <= THUMBNAIL_DIM);
    assert.equal(t.mime, "image/jpeg");
  });
});

describe("appStorageUrlInfo", () => {
  const base = "http://sb.example.test/storage/v1/object/public";
  it("accepts our storage URLs (incl. transform variant + query params)", () => {
    assert.deepEqual(appStorageUrlInfo(`${base}/post-media/u1/123.jpg`), { bucket: "post-media", path: "u1/123.jpg" });
    assert.deepEqual(appStorageUrlInfo(`${base}/profile-media/avatars/u1/a.webp?width=100`), { bucket: "profile-media", path: "avatars/u1/a.webp" });
    assert.deepEqual(
      appStorageUrlInfo("http://sb.example.test/storage/v1/render/image/public/post-media/u1/x.jpg?width=400"),
      { bucket: "post-media", path: "u1/x.jpg" },
    );
  });
  it("rejects foreign origins, wrong buckets, traversal, junk", () => {
    assert.equal(appStorageUrlInfo("https://evil.example.com/storage/v1/object/public/post-media/u1/x.jpg"), null);
    assert.equal(appStorageUrlInfo(`${base}/stamp-artwork/x.png`), null, "bucket not in media allow-list");
    assert.equal(appStorageUrlInfo(`${base}/post-media/../secrets`), null);
    assert.equal(appStorageUrlInfo("not a url"), null);
    assert.equal(appStorageUrlInfo("http://sb.example.test/other/path"), null);
  });

  it("accepts bare storage paths in <bucket>/<path> format", () => {
    assert.deepEqual(
      appStorageUrlInfo("post-media/generated-visuals/event/abc123/def456/hero.webp"),
      { bucket: "post-media", path: "generated-visuals/event/abc123/def456/hero.webp" },
    );
    assert.deepEqual(
      appStorageUrlInfo("profile-media/avatars/u1/avatar.jpg"),
      { bucket: "profile-media", path: "avatars/u1/avatar.jpg" },
    );
    assert.deepEqual(
      appStorageUrlInfo("post-media/generated-visuals/trip/uuid1/uuid2/card.webp"),
      { bucket: "post-media", path: "generated-visuals/trip/uuid1/uuid2/card.webp" },
    );
  });

  it("rejects bare paths with disallowed buckets, traversal, or URL-like strings", () => {
    assert.equal(appStorageUrlInfo("stamp-artwork/some/path.png"), null, "disallowed bucket");
    assert.equal(appStorageUrlInfo("post-media/../secrets"), null, "path traversal");
    assert.equal(appStorageUrlInfo("post-media/"), null, "empty path after bucket");
    assert.equal(appStorageUrlInfo("post-media"), null, "no slash — not a valid bare path");
    assert.equal(appStorageUrlInfo("//evil.com/post-media/x.jpg"), null, "scheme-relative URL rejected");
  });
});

describe("resolveDisplayMedia", () => {
  it("authentic user media outranks provider/generated", () => {
    const r = resolveDisplayMedia(
      [
        { uri: "gen.png", source: "generated" },
        { uri: "prov.jpg", source: "provider", attribution: "Powered by X" },
        { uri: "user.jpg", source: "user" },
      ],
      { entityTitle: "Cafe", fallbackCategory: "food" },
    );
    assert.equal(r.uri, "user.jpg");
    assert.equal(r.source, "user");
    assert.equal(r.isGenerated, false);
  });

  it("generated media is always labeled isGenerated", () => {
    const r = resolveDisplayMedia([{ uri: "gen.png", source: "generated" }], { entityTitle: "Bar", fallbackCategory: "nightlife" });
    assert.equal(r.isGenerated, true);
  });

  it("NEVER returns null — empty candidates yield a designed fallback with category", () => {
    const r = resolveDisplayMedia([], { entityTitle: "Mystery Hotel", fallbackCategory: "accommodation" });
    assert.equal(r.source, "designed_fallback");
    assert.equal(r.fallbackCategory, "accommodation");
    assert.equal(r.altText, "Mystery Hotel");
  });

  it("blank/null URIs are skipped, attribution carried through", () => {
    const r = resolveDisplayMedia(
      [
        { uri: "", source: "user" },
        { uri: null, source: "official" },
        { uri: "p.jpg", source: "provider", attribution: "Powered by Foursquare" },
      ],
      { entityTitle: "Venue", fallbackCategory: "culture" },
    );
    assert.equal(r.uri, "p.jpg");
    assert.equal(r.attribution, "Powered by Foursquare");
  });
});
