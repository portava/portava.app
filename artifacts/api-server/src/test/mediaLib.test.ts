/**
 * Media libs — sniffing, EXIF/GPS stripping, thumbnails, storage-URL
 * validation, and the display-media priority resolver.
 * Run: node --import tsx/esm --test src/test/mediaLib.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  sniffMedia,
  sniffVoiceAudio,
  isoTrackHandlers,
  processImage,
  makeThumbnail,
  MAX_IMAGE_DIM,
  THUMBNAIL_DIM,
} from "../lib/mediaProcessing.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import {
  AUDIO_ONLY_M4A,
  PLAIN_MP4,
  PORTRAIT_MP4,
  FRAGMENTED_MP4,
  FASTSTART_MOV,
  VP8_WEBM,
} from "./videoProbeFixtures.js";
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

/* ===========================================================================
 * ISO-BMFF: the kind comes from the TRACKS, not the `ftyp` brand.
 *
 * Real bytes, built here rather than committed as binary fixtures: `ftyp`,
 * `mdat`, and a `moov` carrying one `trak/mdia/hdlr` per requested handler
 * type — the only boxes `isoTrackHandlers` walks.
 *
 * The defect these pin: `sniffMedia` used to answer `video/mp4` for ANY generic
 * `ftyp` brand, so an audio-only MP4 (an `.m4a` voice recording) was labelled a
 * video. See "ISO-BMFF AUDIO IS NOT VIDEO" at the foot of mediaProcessing.ts.
 * ======================================================================== */

/** One ISO-BMFF box: 32-bit size, 4-char type, payload. */
function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** `ftyp` with the given major brand (4 bytes), minor version, compatible list. */
function isoFtyp(brand: string): Buffer {
  return isoBox("ftyp", Buffer.concat([
    Buffer.from(brand, "latin1"),
    Buffer.alloc(4),
    Buffer.from(brand, "latin1"),
  ]));
}

/** `trak/mdia/hdlr` with the given handler type — `soun`, `vide`, `mdta`, … */
function isoTrak(handler: string): Buffer {
  const hdlr = isoBox("hdlr", Buffer.concat([
    Buffer.alloc(8),                  // version+flags (4), pre_defined (4)
    Buffer.from(handler, "latin1"),   // handler_type
    Buffer.alloc(12),                 // reserved
  ]));
  return isoBox("trak", isoBox("mdia", hdlr));
}

/** A structurally real ISO-BMFF file with one track per handler type. */
function isoFile(brand: string, handlers: string[]): Buffer {
  const moov = isoBox("moov", Buffer.concat([
    isoBox("mvhd", Buffer.alloc(100)),
    ...handlers.map((h) => isoTrak(h)),
  ]));
  return Buffer.concat([
    isoFtyp(brand),
    isoBox("mdat", Buffer.from("PORTAVA-SAMPLE-PAYLOAD", "latin1")),
    moov,
  ]);
}

/** `ftyp` and nothing else — the shape a 64-byte range probe sees. */
function isoFtypOnly(brand: string): Buffer {
  return Buffer.concat([isoFtyp(brand), Buffer.alloc(4)]);
}

describe("sniffMedia — ISO-BMFF audio-only is not a video", () => {
  it("an audio-only MP4 is REFUSED, not labelled video/mp4", () => {
    const m4a = isoFile("M4A ", ["soun"]);
    // The fixture must really be audio-only, or the assertion below is empty.
    assert.deepEqual(isoTrackHandlers(m4a), ["soun"]);
    assert.equal(
      sniffMedia(m4a), null,
      "audio-only bytes are not post/memory/story/postcard media — sniffMedia must refuse them",
    );
    // And they are not junk: the voice route's own sniffer admits them, which
    // is the one place audio IS admitted.
    const voice = sniffVoiceAudio(m4a);
    assert.equal(voice?.mime, "audio/mp4");
    assert.equal(voice?.ext, "m4a");
  });

  it("refusal is brand-agnostic — Android's audio-only mp42/isom too", () => {
    for (const brand of ["mp42", "isom", "mp41"]) {
      assert.equal(
        sniffMedia(isoFile(brand, ["soun"])), null,
        `audio-only with brand ${brand} must be refused; Android's MediaMuxer writes these for audio`,
      );
    }
  });

  it("a video track makes it video whatever the brand claims", () => {
    // Brand says `M4A ` (audio); the tracks say otherwise. The tracks win —
    // this is the direction that would otherwise hand a video to the audio path.
    const lying = isoFile("M4A ", ["vide", "soun"]);
    assert.equal(sniffMedia(lying)?.kind, "video");
    assert.equal(sniffMedia(lying)?.mime, "video/mp4");
    assert.equal(sniffMedia(lying)?.ext, "mp4");

    const videoOnly = isoFile("isom", ["vide"]);
    assert.equal(sniffMedia(videoOnly)?.kind, "video");
    assert.equal(sniffMedia(videoOnly)?.mime, "video/mp4");
  });

  it("only ESTABLISHED audio-only is subtracted — other track sets are unchanged", () => {
    // A metadata-only container is not something this branch can call audio,
    // so it keeps the behaviour it has always had.
    assert.equal(sniffMedia(isoFile("isom", ["mdta"]))?.mime, "video/mp4");
    assert.equal(sniffMedia(isoFile("isom", ["soun", "sbtl"]))?.mime, "video/mp4");
  });

  it("unreadable track handlers stay video/mp4 — refusing would break the 64-byte range probe", () => {
    // No `moov` in the buffer at all.
    const bare = isoFtypOnly("isom");
    assert.equal(isoTrackHandlers(bare), null, "fixture must be unreadable, or this proves nothing");
    assert.equal(
      sniffMedia(bare)?.mime, "video/mp4",
      "a buffer with no readable moov keeps today's answer; see isoAudioOnly for why",
    );

    // The real reason: routes/postcards.ts verifies a completed signed-URL
    // upload from `Range: bytes=0-63`. Even for an audio-only file, that prefix
    // cannot contain the moov — so this call site cannot refuse on it, and the
    // same path re-verifies the full object before marking the row ready.
    const audio = isoFile("M4A ", ["soun"]);
    const probe = audio.subarray(0, 64);
    assert.equal(isoTrackHandlers(probe), null);
    assert.equal(sniffMedia(probe)?.kind, "video", "the prefix cannot answer; the full buffer does");
    assert.equal(sniffMedia(audio), null, "and the full buffer refuses it");
  });

  // The synthetic buffers above isolate the rule; these are REAL ffmpeg output,
  // already in the tree for the container probe. They are the regression guard
  // that matters: the rule must refuse a genuine audio-only M4A and must not
  // cost a single real video — including the faststart MOV, whose `moov` is at
  // the front, and the fragmented MP4, whose samples are not in `moov` at all.
  it("real fixtures: every video still sniffs as video, the real audio-only M4A does not", () => {
    assert.deepEqual(isoTrackHandlers(AUDIO_ONLY_M4A), ["soun"], "fixture is genuinely audio-only");
    assert.equal(
      sniffMedia(AUDIO_ONLY_M4A), null,
      "a real AAC-in-MP4 with no video track must not be admitted as video/mp4",
    );
    assert.equal(sniffVoiceAudio(AUDIO_ONLY_M4A)?.mime, "audio/mp4", "the voice route still admits it");

    assert.equal(sniffMedia(PLAIN_MP4)?.mime, "video/mp4");
    assert.equal(sniffMedia(PORTRAIT_MP4)?.mime, "video/mp4");
    assert.equal(sniffMedia(FRAGMENTED_MP4)?.mime, "video/mp4");
    assert.equal(sniffMedia(FASTSTART_MOV)?.mime, "video/quicktime");
    // WebM never reaches the ISO-BMFF branch; included so a regression that
    // routed it there would be visible here.
    assert.equal(sniffMedia(VP8_WEBM)?.mime, "video/webm");
  });

  it("the HEIC brand branch is untouched, and QuickTime still names its container", () => {
    assert.equal(sniffMedia(isoFtypOnly("heic"))?.mime, "image/heic");
    assert.equal(sniffMedia(isoFtypOnly("mif1"))?.mime, "image/heic");
    assert.equal(sniffMedia(isoFtypOnly("qt  "))?.mime, "video/quicktime");
    assert.equal(sniffMedia(isoFile("qt  ", ["vide", "soun"]))?.mime, "video/quicktime");
    // The track rule applies to the QuickTime brand too — it is the same
    // container family and the same question. An audio-only `.mov` is refused
    // for exactly the reason an audio-only `.m4a` is.
    assert.equal(sniffMedia(isoFile("qt  ", ["soun"])), null);
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
