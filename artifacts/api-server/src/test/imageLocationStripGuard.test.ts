/**
 * Image location-strip GUARD — every server entry point that stores or derives a
 * still from a user's bytes, fed a still that really carries location.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The EXIF/GPS strip is the fix for the audit's most severe privacy finding, and
 * it has no line of its own: sharp drops metadata on re-encode unless it is told
 * to keep it. Five fixtures that claimed to test it planted GPS under
 * `withExif({ GPS: ... })`, a key sharp 0.35.3 ignores (the GPS IFD is `IFD3`),
 * so no test in the suite had ever fed the pipeline a GPS IFD. The strip was
 * real — measured here — but the evidence for its GPS half was vacuous.
 * geotaggedImageFixtures.ts builds the input by hand and checks it before use.
 *
 * WHAT IS GUARDED, AND HOW IT GOES RED
 * ------------------------------------
 *   A. The fixtures carry a GPS IFD (6 entries), a MakerNote, XMP location,
 *      IPTC city, a comment and an APP11 payload, and the detector sees every
 *      one of them in the raw input and in a `keepMetadata()` re-encode. A
 *      detector that cannot see a leak would make B–D pass vacuously.
 *   B. Every exported still producer in lib/mediaProcessing.ts, over JPEG, PNG
 *      and WebP, from the RAW upload and from the processed buffer: no EXIF,
 *      no XMP, no IPTC, no comment, no orientation tag, no planted sentinel or
 *      coordinate, and no container segment outside a strict allowlist.
 *   C. The set of producers is CLOSED: an exported `Promise<ProcessedImage>`
 *      function that is not in PRODUCERS fails here, as does a new production
 *      file importing sharp, or any production call that keeps or re-attaches
 *      metadata (`keepMetadata`, `withMetadata`, `keepExif`, `withExif`,
 *      `withExifMerge`, `keepXmp`, `withXmp`, `keepGainMap`, `withGainMap`).
 *      The same holds for the two other renderers that re-encode stored user
 *      bytes or provider imagery: the public OG card (lib/ogImage.ts) and the
 *      place-visual derivatives (lib/visuals/derivatives.ts).
 *   D. The ROUTES, over HTTP, against a fake Storage that records every write:
 *      POST /media/upload (original, thumbnail, feed variant — the transport
 *      memories, stories, telegraph media and the message-media assemble all
 *      store through), POST /postcards/:id/media/:mediaId/complete (the bytes
 *      the client PUT through the signed URL are what /complete reads),
 *      POST /me/avatar/upload, POST /me/cover/upload, and both video-poster
 *      routes. Each stored object must be leak-free, and each route must have
 *      stored something — a route that failed before writing is red, not clean.
 *
 *   E. The DETECTOR the media worker and audit:storage-exif rely on
 *      (lib/exifFacts.ts) reads a WebP EXIF chunk as libwebp writes it, with
 *      the `Exif\0\0` header in front of the TIFF block. It used to report such
 *      a still as carrying no EXIF at all — so the worker's "a stored still with
 *      a GPS IFD is refused" passed a geotagged WebP.
 *
 * NON-VACUOUSNESS — the mutants run against this file are listed in
 * docs/architecture/census-media.md §52 (`.keepExif()` / `.keepXmp()` /
 * `.keepMetadata()` in each producer, each route storing its raw body).
 *
 * Run (HTTP — outside a sandbox that forbids listen(2)):
 *   node --import tsx/esm --test src/test/imageLocationStripGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import {
  processImage,
  makeThumbnail,
  makeFeedVariant,
  makeVideoPoster,
  sniffMedia,
  MAX_IMAGE_DIM,
} from "../lib/mediaProcessing.js";
import { POSTER_MAX_DIM } from "../lib/postcardMediaTransport.js";
import { renderOgImagePng } from "../lib/ogImage.js";
import { buildDerivatives } from "../lib/visuals/derivatives.js";
import { exifFactsFrom } from "../lib/exifFacts.js";
import { processStoredMediaAsset } from "../lib/media/mediaProcessingWorker.js";
import postsRouter from "../routes/posts.js";
import postcardsRouter from "../routes/postcards.js";
import profileRouter from "../routes/profile.js";
import postcardTransportRouter from "../routes/postcardMediaTransport.js";
import videoPosterRouter, { _setPosterAssetRetryDelay } from "../routes/mediaVideoPoster.js";
import {
  fixtureCarries,
  geotagged,
  locationLeaks,
  type StillFormat,
} from "./geotaggedImageFixtures.js";

const FORMATS: StillFormat[] = ["jpeg", "png", "webp"];
const MIME: Record<StillFormat, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/* ───────────────────────────── A. the fixtures ───────────────────────────── */

describe("A. the geotagged fixtures are what they claim, and the detector can see them", () => {
  for (const format of FORMATS) {
    it(`${format}: carries a GPS IFD, MakerNote, XMP (and IPTC for JPEG), and every carrier is detected`, async () => {
      const raw = await geotagged(format);
      await fixtureCarries(raw, format); // throws on a vacuous fixture
      const leaks = await locationLeaks(raw);
      for (const needle of ["EXIF block present", "XMP present", "GPS IFD: true", "PORTAVA_GPS_IFD_SENTINEL", "PORTAVA_MAKERNOTE_SENTINEL", "PORTAVA_XMP_LOCATION_SENTINEL"]) {
        assert.ok(leaks.some((l) => l.includes(needle)), `${format}: the detector must report "${needle}" on the raw fixture; got ${JSON.stringify(leaks)}`);
      }
    });

    it(`${format}: a re-encode told to KEEP metadata is reported as leaking (the detector is not blind to sharp's own output)`, async () => {
      const raw = await geotagged(format);
      const kept = await sharp(raw).keepMetadata().toFormat(format).toBuffer();
      const leaks = await locationLeaks(kept);
      assert.ok(leaks.some((l) => l.includes("GPS IFD: true")), `${format}: kept GPS IFD must be reported; got ${JSON.stringify(leaks)}`);
      assert.ok(leaks.some((l) => l.includes("XMP")), `${format}: kept XMP must be reported; got ${JSON.stringify(leaks)}`);
    });
  }
});

/* ─────────────────────────── B. every producer ──────────────────────────── */

/**
 * Every exported still producer in lib/mediaProcessing.ts, with each way a
 * route calls it. C proves this list is complete.
 */
const PRODUCERS: Record<string, Array<{ call: string; run: (input: Buffer) => Promise<Buffer> }>> = {
  processImage: [
    { call: "stored original (MAX_IMAGE_DIM) — /media/upload, postcard /complete", run: async (b) => (await processImage(b, sniffMedia(b)!)).buffer },
    { call: "avatar (1024) — /me/avatar/upload", run: async (b) => (await processImage(b, sniffMedia(b)!, 1024)).buffer },
    { call: "cover (2048) — /me/cover/upload", run: async (b) => (await processImage(b, sniffMedia(b)!, 2048)).buffer },
  ],
  makeThumbnail: [{ call: "thumbnail", run: async (b) => (await makeThumbnail(b)).buffer }],
  makeFeedVariant: [{ call: "feed variant (and backfillFeedVariants)", run: async (b) => (await makeFeedVariant(b)).buffer }],
  makeVideoPoster: [{ call: "video poster — both poster routes", run: async (b) => (await makeVideoPoster(b, POSTER_MAX_DIM)).buffer }],
};

/** Renderers outside lib/mediaProcessing.ts that re-encode stored or fetched images. */
const OTHER_RENDERERS: Array<{ name: string; run: (input: Buffer) => Promise<Buffer[]> }> = [
  { name: "lib/ogImage.ts renderOgImagePng (public OG card from a stored cover)", run: async (b) => [await renderOgImagePng(b)] },
  { name: "lib/visuals/derivatives.ts buildDerivatives (place visuals)", run: async (b) => (await buildDerivatives(b)).map((d) => d.buffer) },
];

describe("B. every still producer strips every location carrier", () => {
  for (const format of FORMATS) {
    for (const [fn, calls] of Object.entries(PRODUCERS)) {
      for (const { call, run } of calls) {
        it(`${fn} · ${call} · ${format}, from the RAW upload`, async () => {
          const raw = await geotagged(format);
          await fixtureCarries(raw, format);
          assert.deepEqual(await locationLeaks(await run(raw)), [], `${fn} (${call}) kept location metadata from a ${format}`);
        });
      }
    }

    for (const { name, run } of OTHER_RENDERERS) {
      it(`${name} · ${format}, from the RAW bytes`, async () => {
        const raw = await geotagged(format);
        for (const out of await run(raw)) assert.deepEqual(await locationLeaks(out), [], `${name} kept location metadata from a ${format}`);
      });
    }

    it(`${format}: the derivatives a route builds from the PROCESSED original are clean too`, async () => {
      const raw = await geotagged(format);
      const original = (await processImage(raw, sniffMedia(raw)!)).buffer;
      assert.deepEqual(await locationLeaks(await (await makeThumbnail(original)).buffer), []);
      assert.deepEqual(await locationLeaks(await (await makeFeedVariant(original)).buffer), []);
    });
  }

  it("the strip does not cost the orientation: a 640×480 orientation-6 JPEG is stored 480×640 and capped at MAX_IMAGE_DIM", async () => {
    const raw = await geotagged("jpeg");
    const out = await processImage(raw, sniffMedia(raw)!);
    assert.deepEqual([out.width, out.height], [480, 640]);
    assert.ok(Math.max(out.width, out.height) <= MAX_IMAGE_DIM);
  });
});

/* ───────────────────────── C. the set is closed ─────────────────────────── */

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "__tests__" || name === "node_modules") continue;
      out.push(...productionFiles(p));
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Every production importer of sharp, and why its output needs no producer entry. */
const SHARP_IMPORTERS: Record<string, string> = {
  "lib/mediaProcessing.ts": "the user-upload producers — every one is in PRODUCERS (B, D)",
  "lib/visuals/derivatives.ts": "place visuals from an image provider, not user bytes; plain re-encode, nothing kept",
  "lib/stamps/composition/rasterize.ts": "server-composed stamp SVG, not user bytes",
  "scripts/backfillFeedVariants.ts": "reads metadata only; its variants come from makeFeedVariant",
  "lib/ogImage.ts": "public OG card re-encoded from a stored cover (user bytes) — in B (OTHER_RENDERERS)",
  "routes/passport.ts": "server-composed passport / stamp OG SVG, not user bytes",
};

describe("C. the producer set and the sharp surface are closed", () => {
  it("every exported Promise<ProcessedImage> producer in lib/mediaProcessing.ts is exercised by B", () => {
    const text = readFileSync(path.join(SRC, "lib/mediaProcessing.ts"), "utf8");
    const exported = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:\s*Promise<ProcessedImage>/g)].map((m) => m[1]!);
    const arrow = [...text.matchAll(/export\s+const\s+(\w+)\s*(?::[^=]*)?=\s*async\b/g)].map((m) => m[1]!);
    assert.ok(exported.includes("processImage") && exported.includes("makeVideoPoster"), `the scan must find the producers it guards; found ${JSON.stringify(exported)}`);
    assert.deepEqual([...exported, ...arrow].sort(), Object.keys(PRODUCERS).sort(),
      "a still producer was added to lib/mediaProcessing.ts without a location-strip check: register it in PRODUCERS (and its route in D)");
  });

  it("every production importer of sharp is classified", () => {
    const importers = productionFiles(SRC)
      .filter((f) => /from\s+["']sharp["']|require\(\s*["']sharp["']\s*\)|import\(\s*["']sharp["']\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(importers, Object.keys(SHARP_IMPORTERS).sort(),
      "a production file started (or stopped) importing sharp: classify it in SHARP_IMPORTERS, and if it stores user bytes, put it through B and D");
  });

  it("no production code keeps or re-attaches image metadata", () => {
    const KEEP = /\.(keepMetadata|withMetadata|keepExif|withExif|withExifMerge|keepXmp|withXmp|keepGainMap|withGainMap)\s*\(/;
    const hits: string[] = [];
    for (const f of productionFiles(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (KEEP.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(hits, [], "a metadata-keeping sharp call in production code would store capture location");
  });

  it("no test fixture plants GPS under `GPS:`, a key sharp ignores (the GPS IFD is `IFD3`)", () => {
    const testFiles: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); }
        else if (/\.(test\.)?(ts|tsx|mts)$/.test(name)) testFiles.push(p);
      }
    };
    walk(SRC);
    const hits: string[] = [];
    for (const f of testFiles) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//")) return;
        if (/\bGPS\s*:\s*\{\s*GPS/.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, [], "a GPS fixture written this way plants NO GPS IFD and makes its test vacuous — use IFD3, or geotaggedImageFixtures.ts");
  });
});

/* ─────────────────────────── D. the routes ──────────────────────────────── */

const TOKEN = "location-strip-guard-token";
const USER = "e0000000-0000-4000-a000-000000000001";
const POST_ID = "e0000000-0000-4000-a000-0000000000a1";
const IMAGE_SLOT = "e0000000-0000-4000-a000-0000000000b1";
const VIDEO_SLOT = "e0000000-0000-4000-a000-0000000000b2";
const IMAGE_SLOT_PATH = `${USER}/${POST_ID}/${IMAGE_SLOT}.jpg`;
const VIDEO_SLOT_PATH = `${USER}/${POST_ID}/${VIDEO_SLOT}.mp4`;

interface StoredWrite { bucket: string; path: string; buf: Buffer }

/** In-memory Supabase: rows by table, objects by bucket; every Storage write recorded. */
function makeFake() {
  const objects = new Map<string, Buffer>(); // `${bucket}/${path}`
  const writes: StoredWrite[] = [];
  const db: Record<string, any[]> = {
    feature_flags: [],
    post_media: [
      { id: IMAGE_SLOT, user_id: USER, post_id: POST_ID, storage_path: IMAGE_SLOT_PATH, storage_bucket: "post-media", media_type: "image", file_size_bytes: 1000, processing_status: "pending" },
      { id: VIDEO_SLOT, user_id: USER, post_id: POST_ID, storage_path: VIDEO_SLOT_PATH, storage_bucket: "post-media", media_type: "video", file_size_bytes: 1000, processing_status: "pending" },
    ],
  };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pending: any = null;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select() { return b; },
      insert(row: any) { pending = Array.isArray(row) ? row[0] : row; return b; },
      upsert(row: any) { pending = Array.isArray(row) ? row[0] : row; return b; },
      update() { return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push((r) => String(r[col]) === String(val)); return b; },
      neq(col: string, val: any) { filters.push((r) => String(r[col]) !== String(val)); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return b; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      not() { return b; }, or() { return b; }, filter() { return b; }, match() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; }, returns() { return b; },
      maybeSingle() { return Promise.resolve({ data: pending ? { id: "new-row-id", ...pending } : rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: pending ? { id: "new-row-id", ...pending } : rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: pending ? [] : rows(), error: null, count: rows().length }).then(onF, onR); },
    };
    return b;
  }

  const client: any = {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async (t: string) => (t === TOKEN
        ? { data: { user: { id: USER, app_metadata: {}, user_metadata: {} } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } }),
    },
    storage: {
      async createBucket() { return { data: null, error: { message: "already exists" } }; },
      from(bucket: string) {
        return {
          async upload(p: string, buf: Buffer, opts: any) {
            const key = `${bucket}/${p}`;
            if (objects.has(key) && !opts?.upsert) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
            objects.set(key, Buffer.from(buf));
            writes.push({ bucket, path: p, buf: Buffer.from(buf) });
            return { data: { path: p }, error: null };
          },
          async download(p: string) {
            const buf = objects.get(`${bucket}/${p}`);
            if (!buf) return { data: null, error: { message: "Object not found" } };
            return { data: new Blob([buf]), error: null };
          },
          async list(folder: string) {
            const prefix = `${bucket}/${folder}/`;
            const data = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k.slice(prefix.length) }));
            return { data, error: null };
          },
          async remove(paths: string[]) { for (const p of paths) objects.delete(`${bucket}/${p}`); return { data: paths, error: null }; },
          async createSignedUrl(p: string) { return { data: { signedUrl: `https://storage.test/${bucket}/${p}` }, error: null }; },
          async createSignedUploadUrl(p: string) { return { data: { signedUrl: `https://storage.test/upload/${bucket}/${p}`, path: p, token: "t" }, error: null }; },
          getPublicUrl(p: string) { return { data: { publicUrl: `https://storage.test/public/${bucket}/${p}` } }; },
        };
      },
    },
    _objects: objects,
    _writes: writes,
  };
  return client;
}

describe("D. every upload route stores location-free bytes", () => {
  let server: http.Server;
  let base = "";
  let fake: ReturnType<typeof makeFake>;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", postsRouter);
    app.use("/api", postcardsRouter);
    app.use("/api", profileRouter);
    app.use("/api", postcardTransportRouter);
    app.use("/api", videoPosterRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    _setPosterAssetRetryDelay(0);
  });

  after(async () => {
    _setPosterAssetRetryDelay(null);
    _setTestClient(null, false);
    _setTestServiceClient(null as any);
    await new Promise<void>((r) => server.close(() => r()));
  });

  function install() {
    fake = makeFake();
    _setTestClient(fake, true);
    _setTestServiceClient(fake);
    _resetRateLimit();
    return fake;
  }

  function send(method: string, p: string, body: Buffer, contentType: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(p, base);
      const r = http.request({
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, agent: false,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": contentType, "content-length": String(body.length) },
      }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
      });
      r.on("error", reject);
      r.write(body);
      r.end();
    });
  }

  /** Every object the route wrote under `prefix` must be leak-free; at least `min` must exist. */
  async function assertStoredClean(prefix: string, min: number, what: string) {
    const written = fake._writes.filter((w: StoredWrite) => `${w.bucket}/${w.path}`.startsWith(prefix));
    assert.ok(written.length >= min, `${what}: expected at least ${min} stored object(s) under ${prefix}, got ${written.map((w: StoredWrite) => w.path).join(", ") || "none"}`);
    for (const w of written) {
      assert.deepEqual(await locationLeaks(w.buf), [], `${what}: stored ${w.bucket}/${w.path} carries location metadata`);
    }
  }

  for (const format of FORMATS) {
    it(`POST /media/upload (${format}): the original, the thumbnail and the feed variant`, async () => {
      install();
      const raw = await geotagged(format);
      await fixtureCarries(raw, format);
      const r = await send("POST", "/api/media/upload", raw, MIME[format]);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await assertStoredClean(`post-media/${USER}/`, 3, "/media/upload");
    });

    it(`POST /me/avatar/upload and /me/cover/upload (${format})`, async () => {
      install();
      const raw = await geotagged(format);
      const a = await send("POST", "/api/me/avatar/upload", raw, MIME[format]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      await assertStoredClean("profile-media/avatars/", 1, "/me/avatar/upload");
      const c = await send("POST", "/api/me/cover/upload", raw, MIME[format]);
      assert.equal(c.status, 201, JSON.stringify(c.body));
      await assertStoredClean("profile-media/covers/", 1, "/me/cover/upload");
    });
  }

  it("POST /postcards/:id/media/:mediaId/complete: the object the signed-URL PUT left behind is replaced by a clean one, and its feed variant is clean", async () => {
    install();
    const raw = await geotagged("jpeg");
    // What the client's PUT to the signed upload URL stored: the raw, geotagged bytes.
    fake._objects.set(`post-media/${IMAGE_SLOT_PATH}`, raw);
    const r = await send("POST", `/api/postcards/${POST_ID}/media/${IMAGE_SLOT}/complete`,
      Buffer.from(JSON.stringify({ mimeType: "image/jpeg", fileSizeBytes: raw.length })), "application/json");
    // The bytes are the subject here, not the row update that follows them.
    assert.ok(r.status < 500 || fake._writes.length > 0, `complete failed before storing: ${JSON.stringify(r.body)}`);
    await assertStoredClean(`post-media/${IMAGE_SLOT_PATH}`, 2, "/complete");
    const final = fake._objects.get(`post-media/${IMAGE_SLOT_PATH}`)!;
    assert.notDeepEqual(final, raw, "the raw upload must not be what remains at the slot's path");
    assert.deepEqual(await locationLeaks(final), [], "the object a viewer is signed after /complete must be location-free");
  });

  it("POST /postcards/:id/media/:mediaId/poster: the stored poster is clean", async () => {
    install();
    const raw = await geotagged("jpeg");
    const r = await send("POST", `/api/postcards/${POST_ID}/media/${VIDEO_SLOT}/poster`, raw, "image/jpeg");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await assertStoredClean(`post-media/${VIDEO_SLOT_PATH}`, 1, "postcard poster");
  });

  it("POST /media/upload/poster: the stored poster is clean", async () => {
    install();
    const videoPath = `${USER}/${Date.now() - 1000}.mp4`;
    fake._objects.set(`post-media/${videoPath}`, Buffer.from("not inspected by this route"));
    const raw = await geotagged("jpeg");
    const r = await send("POST", `/api/media/upload/poster?path=${encodeURIComponent(videoPath)}`, raw, "image/jpeg");
    assert.ok(fake._writes.length > 0, `the poster route stored nothing: ${r.status} ${JSON.stringify(r.body)}`);
    await assertStoredClean(`post-media/${videoPath}.poster`, 1, "general poster");
  });
});

/* ─────────────────────────── E. the detector ────────────────────────────── */

describe("E. lib/exifFacts reads a WebP EXIF chunk the way libwebp writes it", () => {
  async function sharpWrittenGeotaggedWebp(): Promise<Buffer> {
    // sharp's own writer: libwebp puts "Exif\0\0" in front of the TIFF block.
    return sharp({ create: { width: 64, height: 48, channels: 3, background: "#246" } })
      .withExif({ IFD0: { Copyright: "x" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "16/1 3/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "108/1 12/1 0/1" } })
      .webp()
      .toBuffer();
  }

  it("a sharp-written WebP with a GPS IFD is reported as carrying one", async () => {
    const webp = await sharpWrittenGeotaggedWebp();
    assert.ok((await sharp(webp).metadata()).exif, "precondition: sharp sees the EXIF it wrote");
    const facts = exifFactsFrom(webp);
    assert.equal(facts?.hasExif, true, "a WebP EXIF chunk must not read as 'no EXIF' because of its Exif\\0\\0 header");
    assert.equal(facts?.hasGpsIfd, true, "…and its GPS IFD must be seen");
  });

  it("the media worker therefore refuses a stored geotagged WebP instead of publishing it", async () => {
    const webp = await sharpWrittenGeotaggedWebp();
    const sc = { storage: { from: () => ({ download: async () => ({ data: new Blob([webp]), error: null }) }) } };
    const outcome = await processStoredMediaAsset(sc, {
      id: "a1", storage_bucket: "post-media", storage_path: `${USER}/1.webp`, media_type: "image",
      duration_ms: null, thumbnail_path: null, thumbnail_url: null,
    });
    assert.deepEqual(outcome, { ok: false, permanent: true, message: "The stored image still carries GPS metadata" });
  });

  it("CONTROL: a JPEG APP1 and a header-less WebP chunk read exactly as before", async () => {
    assert.equal(exifFactsFrom(await geotagged("jpeg"))?.gpsEntryCount, 6);
    assert.equal(exifFactsFrom(await geotagged("webp"))?.gpsEntryCount, 6);
    assert.equal(exifFactsFrom(await geotagged("png"))?.gpsEntryCount, 6);
  });
});
