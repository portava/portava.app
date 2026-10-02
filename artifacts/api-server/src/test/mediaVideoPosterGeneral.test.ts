/**
 * Media §37 on the GENERAL upload path (`POST /media/upload`) — census-media §22.
 *
 * MD275 "Thumbnail generation": the census's falsifier is *"a writer filling
 * `media_assets.thumbnail_path` for video. The column exists."* This file proves
 * the writer: `POST /media/upload/poster` stores a device frame, re-encoded with
 * no metadata, at the video's derived poster path and records it on the owner's
 * canonical row — once, for the owner's own fresh upload, and for nothing else.
 *
 * MD276 "Duration metadata": the canonical row's `duration_ms` is the PROBED
 * duration (lib/videoProbe.ts), written by the upload route itself.
 *
 * And the two authorization edges the derived poster path opens: a poster keeps
 * its video's story DEADLINE, and nothing under a client-writable prefix is
 * ever a poster.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import {
  POSTER_ATTACH_WINDOW_MS,
  parseOwnVideoPath,
  recordMeasuredDuration,
  recordPosterOnAsset,
  videoObjectExists,
} from "../lib/mediaVideoPoster.js";
import { derivedPosterBase } from "../lib/mediaPosterPath.js";
import { mediaAccessDeadline } from "../lib/mediaAccess.js";
import { probeVideoContainer } from "../lib/videoProbe.js";
import postsRouter from "../routes/posts.js";
import posterRouter, { _setPosterAssetRetryDelay } from "../routes/mediaVideoPoster.js";
import { PLAIN_MP4 } from "./videoProbeFixtures.js";

const USER = "f0000000-0000-4000-a000-000000000001";
const OTHER = "f0000000-0000-4000-a000-000000000002";
const NOW = 1_790_000_000_000;

// ── Pure: which path may take a poster ────────────────────────────────────────

describe("MD275 — a poster attaches only to the caller's own, fresh, general-upload video", () => {
  const own = `${USER}/${NOW - 1000}.mp4`;
  it("accepts the exact /media/upload layout and derives the poster path", () => {
    const r = parseOwnVideoPath(USER, own, NOW);
    assert.ok(r.ok);
    assert.equal(r.posterPath, `${own}.poster.jpg`);
    assert.equal(r.folder, USER);
    assert.equal(r.file, `${NOW - 1000}.mp4`);
    for (const ext of ["mov", "webm"]) assert.ok(parseOwnVideoPath(USER, `${USER}/${NOW}.${ext}`, NOW).ok, ext);
  });
  it("refuses another user's video as FORBIDDEN, not as malformed", () => {
    const r = parseOwnVideoPath(USER, `${OTHER}/${NOW}.mp4`, NOW);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "forbidden");
  });
  it("refuses every other layout: postcard slot, story/memory prefix, an image, traversal, junk", () => {
    for (const bad of [
      `${USER}/${OTHER}/${OTHER}.mp4`,
      `stories/${USER}/${NOW}.mp4`,
      `memories/${USER}/${NOW}.mp4`,
      `${USER}/${NOW}.jpg`,
      `${USER}/../${OTHER}/${NOW}.mp4`,
      `${USER}/${NOW}.mp4.poster.jpg`,
      "",
      42,
      null,
    ]) {
      const r = parseOwnVideoPath(USER, bad, NOW);
      assert.equal(r.ok, false, `must refuse ${String(bad)}`);
      assert.equal(!r.ok && r.code, "invalid_payload", `refusal code for ${String(bad)}`);
    }
  });
  it("refuses a video older than the attach window — a poster cannot re-dress a published video", () => {
    const old = parseOwnVideoPath(USER, `${USER}/${NOW - POSTER_ATTACH_WINDOW_MS - 1}.mp4`, NOW);
    assert.equal(!old.ok && old.code, "conflict");
    assert.ok(parseOwnVideoPath(USER, `${USER}/${NOW - POSTER_ATTACH_WINDOW_MS + 1000}.mp4`, NOW).ok);
    const future = parseOwnVideoPath(USER, `${USER}/${NOW + 60 * 60 * 1000}.mp4`, NOW);
    assert.equal(future.ok, false, "a timestamp an hour ahead is not an upload this server made");
  });
});

describe("the derived-poster rule never covers a path the server did not write", () => {
  it("client-writable prefixes and non-video bases are not posters", () => {
    assert.equal(derivedPosterBase(`${USER}/${NOW}.mp4.poster.jpg`), `${USER}/${NOW}.mp4`);
    assert.equal(derivedPosterBase(`memories/${USER}/${NOW}.mp4.poster.jpg`), null);
    assert.equal(derivedPosterBase(`stories/${USER}/${NOW}.mp4.poster.jpg`), null);
    assert.equal(derivedPosterBase(`${USER}/${NOW}.jpg.poster.jpg`), null, "a photo has no poster");
  });
});

// ── Pure-ish: the canonical row writes ────────────────────────────────────────

interface AssetRow { id: string; owner_user_id: string; storage_bucket: string; storage_path: string; [k: string]: unknown }

function assetClient(rows: AssetRow[], opts: { failUpdate?: boolean } = {}) {
  const updates: Array<{ patch: any; filters: Record<string, unknown> }> = [];
  return {
    updates,
    from(table: string) {
      assert.equal(table, "media_assets");
      const filters: Record<string, unknown> = {};
      let patch: any = null;
      let selected = false;
      const b: any = {
        update(p: any) { patch = p; return b; },
        eq(c: string, v: unknown) { filters[c] = v; return b; },
        select() { selected = true; return b; },
        then(onF: any, onR: any) {
          if (opts.failUpdate) return Promise.resolve({ data: null, error: { message: "57P01" } }).then(onF, onR);
          const hit = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          for (const r of hit) Object.assign(r, patch);
          updates.push({ patch, filters: { ...filters } });
          return Promise.resolve({ data: selected ? hit.map((r) => ({ id: r.id })) : null, error: null }).then(onF, onR);
        },
      };
      return b;
    },
  };
}

describe("MD275 — the poster is recorded on the OWNER's canonical row, and a miss is reported, not claimed", () => {
  const PATH = `${USER}/${NOW}.mp4`;
  const POSTER = `${PATH}.poster.jpg`;
  it("updates only the row at this bucket + path + owner", async () => {
    const rows: AssetRow[] = [
      { id: "a1", owner_user_id: USER, storage_bucket: "post-media", storage_path: PATH },
      { id: "a2", owner_user_id: OTHER, storage_bucket: "post-media", storage_path: PATH },
    ];
    const sc = assetClient(rows);
    const out = await recordPosterOnAsset(sc, { userId: USER, storagePath: PATH, posterPath: POSTER }, { sleep: async () => {} });
    assert.equal(out, "updated");
    assert.equal(rows[0]!.thumbnail_path, POSTER);
    assert.equal(rows[0]!.thumbnail_url, `post-media/${POSTER}`);
    assert.equal(rows[1]!.thumbnail_path, undefined, "another owner's row is never touched");
  });
  it("retries while the upload route's fire-and-forget row has not landed yet", async () => {
    const rows: AssetRow[] = [];
    const sc = assetClient(rows);
    let sleeps = 0;
    const out = await recordPosterOnAsset(sc, { userId: USER, storagePath: PATH, posterPath: POSTER }, {
      attempts: 3,
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) rows.push({ id: "late", owner_user_id: USER, storage_bucket: "post-media", storage_path: PATH });
      },
    });
    assert.equal(out, "updated");
    assert.equal(sleeps, 1);
    assert.equal(rows[0]!.thumbnail_path, POSTER);
  });
  it("no row after every attempt → no_asset; a write error → error, at once", async () => {
    let sleeps = 0;
    assert.equal(
      await recordPosterOnAsset(assetClient([]), { userId: USER, storagePath: PATH, posterPath: POSTER }, { attempts: 3, sleep: async () => { sleeps++; } }),
      "no_asset",
    );
    assert.equal(sleeps, 2);
    sleeps = 0;
    assert.equal(
      await recordPosterOnAsset(assetClient([], { failUpdate: true }), { userId: USER, storagePath: PATH, posterPath: POSTER }, { attempts: 3, sleep: async () => { sleeps++; } }),
      "error",
    );
    assert.equal(sleeps, 0, "an error is not retried as if the row were merely late");
  });
});

describe("MD276 — media_assets.duration_ms is the PROBED duration, and only that", () => {
  it("writes round(ms) for the asset the upload recorded", async () => {
    const rows: AssetRow[] = [{ id: "a1", owner_user_id: USER, storage_bucket: "post-media", storage_path: "x" }];
    const sc = assetClient(rows);
    assert.equal(await recordMeasuredDuration(sc, "a1", probeVideoContainer(PLAIN_MP4)), true);
    assert.equal(rows[0]!.duration_ms, 1500);
  });
  it("writes nothing without an asset id or a measured duration", async () => {
    const sc = assetClient([]);
    assert.equal(await recordMeasuredDuration(sc, null, probeVideoContainer(PLAIN_MP4)), false);
    assert.equal(await recordMeasuredDuration(sc, "a1", null), false);
    assert.equal(
      await recordMeasuredDuration(sc, "a1", { ...probeVideoContainer(PLAIN_MP4)!, durationMs: null, durationSource: null }),
      false,
    );
    assert.equal(sc.updates.length, 0);
  });
});

describe("a poster keeps its video's story deadline", () => {
  it("mediaAccessDeadline(poster) is the deadline of the story that holds the video", async () => {
    const VIDEO = `${USER}/${NOW}.mp4`;
    const EXPIRES = "2026-09-27T00:00:00.000Z";
    const sc: any = {
      from(table: string) {
        let urls: string[] = [];
        const b: any = {
          select() { return b; },
          in(_c: string, vs: string[]) { urls = vs; return b; },
          limit() {
            const hit = table === "stories" && urls.includes(`post-media/${VIDEO}`);
            return Promise.resolve({ data: hit ? [{ owner_id: USER, state: "active", expires_at: EXPIRES }] : [], error: null });
          },
        };
        return b;
      },
    };
    assert.equal(await mediaAccessDeadline(sc, OTHER, "post-media", VIDEO), Date.parse(EXPIRES), "precondition");
    assert.equal(
      await mediaAccessDeadline(sc, OTHER, "post-media", `${VIDEO}.poster.jpg`),
      Date.parse(EXPIRES),
      "a signed poster URL must not outlive the story its video belongs to",
    );
  });
});

describe("videoObjectExists reports a storage error as an error, never as absent", () => {
  it("present / absent / error", async () => {
    const v = { folder: USER, file: `${NOW}.mp4` };
    const bucket = (data: any, error: any = null) => ({ list: async () => ({ data, error }), upload: async () => ({ error: null }) });
    assert.equal(await videoObjectExists(bucket([{ name: `${NOW}.mp4` }]), v), "present");
    assert.equal(await videoObjectExists(bucket([{ name: `${NOW}.mp4x` }]), v), "absent");
    assert.equal(await videoObjectExists(bucket(null, { message: "down" }), v), "error");
  });
});

// ── Routes, over a fake service client ───────────────────────────────────────

const TOKEN = "general-poster-token";
const OTHER_TOKEN = "general-poster-other";

interface State {
  flags: Record<string, boolean>;
  objects: Map<string, Buffer>;
  assets: AssetRow[];
  upserts: any[];
  assetUpdates: Array<{ patch: any; filters: Record<string, unknown> }>;
}
let state: State;

function makeClient() {
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let patch: any = null;
    let upserted: any = null;
    let selected = false;
    const result = () => {
      if (table === "feature_flags") {
        const flag = String(filters.flag);
        return { data: flag in state.flags ? { enabled: state.flags[flag] } : null, error: null };
      }
      if (table === "media_assets" && patch) {
        const hit = state.assets.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        for (const r of hit) Object.assign(r, patch);
        state.assetUpdates.push({ patch, filters: { ...filters } });
        return { data: selected ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (table === "media_assets" && upserted) {
        const row = { id: `asset-${state.assets.length + 1}`, ...upserted };
        state.assets.push(row);
        state.upserts.push({ ...row }); // the INSERT as sent (census-media §37.8); later updates land on state.assets
        return { data: { id: row.id }, error: null };
      }
      return { data: [], error: null };
    };
    const b: any = {
      select() { selected = true; return b; },
      update(p: any) { patch = p; return b; },
      upsert(row: any) { upserted = row; return b; },
      insert(row: any) { upserted = row; return b; },
      eq(c: string, v: unknown) { filters[c] = v; return b; },
      in() { return b; }, is() { return b; }, not() { return b; }, or() { return b; },
      gte() { return b; }, lte() { return b; }, lt() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { return Promise.resolve(result()); },
      single() { return Promise.resolve(result()); },
      then(onF: any, onR: any) { return Promise.resolve(result()).then(onF, onR); },
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
            const data = [...state.objects.keys()]
              .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
              .map((k) => ({ name: k.slice(prefix.length) }));
            return { data, error: null };
          },
          async upload(path: string, body: Buffer, opts?: { upsert?: boolean }) {
            if (opts?.upsert === false && state.objects.has(key(path))) {
              return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            }
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
let base = "";

function req(method: string, pathAndQuery: string, body: Buffer, contentType: string, token = TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathAndQuery, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { authorization: `Bearer ${token}`, "content-type": contentType, "content-length": String(body.length) },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(body);
    r.end();
  });
}

async function jpegWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 240, channels: 3, background: "#48c" } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "x" }, GPS: { GPSLatitudeRef: "N" } } as any)
    .toBuffer();
}

/** Wait for the upload route's fire-and-forget canonical write (and its .then) to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", postsRouter);
  app.use("/api", posterRouter);
  _setPosterAssetRetryDelay(0);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});

after(async () => {
  _setPosterAssetRetryDelay(null);
  _clearTestClient();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  state = { flags: {}, objects: new Map(), assets: [], upserts: [], assetUpdates: [] };
  const c = makeClient();
  _setTestClient(c, true);
});

describe("MD276 on the wire — POST /media/upload writes the probed duration onto the canonical row", () => {
  it("the canonical row carries the probed size, and duration_ms = 1500 for a 1.5 s clip", async () => {
    state.flags.media_canonical_enabled = true;
    const r = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    const row = state.upserts[0];
    assert.ok(row, "the canonical dual-write ran");
    assert.equal(row.media_type, "video");
    assert.equal(row.width, 64);
    assert.equal(row.height, 48);
    const dur = state.assetUpdates.find((u) => "duration_ms" in u.patch);
    assert.ok(dur, "a duration write followed the canonical write");
    assert.equal(dur.patch.duration_ms, 1500);
    assert.equal(dur.filters.id, row.id, "…on the row the upload just recorded");
  });
});

describe("MD275 on the wire — POST /media/upload/poster", () => {
  async function uploadVideo(): Promise<string> {
    state.flags.media_canonical_enabled = true;
    const r = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    return r.body.path as string;
  }

  it("stores the frame at the derived path with no EXIF, and records it on the video's canonical row", async () => {
    const path = await uploadVideo();
    const r = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, await jpegWithGps(), "image/jpeg");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.thumbnailPath, `${path}.poster.jpg`);
    assert.equal(r.body.thumbnailUrl, `post-media/${path}.poster.jpg`);
    assert.equal(r.body.assetRecorded, true);
    const stored = state.objects.get(`post-media/${path}.poster.jpg`);
    assert.ok(stored, "poster written");
    const meta = await sharp(stored).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.exif, undefined, "the frame is re-encoded without metadata");
    const asset = state.assets.find((a) => a.storage_path === path);
    assert.equal(asset?.thumbnail_path, `${path}.poster.jpg`, "media_assets.thumbnail_path now has a writer for video");
    assert.equal(asset?.thumbnail_url, `post-media/${path}.poster.jpg`);
  });

  it("a second poster for the same video is refused and the first frame is kept", async () => {
    const path = await uploadVideo();
    const first = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, await jpegWithGps(), "image/jpeg");
    assert.equal(first.status, 201);
    const before = state.objects.get(`post-media/${path}.poster.jpg`);
    const other = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#f00" } }).jpeg().toBuffer();
    const second = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, other, "image/jpeg");
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.ok(before && state.objects.get(`post-media/${path}.poster.jpg`)!.equals(before), "bytes unchanged");
  });

  it("refuses another user's video, a video that does not exist, and a body that is not an image", async () => {
    const path = await uploadVideo();
    const jpeg = await jpegWithGps();
    const other = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, jpeg, "image/jpeg", OTHER_TOKEN);
    assert.equal(other.status, 403, JSON.stringify(other.body));
    const missing = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(`${USER}/${Date.now()}.mp4`)}`, jpeg, "image/jpeg");
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    const notImage = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, PLAIN_MP4, "image/jpeg");
    assert.equal(notImage.status, 400, JSON.stringify(notImage.body));
    // A GIF DECODES (sharp would happily re-encode it) but is not an image type
    // the upload pipeline admits — the sniff, not the decoder, has to refuse it.
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0f0" } }).gif().toBuffer();
    const notAdmitted = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, gif, "image/jpeg");
    assert.equal(notAdmitted.status, 400, JSON.stringify(notAdmitted.body));
    assert.equal([...state.objects.keys()].some((k) => k.endsWith(".poster.jpg")), false, "nothing stored on any refusal");
  });

  it("honours the upload emergency stop", async () => {
    const path = await uploadVideo();
    state.flags.disable_media_uploads = true;
    const r = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, await jpegWithGps(), "image/jpeg");
    assert.notEqual(r.status, 201);
    assert.equal(r.body?.error ?? r.body?.code, "feature_disabled", JSON.stringify(r.body));
    assert.equal(state.objects.has(`post-media/${path}.poster.jpg`), false);
  });

  it("with no canonical row (canonical writes dark) the poster is stored and the miss is REPORTED", async () => {
    const path = `${USER}/${Date.now()}.mp4`;
    state.objects.set(`post-media/${path}`, Buffer.from(PLAIN_MP4));
    const r = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(path)}`, await jpegWithGps(), "image/jpeg");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.assetRecorded, false, "never claims a row it did not write");
    assert.ok(state.objects.has(`post-media/${path}.poster.jpg`));
  });
});

// ── census-media §37: the vendor stages on the upload path, on the wire ──────
// Every adapter is a TEST DOUBLE; what is proved is the wiring — which route
// hands what to which seam, and that nothing is handed over while the seeded
// flags are off.
import { _setMediaVisionProviderForTest, type MediaVisionProvider } from "../lib/media/vendors/mediaVisionProvider.js";
import { _setMediaModerationClassifierForTest, type MediaModerationClassifier } from "../lib/media/vendors/mediaModerationClassifier.js";

describe("§37 on the wire — POST /media/upload and /media/upload/poster reach the vendor seams only behind their flags", () => {
  const calls: string[] = [];
  const vision: MediaVisionProvider = {
    name: "wire-vision",
    capabilities: { sceneSignals: false, similarMedia: false, ingest: true },
    async sceneSignals() { return { ok: false, reason: "unsupported" }; },
    async similarMedia() { return { ok: false, reason: "unsupported" }; },
    async ingest(i) { calls.push(`ingest:${i.assetId}:${i.bucket}/${i.path}`); return { ok: true, value: { accepted: true } }; },
  };
  const frameClassifier: MediaModerationClassifier = {
    name: "wire-frame-classifier",
    capabilities: { image: true, video: false, videoFrame: true },
    async classify({ subject, target }) { calls.push(`classify:${target}:${subject.framePath}`); return { ok: true, value: { verdict: "allow", labels: [], confidence: 0.9 } }; },
  };
  beforeEach(() => {
    calls.length = 0;
    _setMediaVisionProviderForTest(vision);
    _setMediaModerationClassifierForTest(frameClassifier);
  });
  after(() => {
    _setMediaVisionProviderForTest(null);
    _setMediaModerationClassifierForTest(null);
  });

  it("flags off (the seed): an upload and its poster reach no vendor", async () => {
    state.flags.media_canonical_enabled = true;
    const up = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await settle();
    const poster = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(up.body.path)}`, await jpegWithGps(), "image/jpeg");
    assert.equal(poster.status, 201, JSON.stringify(poster.body));
    await settle();
    assert.deepEqual(calls, []);
  });

  it("vision on: the stored file is handed to the index under the canonical asset the upload just recorded", async () => {
    state.flags.media_canonical_enabled = true;
    state.flags.media_vision_provider_enabled = true;
    const up = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await settle();
    const row = state.upserts[0];
    assert.ok(row, "the canonical write ran");
    assert.deepEqual(calls, [`ingest:${row.id}:post-media/${up.body.path}`]);
  });

  it("moderation on, a frame-only classifier: nothing to read at upload (held), then the POSTER route shows it the stored frame", async () => {
    state.flags.media_canonical_enabled = true;
    state.flags.media_moderation_classifier_enabled = true;
    const up = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await settle();
    assert.deepEqual(calls, [], "a frame-only classifier has no frame at upload time: held, not asked");
    const poster = await req("POST", `/api/media/upload/poster?path=${encodeURIComponent(up.body.path)}`, await jpegWithGps(), "image/jpeg");
    assert.equal(poster.status, 201, JSON.stringify(poster.body));
    await settle();
    assert.deepEqual(calls, [`classify:frame:${up.body.path}.poster.jpg`]);
  });
});

// ── census-media §37.8 (MD269 (c)): the canonical row is BORN held while the stage is on ──
describe("§37.8 on the wire — POST /media/upload's canonical row is born held while 3356 is on", () => {
  /** Every key the canonical insert carried before §37.8 — the flag-off payload must be exactly these. */
  const KEYS_BEFORE = [
    "owner_user_id", "uploader_user_id", "storage_bucket", "storage_path", "public_url", "media_type", "mime_type",
    "size_bytes", "width", "height", "thumbnail_path", "thumbnail_url", "source_type", "captured_at", "provenance",
    "intelligence_eligibility", "processing_status",
  ].sort();

  it("stage OFF (the seed): the one insert carries no moderation_status — the payload keys are exactly the pre-§37.8 set", async () => {
    state.flags.media_canonical_enabled = true;
    const up = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await settle();
    assert.equal(state.upserts.length, 1);
    const { id: _id, ...row } = state.upserts[0];
    assert.deepEqual(Object.keys(row).sort(), KEYS_BEFORE);
  });

  it("stage ON: the SAME single insert carries moderation_status 'limited' — never born distributable", async () => {
    state.flags.media_canonical_enabled = true;
    state.flags.media_moderation_classifier_enabled = true;
    const up = await req("POST", "/api/media/upload", PLAIN_MP4, "video/mp4");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await settle();
    assert.equal(state.upserts.length, 1, "one write");
    assert.equal(state.upserts[0].moderation_status, "limited");
    const { id: _id, moderation_status: _m, ...rest } = state.upserts[0];
    assert.deepEqual(Object.keys(rest).sort(), KEYS_BEFORE, "nothing else about the insert changes");
  });
});
