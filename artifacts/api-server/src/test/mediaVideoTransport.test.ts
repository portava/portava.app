/**
 * Media §37 — the video pipeline's server half: duration + display size read
 * from the container (MD276), a poster for every postcard video (MD275), and a
 * resumable part transport for the postcard slot (MD281, server side).
 *
 * The probe is tested against REAL muxer output (src/test/videoProbeFixtures.ts:
 * ffmpeg 6.0, recorded with ffmpeg's own reading of each file), because a probe
 * that agrees only with hand-built boxes proves agreement with its author.
 *
 * Run: node --import tsx/esm --test src/test/mediaVideoTransport.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import { authorizeMediaAccess } from "../lib/mediaAccess.js";
import { probeVideoContainer, probedDurationSeconds, resolveStoredDuration } from "../lib/videoProbe.js";
import {
  RESUMABLE_CHUNK_BYTES,
  partCountFor,
  partPathFor,
  partSizeFor,
  summarizeParts,
} from "../lib/postcardMediaTransport.js";
import { admissiblePosterPath, derivedPosterBase, posterPathFor } from "../lib/mediaPosterPath.js";
import postsRouter from "../routes/posts.js";
import postcardsRouter from "../routes/postcards.js";
import transportRouter from "../routes/postcardMediaTransport.js";
import {
  AUDIO_ONLY_M4A,
  FASTSTART_MOV,
  FRAGMENTED_MP4,
  PLAIN_MP4,
  PORTRAIT_MP4,
  VP8_WEBM,
} from "./videoProbeFixtures.js";
import { mp4WithLocation } from "./videoFixtures.js";

// ── Pure: the probe ───────────────────────────────────────────────────────────

describe("MD276 — duration and display size are READ FROM THE CONTAINER", () => {
  // Expected values are ffmpeg's own reading of each file (see the fixtures).
  const cases: Array<[string, Buffer, { ms: number; w: number | null; h: number | null; video: boolean; audio: boolean }]> = [
    ["MP4, moov after mdat (ffmpeg default)", PLAIN_MP4, { ms: 1500, w: 64, h: 48, video: true, audio: true }],
    ["QuickTime .mov, faststart", FASTSTART_MOV, { ms: 1200, w: 48, h: 32, video: true, audio: false }],
    ["WebM / Matroska", VP8_WEBM, { ms: 2200, w: 32, h: 24, video: true, audio: false }],
    ["fragmented MP4 whose moov says nothing about time", FRAGMENTED_MP4, { ms: 3000, w: 32, h: 24, video: true, audio: false }],
    ["audio-only MP4 — probed, and reported as having NO video track", AUDIO_ONLY_M4A, { ms: 1000, w: null, h: null, video: false, audio: true }],
  ];
  for (const [name, buf, want] of cases) {
    it(name, () => {
      const p = probeVideoContainer(buf);
      assert.ok(p, "a real container must probe");
      assert.equal(p.durationMs, want.ms, `durationMs (source ${p.durationSource})`);
      assert.equal(p.width, want.w);
      assert.equal(p.height, want.h);
      assert.equal(p.hasVideoTrack, want.video);
      assert.equal(p.hasAudioTrack, want.audio);
    });
  }

  it("the fragmented file's duration comes from its FRAGMENTS — mvhd says 0 and there is no mehd", () => {
    assert.equal(probeVideoContainer(FRAGMENTED_MP4)!.durationSource, "fragments");
  });

  it("a PORTRAIT phone clip is stored at its DISPLAY size: coded 64x48 + a 90° matrix → 48x64", () => {
    const p = probeVideoContainer(PORTRAIT_MP4)!;
    assert.equal(p.rotation, 90);
    assert.equal(p.width, 48, "width must be the DISPLAYED width, not the coded one");
    assert.equal(p.height, 64);
    assert.equal(p.durationMs, 1800);
  });

  it("never invents: a zero-timescale mvhd and no tracks → durationMs null, not 0", () => {
    const p = probeVideoContainer(mp4WithLocation());
    assert.ok(p);
    assert.equal(p.durationMs, null);
    assert.equal(p.width, null);
    assert.equal(p.hasVideoTrack, false);
  });

  it("an all-ones 'unknown' mvhd duration is null — not 13 hours", () => {
    // At a 90 kHz timescale all-ones reads as 13.3 h, which is INSIDE the 24 h
    // plausibility bound — so only the explicit "unknown" rule can refuse it.
    // (At 1 kHz it would be 49 days and the bound alone would hide a broken rule.)
    const mvhd = Buffer.alloc(8 + 100);
    mvhd.writeUInt32BE(108, 0);
    mvhd.write("mvhd", 4, "latin1");
    mvhd.writeUInt32BE(90_000, 8 + 12); // timescale
    mvhd.writeUInt32BE(0xffffffff, 8 + 16); // duration: unknown
    const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhd.length]), Buffer.from("moov"), mvhd]);
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4)]);
    const p = probeVideoContainer(Buffer.concat([ftyp, moov]))!;
    assert.equal(p.durationMs, null);
  });

  it("reads a version-1 (64-bit) mvhd", () => {
    const body = Buffer.alloc(4 + 8 + 8 + 4 + 8 + 80);
    body[0] = 1; // version 1
    body.writeUInt32BE(600, 4 + 16); // timescale
    body.writeUInt32BE(0, 4 + 20); // duration hi
    body.writeUInt32BE(600 * 42, 4 + 24); // duration lo → 42 s
    const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 8 + body.length]), Buffer.from("mvhd"), body]);
    const moov = Buffer.concat([Buffer.alloc(4), Buffer.from("moov"), mvhd]);
    moov.writeUInt32BE(moov.length, 0);
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypqt  "), Buffer.alloc(4)]);
    assert.equal(probeVideoContainer(Buffer.concat([ftyp, moov]))!.durationMs, 42_000);
  });

  it("is TOTAL: every truncation of a real file returns a probe or null and never throws", () => {
    for (const buf of [PLAIN_MP4, VP8_WEBM, FRAGMENTED_MP4, PORTRAIT_MP4]) {
      for (let n = 0; n <= buf.length; n += 7) {
        assert.doesNotThrow(() => probeVideoContainer(buf.subarray(0, n)));
      }
    }
    assert.equal(probeVideoContainer(Buffer.from("not a video at all, just text")), null);
    assert.equal(probeVideoContainer(null), null);
  });

  it("resolveStoredDuration: measured beats declared; declared only when the container is silent", () => {
    const measured = probeVideoContainer(PLAIN_MP4);
    assert.deepEqual(resolveStoredDuration(measured, 99), { seconds: 1.5, source: "measured" });
    const silent = probeVideoContainer(mp4WithLocation());
    assert.deepEqual(resolveStoredDuration(silent, 7.25), { seconds: 7.25, source: "declared" });
    assert.deepEqual(resolveStoredDuration(null, undefined), { seconds: null, source: "none" });
    assert.equal(probedDurationSeconds(measured), 1.5);
  });
});

describe("MD275 — the poster path is DERIVED, never chosen by the client", () => {
  const SLOT = "u1/p1/m1.mp4";
  it("derives <storage_path>.poster.jpg and maps it back exactly once", () => {
    assert.equal(posterPathFor(SLOT), "u1/p1/m1.mp4.poster.jpg");
    assert.equal(derivedPosterBase("u1/p1/m1.mp4.poster.jpg"), SLOT);
    assert.equal(derivedPosterBase("u1/p1/m1.mp4"), null);
    assert.equal(derivedPosterBase(".poster.jpg"), null);
    assert.equal(derivedPosterBase("u1/p1/.poster.jpg"), null);
    assert.equal(derivedPosterBase("u1/x.poster.jpg.poster.jpg"), null, "a poster of a poster is not a poster");
  });
  it("/complete admits nothing, or this slot's own poster — and refuses everything else", () => {
    assert.deepEqual(admissiblePosterPath(SLOT, undefined), { ok: true, path: null });
    assert.deepEqual(admissiblePosterPath(SLOT, `${SLOT}.poster.jpg`), { ok: true, path: `${SLOT}.poster.jpg` });
    for (const bad of ["u2/secret.jpg", "u1/p1/other.mp4.poster.jpg", SLOT, "../u2/x.jpg", 42]) {
      assert.equal(admissiblePosterPath(SLOT, bad).ok, false, `must refuse ${String(bad)}`);
    }
  });
});

describe("MD281 — part arithmetic is exact", () => {
  it("25 parts for the largest video; the last part carries the remainder", () => {
    const total = 100 * 1024 * 1024;
    assert.equal(partCountFor(total), 25);
    assert.equal(partSizeFor(24, total), RESUMABLE_CHUNK_BYTES);
    const odd = 3 * RESUMABLE_CHUNK_BYTES + 17;
    assert.equal(partCountFor(odd), 4);
    assert.equal(partSizeFor(3, odd), 17);
    assert.equal(partSizeFor(4, odd), null);
    assert.equal(partSizeFor(-1, odd), null);
  });
  it("a WRONG-SIZED part is missing, not received — it is re-sent, never trusted", () => {
    const total = 2 * RESUMABLE_CHUNK_BYTES + 10;
    const s = summarizeParts(
      [
        { name: "00000", size: RESUMABLE_CHUNK_BYTES },
        { name: "00001", size: RESUMABLE_CHUNK_BYTES - 1 },
        { name: "00002", size: 10 },
        { name: "stray.bin", size: 5 },
        { name: "00007", size: 10 },
      ],
      total,
    );
    assert.deepEqual(s.received, [0, 2]);
    assert.deepEqual(s.missing, [1]);
    assert.deepEqual(s.foreign.sort(), ["00007", "stray.bin"]);
    assert.equal(s.complete, false);
    assert.equal(s.receivedBytes, RESUMABLE_CHUNK_BYTES + 10);
  });
});

// ── Routes, over a fake service client ───────────────────────────────────────

const SB = "http://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;
const TOKEN = "video-transport-token";
const OTHER_TOKEN = "video-transport-other";
const USER = "e0000000-0000-4000-a000-000000000001";
const OTHER = "e0000000-0000-4000-a000-000000000002";
const POST = "e0000000-0000-4000-a000-0000000000a1";
const MEDIA = "e0000000-0000-4000-a000-0000000000b1";
const SLOT_PATH = `${USER}/${POST}/${MEDIA}.mp4`;

interface State {
  flags: Record<string, boolean>;
  /** Sizes the Storage LISTING reports, when they differ from the bytes (a part replaced mid-assembly). */
  listedSize: Map<string, number>;
  postMedia: any[];
  posts: any[];
  updates: Array<{ table: string; patch: any }>;
  objects: Map<string, Buffer>;
  signedUploads: string[];
}

let state: State;

function freshState(): State {
  return {
    flags: {},
    posts: [{ id: POST, author_id: USER, status: "active", visibility: "public", post_status: "published", trip_id: null }],
    postMedia: [{
      id: MEDIA, user_id: USER, post_id: POST, storage_path: SLOT_PATH, storage_bucket: "post-media",
      media_type: "video", mime_type: "video/mp4", file_size_bytes: PORTRAIT_MP4.length,
      processing_status: "pending", moderation_status: "pending",
    }],
    updates: [],
    listedSize: new Map(),
    objects: new Map(),
    signedUploads: [],
  };
}

function makeClient() {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null;
    let del = false;
    const rows = () => {
      const src =
        table === "feature_flags" ? Object.entries(state.flags).map(([flag, enabled]) => ({ flag, enabled })) :
        table === "post_media" ? state.postMedia :
        table === "posts" ? state.posts : [];
      return src.filter((r) => filters.every((f) => f(r)));
    };
    const run = () => {
      if (patch) {
        for (const r of rows()) Object.assign(r, patch);
        state.updates.push({ table, patch });
        return { data: null, error: null };
      }
      if (del) {
        const keep = (r: any) => !filters.every((f) => f(r));
        if (table === "post_media") state.postMedia = state.postMedia.filter(keep);
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const b: any = {
      select() { return b; },
      update(p: any) { patch = p; return b; },
      delete() { del = true; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      or() { return b; }, is() { return b; }, not() { return b; }, lt() { return b; }, gte() { return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve(run()).then(onF, onR); },
    };
    return b;
  }
  return {
    from: builder,
    storage: {
      from(bucket: string) {
        const key = (p: string) => `${bucket}/${p}`;
        return {
          async list(folder: string) {
            const prefix = key(folder) + "/";
            const data = [...state.objects.entries()]
              .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
              .map(([k, v]) => ({ name: k.slice(prefix.length), metadata: { size: state.listedSize.get(k) ?? v.length } }))
              .sort((a, b) => a.name.localeCompare(b.name));
            return { data, error: null };
          },
          async createSignedUploadUrl(path: string) {
            state.signedUploads.push(path);
            return { data: { signedUrl: `https://storage.test/upload/sign/${bucket}/${path}?token=t` }, error: null };
          },
          async createSignedUrl(path: string) {
            return { data: { signedUrl: `https://storage.test/object/sign/${bucket}/${path}?token=t` }, error: null };
          },
          async download(path: string) {
            const buf = state.objects.get(key(path));
            if (!buf) return { data: null, error: { message: "Object not found" } };
            return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }, error: null };
          },
          async upload(path: string, body: Buffer) {
            state.objects.set(key(path), Buffer.from(body));
            return { data: { path }, error: null };
          },
          async remove(paths: string[]) {
            for (const p of paths) state.objects.delete(key(p));
            return { data: paths, error: null };
          },
        };
      },
    },
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: USER } }, error: null }
        : t === OTHER_TOKEN ? { data: { user: { id: OTHER } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

let server: http.Server;
let base: string;
const realFetch = globalThis.fetch;

function req(
  method: string,
  path: string,
  body: Buffer | null,
  contentType: string,
  token = TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": contentType };
    if (body) headers["content-length"] = String(body.length);
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const json = (method: string, path: string, obj: unknown, token = TOKEN) =>
  req(method, path, Buffer.from(JSON.stringify(obj)), "application/json", token);

before(() => {
  process.env.SUPABASE_URL = SB;
  // /complete reads the stored video's first bytes through a signed URL.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    if (!url.startsWith("https://storage.test/object/sign/")) return realFetch(input, init);
    const key = decodeURIComponent(new URL(url).pathname.replace("/object/sign/", ""));
    const buf = state.objects.get(key) ?? Buffer.alloc(0);
    const head = buf.subarray(0, 64);
    return new Response(new Uint8Array(head), { status: 206, headers: { "content-range": `bytes 0-${head.length - 1}/${buf.length}` } });
  }) as typeof globalThis.fetch;
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", postsRouter);
  app.use("/api", postcardsRouter);
  app.use("/api", transportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});

after(() => {
  process.env.SUPABASE_URL = OLD_SUPABASE_URL;
  globalThis.fetch = realFetch;
  return new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  state = freshState();
  // _setTestClient installs the same fake as the service client too.
  _setTestClient(makeClient(), true);
});

describe("MD276 on the wire — both upload transports store what the container says", () => {
  it("POST /media/upload returns the PROBED duration and display size of a portrait clip", async () => {
    const r = await req("POST", "/api/media/upload", PORTRAIT_MP4, "video/mp4");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.durationSeconds, 1.8);
    assert.equal(r.body.width, 48);
    assert.equal(r.body.height, 64);
  });

  it("postcard /complete stores the MEASURED duration and size over what the client declared", async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(PORTRAIT_MP4));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: PORTRAIT_MP4.length,
      durationSeconds: 59, width: 1920, height: 1080,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const write = state.updates.find((u) => u.table === "post_media" && u.patch.processing_status === "ready");
    assert.ok(write, "the ready write happened");
    assert.equal(write.patch.duration_seconds, 1.8, "the client said 59 s; the container says 1.8 s");
    assert.equal(write.patch.width, 48);
    assert.equal(write.patch.height, 64);
  });
});

describe("MD275 on the wire — a poster for every postcard video, served as its video", () => {
  async function jpegWithExif(): Promise<Buffer> {
    return sharp({ create: { width: 320, height: 240, channels: 3, background: "#48c" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "x" }, GPS: { GPSLatitudeRef: "N" } } as any)
      .toBuffer();
  }

  it("stores the frame at the DERIVED path, re-encoded with no EXIF, and /complete links it", async () => {
    const up = await req("POST", `/api/postcards/${POST}/media/${MEDIA}/poster`, await jpegWithExif(), "image/jpeg");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.thumbnailPath, `${SLOT_PATH}.poster.jpg`);
    const stored = state.objects.get(`post-media/${SLOT_PATH}.poster.jpg`);
    assert.ok(stored, "poster object written");
    const meta = await sharp(stored).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.exif, undefined, "a frame must not carry the GPS its clip was scrubbed of");

    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(PORTRAIT_MP4));
    const done = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: PORTRAIT_MP4.length, width: 48, height: 64,
      thumbnailPath: up.body.thumbnailPath,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const write = state.updates.find((u) => u.patch.processing_status === "ready")!;
    assert.equal(write.patch.thumbnail_url, `post-media/${SLOT_PATH}.poster.jpg`);
    assert.equal(write.patch.thumbnail_storage_path, `${SLOT_PATH}.poster.jpg`);
  });

  it("/complete REFUSES a thumbnailPath that is not this slot's poster, and marks nothing ready", async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(PORTRAIT_MP4));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: PORTRAIT_MP4.length, width: 48, height: 64,
      thumbnailPath: `${OTHER}/private-photo.jpg`,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(state.updates.some((u) => u.patch.processing_status === "ready"), false);
  });

  it("refuses a poster for someone else's slot, and for an image slot", async () => {
    const other = await req("POST", `/api/postcards/${POST}/media/${MEDIA}/poster`, await jpegWithExif(), "image/jpeg", OTHER_TOKEN);
    assert.equal(other.status, 403);
    state.postMedia[0].media_type = "image";
    const img = await req("POST", `/api/postcards/${POST}/media/${MEDIA}/poster`, await jpegWithExif(), "image/jpeg");
    assert.equal(img.status, 400);
    assert.equal(state.objects.size, 0, "nothing stored on either refusal");
  });

  it("mediaAccess authorizes a poster EXACTLY as its video: public → allowed; private → denied; orphan → denied", async () => {
    const c = makeClient() as any;
    state.postMedia[0].processing_status = "ready";
    state.postMedia[0].moderation_status = "approved";
    const poster = `${SLOT_PATH}.poster.jpg`;
    assert.equal(await authorizeMediaAccess(c, OTHER, "post-media", SLOT_PATH), true, "precondition: the video is visible");
    assert.equal(await authorizeMediaAccess(c, OTHER, "post-media", poster), true, "its poster is visible to the same viewer");
    state.posts[0].visibility = "private";
    assert.equal(await authorizeMediaAccess(c, OTHER, "post-media", SLOT_PATH), false);
    assert.equal(await authorizeMediaAccess(c, OTHER, "post-media", poster), false, "a private video's poster is private");
    assert.equal(
      await authorizeMediaAccess(c, OTHER, "post-media", `${USER}/${POST}/unreferenced.mp4.poster.jpg`),
      false,
      "a poster whose video nothing references is an orphan and is denied",
    );
  });
});

describe("MD281 on the wire — a resumable part upload into the postcard slot", () => {
  const SIZE = 2 * RESUMABLE_CHUNK_BYTES + 1234;
  function payload(): Buffer {
    const b = Buffer.alloc(SIZE, 7);
    Buffer.from(PLAIN_MP4).copy(b, 0); // a real ftyp head, so the assembled bytes sniff as video
    return b;
  }

  beforeEach(() => { state.postMedia[0].file_size_bytes = SIZE; });

  it("the session is the resume token: it lists what landed and signs ONLY what is missing", async () => {
    const first = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session`, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.partCount, 3);
    assert.deepEqual(first.body.missingParts.map((p: any) => p.index), [0, 1, 2]);
    assert.deepEqual(first.body.missingParts.map((p: any) => p.size), [RESUMABLE_CHUNK_BYTES, RESUMABLE_CHUNK_BYTES, 1234]);
    // The connection drops after part 0 lands.
    const bytes = payload();
    state.objects.set(`post-media/${partPathFor(SLOT_PATH, 0)}`, bytes.subarray(0, RESUMABLE_CHUNK_BYTES));
    const resumed = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session`, {});
    assert.deepEqual(resumed.body.receivedParts, [0]);
    assert.deepEqual(resumed.body.missingParts.map((p: any) => p.index), [1, 2], "part 0 is not re-sent");
    assert.equal(resumed.body.receivedBytes, RESUMABLE_CHUNK_BYTES);
  });

  it("assemble concatenates the parts into the slot's own object, byte-exact, and clears the parts", async () => {
    const bytes = payload();
    for (let i = 0; i < 3; i++) {
      const start = i * RESUMABLE_CHUNK_BYTES;
      state.objects.set(`post-media/${partPathFor(SLOT_PATH, i)}`, bytes.subarray(start, start + partSizeFor(i, SIZE)!));
    }
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session/assemble`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(state.objects.get(`post-media/${SLOT_PATH}`)!.equals(bytes), "assembled object is byte-identical");
    assert.equal([...state.objects.keys()].some((k) => k.includes(".parts/")), false, "parts removed");
  });

  it("an incomplete or wrong-sized session is REFUSED (409) — nothing is written to the slot", async () => {
    const bytes = payload();
    state.objects.set(`post-media/${partPathFor(SLOT_PATH, 0)}`, bytes.subarray(0, RESUMABLE_CHUNK_BYTES));
    state.objects.set(`post-media/${partPathFor(SLOT_PATH, 1)}`, bytes.subarray(0, RESUMABLE_CHUNK_BYTES - 1));
    state.objects.set(`post-media/${partPathFor(SLOT_PATH, 2)}`, bytes.subarray(0, 1234));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session/assemble`, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(state.objects.has(`post-media/${SLOT_PATH}`), false);
  });

  it("a part whose BYTES disagree with the listing (replaced mid-assembly) is refused, not concatenated", async () => {
    const bytes = payload();
    for (let i = 0; i < 3; i++) {
      const start = i * RESUMABLE_CHUNK_BYTES;
      state.objects.set(`post-media/${partPathFor(SLOT_PATH, i)}`, bytes.subarray(start, start + partSizeFor(i, SIZE)!));
    }
    const k = `post-media/${partPathFor(SLOT_PATH, 1)}`;
    state.objects.set(k, bytes.subarray(0, RESUMABLE_CHUNK_BYTES - 5));
    state.listedSize.set(k, RESUMABLE_CHUNK_BYTES); // the listing still says "right size"
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session/assemble`, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(state.objects.has(`post-media/${SLOT_PATH}`), false);
  });

  it("assembled bytes that are not the slot's declared kind are refused (400) and the parts removed", async () => {
    const junk = Buffer.alloc(SIZE, 1);
    for (let i = 0; i < 3; i++) {
      const start = i * RESUMABLE_CHUNK_BYTES;
      state.objects.set(`post-media/${partPathFor(SLOT_PATH, i)}`, junk.subarray(start, start + partSizeFor(i, SIZE)!));
    }
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session/assemble`, {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(state.objects.size, 0);
  });

  it("only the slot's owner, only while pending, and never past the emergency stop", async () => {
    const other = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session`, {}, OTHER_TOKEN);
    assert.equal(other.status, 403);
    state.postMedia[0].processing_status = "ready";
    const ready = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session`, {});
    assert.equal(ready.status, 409);
    state.postMedia[0].processing_status = "pending";
    state.flags.disable_media_uploads = true;
    const stopped = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/upload-session`, {});
    assert.equal(stopped.status, 404);
    assert.equal(state.signedUploads.length, 0, "no URL was ever signed");
  });

  it("deleting the media removes its poster and any parts with it", async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from("x"));
    state.objects.set(`post-media/${SLOT_PATH}.poster.jpg`, Buffer.from("p"));
    state.objects.set(`post-media/${partPathFor(SLOT_PATH, 0)}`, Buffer.from("a"));
    const r = await json("DELETE", `/api/postcards/${POST}/media/${MEDIA}`, {});
    assert.ok(r.status < 300, JSON.stringify(r.body));
    assert.deepEqual([...state.objects.keys()], []);
  });
});

// ── census-media §37 (MD269 / MD283): the §36 safety-moderation stage at /complete ──
// The classifier is a TEST DOUBLE. What is proved is the wiring: with the seeded
// flag off, /complete writes 'approved' exactly as before; with it on and no
// classifier, the file completes HELD ('flagged'), which every post_media reader
// refuses to distribute; with a classifier, its verdict decides.
import {
  _setMediaModerationClassifierForTest,
  type MediaModerationClassifier,
} from "../lib/media/vendors/mediaModerationClassifier.js";

describe("§37 on the wire — POST /postcards/:id/media/:mediaId/complete takes its moderation value from the stage", () => {
  const complete = async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(PORTRAIT_MP4));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: PORTRAIT_MP4.length, durationSeconds: 2, width: 48, height: 64,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const write = state.updates.find((u) => u.table === "post_media" && u.patch.processing_status === "ready");
    assert.ok(write, "the ready write happened");
    return write.patch.moderation_status as string;
  };

  it("flag off (the seed): 'approved', as before", async () => {
    assert.equal(await complete(), "approved");
  });

  it("flag on, no classifier configured: completes HELD as 'flagged'", async () => {
    state.flags.media_moderation_classifier_enabled = true;
    assert.equal(await complete(), "flagged");
  });

  it("flag on, a video-capable classifier: its verdict decides ('block' → 'rejected'), and it read THIS slot", async () => {
    state.flags.media_moderation_classifier_enabled = true;
    const seen: string[] = [];
    const c: MediaModerationClassifier = {
      name: "wire-classifier",
      capabilities: { image: true, video: true, videoFrame: false },
      async classify({ subject, target }) {
        seen.push(`${target}:${subject.bucket}/${subject.path}`);
        return { ok: true, value: { verdict: "block", labels: ["test"], confidence: 0.99 } };
      },
    };
    _setMediaModerationClassifierForTest(c);
    try {
      assert.equal(await complete(), "rejected");
      assert.deepEqual(seen, [`file:post-media/${SLOT_PATH}`]);
    } finally {
      _setMediaModerationClassifierForTest(null);
    }
  });
});

// ── census-media §37.8: /complete takes a video's size from its container when the client sends none ──
describe("§37.8 on the wire — /complete uses the PROBED size when the client sends no width/height", () => {
  it("no client dimensions, a container that states 48×64 → completed ready at 48×64", async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(PORTRAIT_MP4));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: PORTRAIT_MP4.length,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const write = state.updates.find((u) => u.table === "post_media" && u.patch.processing_status === "ready");
    assert.ok(write, "the ready write happened");
    assert.equal(write.patch.width, 48);
    assert.equal(write.patch.height, 64);
  });

  it("no client dimensions and a container that states none → refused with the dimension message; nothing marked ready", async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(AUDIO_ONLY_M4A));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: AUDIO_ONLY_M4A.length,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
    assert.match(String(r.body.message), /width and height are required/);
    assert.equal(state.updates.some((u) => u.table === "post_media" && u.patch.processing_status === "ready"), false);
    assert.equal(state.postMedia[0].processing_status, "pending");
  });

  it("client dimensions and a silent container → the client's figure is still used (unchanged)", async () => {
    state.objects.set(`post-media/${SLOT_PATH}`, Buffer.from(AUDIO_ONLY_M4A));
    const r = await json("POST", `/api/postcards/${POST}/media/${MEDIA}/complete`, {
      mimeType: "video/mp4", fileSizeBytes: AUDIO_ONLY_M4A.length, width: 720, height: 1280,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const write = state.updates.find((u) => u.table === "post_media" && u.patch.processing_status === "ready");
    assert.equal(write?.patch.width, 720);
    assert.equal(write?.patch.height, 1280);
  });
});
