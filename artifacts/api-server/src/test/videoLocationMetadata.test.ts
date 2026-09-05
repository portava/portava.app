/**
 * Video location metadata — the container-level counterpart of the EXIF/GPS
 * strip that images already get.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * Images are re-encoded through sharp, which drops EXIF including GPS. Video
 * was stored exactly as received, so `moov/udta/©xyz` (iPhone and Android
 * both write it) and Apple's `com.apple.quicktime.location.ISO6709` key
 * travelled inside every stored MOV/MP4 and reached every authorized viewer —
 * the app's location-privacy model held for stills and silently did not hold
 * for video.
 *
 * Every assertion below is written so it can only pass for the right reason:
 * each case first proves the FIXTURE carries the coordinates (so a test that
 * stopped building a geotagged file would fail rather than pass vacuously),
 * then proves the stored bytes do not.
 *
 * Run: node --import tsx/esm --test src/test/videoLocationMetadata.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import postsRouter from "../routes/posts.js";
import { sniffMedia } from "../lib/mediaProcessing.js";
import {
  stripVideoLocationMetadata,
  scanForLocationMarkers,
  scanForMatroskaLocationTags,
} from "../lib/videoMetadata.js";
import {
  FIXTURE_ISO6709,
  mp4WithLocation,
  webmWithLocationTag,
  webmWithoutLocationTag,
} from "./videoFixtures.js";

const TOKEN = "video-location-token";
const USER_ID = "d0000000-0000-4000-a000-0000000000f1";

function sniffOrThrow(buf: Buffer) {
  const s = sniffMedia(buf);
  assert.ok(s, "fixture must be recognised by sniffMedia");
  return s;
}

/** Latin1 needle search — `©` is one byte (0xA9), not UTF-8's two. */
function hasBytes(buf: Buffer, needle: string): boolean {
  return buf.includes(Buffer.from(needle, "latin1"));
}

// ── The scrubber itself ───────────────────────────────────────────────────────

describe("stripVideoLocationMetadata — MP4/MOV", () => {
  it("removes ©xyz and the Apple location meta box, and zeroes the coordinates", () => {
    const original = mp4WithLocation();

    // The fixture must actually be geotagged, or nothing below means anything.
    assert.ok(hasBytes(original, "©xyz"), "fixture must carry a ©xyz box");
    assert.ok(hasBytes(original, FIXTURE_ISO6709), "fixture must carry the coordinates");
    assert.ok(
      hasBytes(original, "com.apple.quicktime.location.ISO6709"),
      "fixture must carry the Apple location key",
    );
    assert.deepEqual(
      scanForLocationMarkers(original).sort(),
      ["com.apple.quicktime.location", "©xyz"].sort(),
      "the marker scan must see the metadata before it is stripped",
    );

    const buf = Buffer.from(original);
    const result = stripVideoLocationMetadata(buf, sniffOrThrow(buf));
    assert.equal(result.ok, true, "a geotagged MP4 must be scrubbed, not refused");
    if (!result.ok) return;

    assert.ok(result.stripped.includes("©xyz"), "©xyz must be reported as stripped");
    assert.ok(
      result.stripped.some((s) => s.startsWith("meta(")),
      "the Apple location meta box must be reported as stripped",
    );

    // The bytes are GONE, not merely unreferenced.
    assert.equal(hasBytes(result.buffer, FIXTURE_ISO6709), false, "coordinates must be erased");
    assert.equal(hasBytes(result.buffer, "©xyz"), false, "the ©xyz box type must be gone");
    assert.equal(
      hasBytes(result.buffer, "com.apple.quicktime.location.ISO6709"),
      false,
      "the Apple location key must be gone",
    );
    assert.deepEqual(scanForLocationMarkers(result.buffer), [], "no marker may survive");
  });

  it("is length-preserving and leaves the media payload byte-identical", () => {
    // WHY THIS MATTERS: stco/co64 hold ABSOLUTE file offsets into mdat. Deleting
    // a box shifts every later byte and produces a file that parses and does not
    // play. The scrub must overwrite in place, never resize.
    const original = mp4WithLocation();
    const buf = Buffer.from(original);
    const result = stripVideoLocationMetadata(buf, sniffOrThrow(buf));
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.buffer.length, original.length, "the file size must not change");
    const marker = Buffer.from("PORTAVA-SAMPLE-VIDEO-PAYLOAD-DO-NOT-TOUCH", "latin1");
    const at = original.indexOf(marker);
    assert.ok(at > 0, "fixture must contain the mdat marker");
    assert.equal(
      result.buffer.subarray(at, at + marker.length).equals(marker),
      true,
      "mdat payload must be untouched at the same offset",
    );
    // ftyp is the first box and must be unchanged.
    assert.equal(result.buffer.subarray(0, 16).equals(original.subarray(0, 16)), true);
    // Neutralised boxes become `free` padding, which demuxers skip.
    assert.ok(hasBytes(result.buffer, "free"), "the removed boxes must become `free` padding");
  });

  it("leaves non-location metadata alone (targeted, not a blanket wipe)", () => {
    const buf = mp4WithLocation();
    const result = stripVideoLocationMetadata(buf, sniffOrThrow(buf));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(hasBytes(result.buffer, "holiday clip"), "the ©nam title must survive");
  });

  it("is a no-op on a video with no location metadata", () => {
    const buf = mp4WithLocation({ xyz: false, appleMeta: false });
    const before = Buffer.from(buf);
    const result = stripVideoLocationMetadata(buf, sniffOrThrow(buf));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.stripped, [], "nothing should be reported stripped");
    assert.equal(result.buffer.equals(before), true, "bytes must be untouched");
  });

  it("tolerates a truncated container instead of throwing", () => {
    // The postcard transport verifies a 64-byte Range read; a header-only stub
    // must degrade to "nothing to strip", not an exception.
    const head = Buffer.alloc(64);
    head.writeUInt32BE(32, 0);
    head.write("ftypisom", 4, "ascii");
    const result = stripVideoLocationMetadata(head, sniffOrThrow(head));
    assert.equal(result.ok, true);
  });
});

describe("stripVideoLocationMetadata — WebM/Matroska is fail-closed", () => {
  it("refuses a webm carrying geo SimpleTags (no EBML rewriter in this tier)", () => {
    const buf = webmWithLocationTag();
    assert.deepEqual(
      scanForMatroskaLocationTags(buf).sort(),
      ["LATITUDE", "LONGITUDE"],
      "fixture must carry geo tags",
    );
    const result = stripVideoLocationMetadata(buf, sniffOrThrow(buf));
    assert.equal(result.ok, false, "a geotagged webm must be REFUSED, never stored");
    if (result.ok) return;
    assert.equal(result.failure.code, "invalid_payload");
    assert.match(result.failure.message, /location metadata/i);
  });

  it("accepts a webm with no geo tag", () => {
    const buf = webmWithoutLocationTag();
    const result = stripVideoLocationMetadata(buf, sniffOrThrow(buf));
    assert.equal(result.ok, true, "an ordinary webm must still upload");
  });
});

// ── POST /api/media/upload (bytes-through-the-server transport) ───────────────

function makeClient() {
  const uploads: Array<{ path: string; buf: Buffer; contentType: string }> = [];
  function builder() {
    const b: any = {
      select() { return b; }, insert() { return b; }, update() { return b; },
      eq() { return b; }, neq() { return b; }, is() { return b; }, not() { return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      single() { return Promise.resolve({ data: null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
    };
    return b;
  }
  return {
    from: builder,
    storage: {
      from() {
        return {
          async upload(path: string, buf: Buffer, opts: any) {
            uploads.push({ path, buf, contentType: opts?.contentType });
            return { data: { path }, error: null };
          },
          getPublicUrl(path: string) { return { data: { publicUrl: `https://cdn.test/${path}` } }; },
          async remove(paths: string[]) { return { data: paths, error: null }; },
          async download() { return { data: null, error: { message: "not implemented" } }; },
        };
      },
    },
    auth: {
      getUser: async (t: string) => t === TOKEN
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    _uploads: uploads,
  } as any;
}

let server: http.Server;
let base: string;

function rawReq(path: string, body: Buffer, contentType: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": contentType,
        "content-length": String(body.length),
      },
    }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let p: any; try { p = JSON.parse(raw); } catch { p = raw; }
        resolve({ status: res.statusCode ?? 0, body: p });
      });
    });
    r.on("error", reject);
    r.write(body);
    r.end();
  });
}

before(() => {
  const app = express();
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", postsRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((r) => server.close(() => r())));

describe("POST /api/media/upload — video location metadata never reaches storage", () => {
  it("stores a geotagged MP4 with its coordinates removed", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const geotagged = mp4WithLocation();
    assert.ok(hasBytes(geotagged, FIXTURE_ISO6709), "the uploaded fixture must be geotagged");

    const r = await rawReq("/api/media/upload", geotagged, "video/mp4");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(client._uploads.length, 1, "only the video object is stored");

    const stored = client._uploads[0].buf;
    assert.equal(
      hasBytes(stored, FIXTURE_ISO6709),
      false,
      "stored video must NOT carry the capture coordinates",
    );
    assert.equal(hasBytes(stored, "©xyz"), false, "stored video must NOT carry a ©xyz box");
    assert.deepEqual(scanForLocationMarkers(stored), [], "no location marker may reach storage");
    assert.equal(stored.length, geotagged.length, "the stored video must not be resized");
  });

  it("refuses a geotagged WebM rather than storing it", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await rawReq("/api/media/upload", webmWithLocationTag(), "video/webm");
    assert.equal(r.body.error, "invalid_payload", JSON.stringify(r.body));
    assert.equal(client._uploads.length, 0, "nothing may be stored when the scrub cannot run");
  });
});
