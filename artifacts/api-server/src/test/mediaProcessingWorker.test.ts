/**
 * census-media §30 (MD338) — the media processing lifecycle has a worker, and
 * an owner's retry cannot take a `ready` asset off a read path.
 *
 * RED WHEN (§28.9): "a production caller claims queued assets and completes or
 * fails each one, and a retry cannot take a `ready` asset off a read path."
 *
 * ── WHAT THE DOUBLE IS ───────────────────────────────────────────────────────
 * The REAL supabase-js client over `helpers/postgrestOracle` (an injected
 * `fetch` emulating PostgREST over in-memory tables). So every conditional
 * update below is the real client's request, a zero-row UPDATE really comes
 * back as `data: null`, and a column the migrations do not declare is a 42703:
 * `media_assets` and `media_processing_attempts` are given their migration
 * column lists (0191 + 2250 + 2951 + 2952 + 2953; 2951). Storage is a map of
 * stored objects that records every download and refuses every write.
 * Nothing here reaches a database.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mediaProcessingWorker.test.ts
 */
import { describe, it, before, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import sharp from "sharp";

import { makeOracle, type Row } from "./helpers/postgrestOracle.js";
import { PLAIN_MP4, PORTRAIT_MP4 } from "./videoProbeFixtures.js";
import { box, xyzBox, webmWithLocationTag } from "./videoFixtures.js";
import {
  retryMediaProcessing,
  MEDIA_PROCESSING_WORKER_FLAG,
} from "../services/media/MediaLifecycleService.js";
import {
  runMediaProcessingPass,
  startMediaProcessingWorker,
  stopMediaProcessingWorker,
  _mediaProcessingWorkerArmed,
  MEDIA_PROCESSING_STARTUP_DELAY_MS,
  MEDIA_PROCESSING_INTERVAL_MS,
} from "../lib/media/mediaProcessingWorker.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import mediaActionsRouter from "../routes/mediaActions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const OWNER_TOKEN = "owner-token";
const STRANGER_TOKEN = "stranger-token";
const BUCKET = "post-media";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

/** `media_assets` as the migrations declare it: 0191, 2250, 2951, 2952, 2953. */
const MEDIA_ASSET_COLUMNS = [
  "id", "owner_user_id", "uploader_user_id", "storage_bucket", "storage_path", "public_url",
  "media_type", "mime_type", "size_bytes", "width", "height", "duration_ms", "thumbnail_path",
  "thumbnail_url", "alt_text", "caption", "source_type", "moderation_status", "processing_status",
  "visibility", "version", "created_at", "updated_at",
  "captured_at", "location_visibility", "provenance", "intelligence_eligibility",
  "processing_attempt_count", "processing_next_retry_at", "processing_lease_until",
  "processing_lease_token", "processing_error", "processing_terminal",
  "deleted_at", "purge_status", "purge_error",
  "processing_last_attempt_at", "processing_completed_at", "purge_requested_at", "purged_at",
];
/** `media_processing_attempts` (2951). */
const ATTEMPT_COLUMNS = [
  "id", "media_asset_id", "attempt_number", "lease_token", "status", "error_message", "started_at", "completed_at",
];

function asset(n: number, over: Row = {}): Row {
  return {
    id: id(n),
    owner_user_id: OWNER,
    uploader_user_id: OWNER,
    storage_bucket: BUCKET,
    storage_path: `${OWNER}/${n}.jpg`,
    public_url: `${BUCKET}/${OWNER}/${n}.jpg`,
    media_type: "image",
    mime_type: "image/jpeg",
    size_bytes: 1,
    width: null,
    height: null,
    duration_ms: null,
    thumbnail_path: null,
    thumbnail_url: null,
    moderation_status: "active",
    processing_status: "queued",
    processing_attempt_count: 0,
    processing_next_retry_at: null,
    processing_lease_until: null,
    processing_lease_token: null,
    processing_error: null,
    processing_terminal: false,
    purge_status: "not_requested",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

interface World {
  flag?: boolean | "unreadable";
  assets: Row[];
  attempts?: Row[];
  objects?: Record<string, Buffer>;
  /** Runs when the code under test reads the worker flag — a seam for a concurrent writer. */
  onFlagRead?: (tables: Record<string, Row[]>) => void;
}

function makeWorld(w: World) {
  const tables: Record<string, Row[]> = {
    feature_flags: w.flag === undefined || w.flag === "unreadable"
      ? []
      : [{ flag: MEDIA_PROCESSING_WORKER_FLAG, enabled: w.flag }],
    media_assets: w.assets,
    media_processing_attempts: w.attempts ?? [],
    profiles: [],
  };
  const oracle = makeOracle({
    tables,
    columns: { media_assets: MEDIA_ASSET_COLUMNS, media_processing_attempts: ATTEMPT_COLUMNS },
    unique: { media_processing_attempts: ["media_asset_id", "attempt_number"] },
    failReads: w.flag === "unreadable" ? { feature_flags: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined,
  });
  const objects = new Map(Object.entries(w.objects ?? {}));
  const downloads: string[] = [];
  const storageWrites: string[] = [];
  const sc: any = {
    from(table: string) {
      if (table === "feature_flags") w.onFlagRead?.(tables);
      return oracle.client.from(table);
    },
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            downloads.push(`${bucket}/${path}`);
            const b = objects.get(`${bucket}/${path}`);
            return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "Object not found" } };
          },
          async upload(path: string) { storageWrites.push(`upload ${bucket}/${path}`); return { error: { message: "refused by the test" } }; },
          async remove(paths: string[]) { storageWrites.push(`remove ${bucket}/${paths.join(",")}`); return { error: { message: "refused by the test" } }; },
        };
      },
    },
    auth: {
      async getUser(token: string) {
        if (token === OWNER_TOKEN) return { data: { user: { id: OWNER } }, error: null };
        if (token === STRANGER_TOKEN) return { data: { user: { id: STRANGER } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
  const writesTo = (table: string) =>
    oracle.log.filter((r) => r.method !== "GET" && r.method !== "HEAD" && new URL(r.url).pathname.endsWith(`/${table}`));
  const row = (n: number) => tables.media_assets.find((r) => r.id === id(n))!;
  return { sc, oracle, tables, downloads, storageWrites, writesTo, row };
}

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
}

/**
 * A JPEG carrying an EXIF GPS IFD — built by hand, because sharp's `withExif`
 * writes no GPS IFD at all (measured in exifFacts.test.ts). IFD0 holds one
 * entry, the 0x8825 GPS pointer; the GPS IFD holds GPSVersionID only, so no
 * coordinate exists in the fixture to leak.
 */
function withGpsIfd(jpg: Buffer): Buffer {
  const tiff = Buffer.alloc(44);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x0000, 28); tiff.writeUInt16LE(1, 30); tiff.writeUInt32LE(4, 32); tiff[36] = 2; tiff[37] = 2;
  tiff.writeUInt32LE(0, 40);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), head, payload, jpg.subarray(2)]);
}

/** A real muxer's MP4 with `udta/©xyz` added as the last child of its `moov` (which is its last box). */
function withLocationAtom(mp4: Buffer): Buffer {
  let p = 0;
  let moovAt = -1;
  let moovSize = 0;
  while (p + 8 <= mp4.length) {
    const size = mp4.readUInt32BE(p);
    if (mp4.toString("latin1", p + 4, p + 8) === "moov") { moovAt = p; moovSize = size; }
    if (size < 8) break;
    p += size;
  }
  assert.ok(moovAt >= 0 && moovAt + moovSize === mp4.length, "fixture: moov must be the last top-level box");
  const udta = box("udta", xyzBox());
  const out = Buffer.concat([mp4, udta]);
  out.writeUInt32BE(moovSize + udta.length, moovAt);
  return out;
}

const obj = (n: number, ext = "jpg") => `${BUCKET}/${OWNER}/${n}.${ext}`;

// ═════════════════════════════════════════════════════════════════════════════
// 1. The retry refuses what is not retryable (service)
// ═════════════════════════════════════════════════════════════════════════════

describe("census-media §30 (MD338) — retryMediaProcessing re-queues only a FAILED run", () => {
  it("refuses a READY asset and writes nothing, with the worker ON", async () => {
    const w = makeWorld({ flag: true, assets: [asset(1, { processing_status: "ready", width: 64, height: 48 })] });
    const result = await retryMediaProcessing(w.sc, id(1), OWNER);
    assert.deepEqual(result, { ok: false, alreadyQueued: false, notRetryable: true });
    assert.equal(w.writesTo("media_assets").length, 0, "a refused retry must not write");
    assert.equal(w.row(1).processing_status, "ready", "the asset stays on its read paths");
  });

  it("refuses every other non-failed state too, writing nothing", async () => {
    for (const status of ["removed", "rejected", "expired", "uploaded", "local"]) {
      const w = makeWorld({ flag: true, assets: [asset(1, { processing_status: status })] });
      const result = await retryMediaProcessing(w.sc, id(1), OWNER);
      assert.equal(result.notRetryable, true, `${status} must be refused`);
      assert.equal(w.writesTo("media_assets").length, 0, `${status}: nothing written`);
    }
  });

  it("re-queues a FAILED asset (terminal or not): clears the lease and the terminal mark, keeps attempt history", async () => {
    for (const terminal of [true, false]) {
      const w = makeWorld({
        flag: true,
        assets: [asset(1, {
          processing_status: "failed", processing_terminal: terminal, processing_attempt_count: 5,
          processing_error: "boom", processing_next_retry_at: terminal ? null : "2999-01-01T00:00:00.000Z",
        })],
      });
      const result = await retryMediaProcessing(w.sc, id(1), OWNER);
      assert.deepEqual(result, { ok: true, alreadyQueued: false });
      const r = w.row(1);
      assert.equal(r.processing_status, "queued");
      assert.equal(r.processing_terminal, false);
      assert.equal(r.processing_error, null);
      assert.equal(r.processing_attempt_count, 5, "attempt history is kept");
      assert.ok(Date.parse(r.processing_next_retry_at) <= Date.now(), "due now");
    }
  });

  it("does not re-queue an asset that became READY between its read and its write", async () => {
    // The read sees `failed`. The flag read in between is the seam where a
    // concurrent worker completes the asset. A retry whose UPDATE is not
    // conditional on `failed` would now take a READY asset off its read paths.
    const w = makeWorld({
      flag: true,
      assets: [asset(1, { processing_status: "failed", processing_terminal: true })],
      onFlagRead: (t) => {
        const r = t.media_assets.find((x) => x.id === id(1))!;
        Object.assign(r, { processing_status: "ready", width: 64, height: 48 });
      },
    });
    const result = await retryMediaProcessing(w.sc, id(1), OWNER);
    assert.equal(result.ok, false);
    assert.equal(result.notRetryable, true);
    assert.equal(w.row(1).processing_status, "ready");
  });

  it("GATED OFF: refuses a failed asset while the worker flag is off, absent or unreadable — and writes nothing", async () => {
    for (const flag of [false, undefined, "unreadable"] as const) {
      const w = makeWorld({ flag, assets: [asset(1, { processing_status: "failed", processing_terminal: true })] });
      const result = await retryMediaProcessing(w.sc, id(1), OWNER);
      assert.deepEqual(result, { ok: false, alreadyQueued: false, workerDisabled: true }, `flag ${String(flag)}`);
      assert.equal(w.writesTo("media_assets").length, 0, `flag ${String(flag)}: nothing parked`);
      assert.equal(w.row(1).processing_status, "failed");
    }
  });

  it("keeps the no-probe rule: a stranger, and a missing id, get the plain not-found shape", async () => {
    const w = makeWorld({ flag: true, assets: [asset(1, { processing_status: "ready" })] });
    assert.deepEqual(await retryMediaProcessing(w.sc, id(1), STRANGER), { ok: false, alreadyQueued: false });
    assert.deepEqual(await retryMediaProcessing(w.sc, id(9), OWNER), { ok: false, alreadyQueued: false });
    assert.equal(w.writesTo("media_assets").length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The retry route's answers
// ═════════════════════════════════════════════════════════════════════════════

describe("census-media §30 (MD338) — POST /api/media/:id/retry", () => {
  let server: Server;
  let base = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const noop: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noop };
      req.log = noop;
      next();
    });
    app.use("/api", mediaActionsRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    server.close();
    _setTestClient(null, false);
    _setTestServiceClient(null);
  });

  async function retry(w: ReturnType<typeof makeWorld>, assetId: string, token = OWNER_TOKEN) {
    _setTestClient(w.sc, true);
    const r = await fetch(`${base}/api/media/${assetId}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }

  it("a READY asset: 409 invalid_state_transition to its owner, and nothing written", async () => {
    const w = makeWorld({ flag: true, assets: [asset(1, { processing_status: "ready", width: 64, height: 48 })] });
    const r = await retry(w, id(1));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_state_transition");
    assert.equal(w.writesTo("media_assets").length, 0);
    assert.equal(w.row(1).processing_status, "ready");
  });

  it("a FAILED asset with the worker on: 202, and the row is queued", async () => {
    const w = makeWorld({ flag: true, assets: [asset(1, { processing_status: "failed", processing_terminal: true })] });
    const r = await retry(w, id(1));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(r.body, { retryQueued: true, alreadyQueued: false });
    assert.equal(w.row(1).processing_status, "queued");
  });

  it("GATED OFF: a FAILED asset gets 404 feature_disabled and stays failed", async () => {
    const w = makeWorld({ flag: false, assets: [asset(1, { processing_status: "failed", processing_terminal: true })] });
    const r = await retry(w, id(1));
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(w.writesTo("media_assets").length, 0);
    assert.equal(w.row(1).processing_status, "failed");
  });

  it("no probing: a stranger's retry of a READY asset and a missing id both get not_found", async () => {
    const w = makeWorld({ flag: true, assets: [asset(1, { processing_status: "ready", width: 64, height: 48 })] });
    const stranger = await retry(w, id(1), STRANGER_TOKEN);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.error, "not_found");
    const missing = await retry(w, id(9));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "not_found");
    assert.equal(w.writesTo("media_assets").length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The worker pass
// ═════════════════════════════════════════════════════════════════════════════

describe("census-media §30 (MD338) — runMediaProcessingPass", () => {
  it("GATED OFF: one flag read and nothing else — no asset read, no download, no write", async () => {
    for (const flag of [false, undefined, "unreadable"] as const) {
      const w = makeWorld({ flag, assets: [asset(1)], objects: { [obj(1)]: await jpeg(64, 48) } });
      const r = await runMediaProcessingPass({ client: w.sc });
      assert.equal(r.skipped, true);
      assert.equal(r.reason, "disabled");
      assert.equal(w.oracle.requests(), 1, `flag ${String(flag)}: only the flag read`);
      assert.deepEqual(w.downloads, []);
      assert.equal(w.row(1).processing_status, "queued");
    }
  });

  it("claims a QUEUED image, re-runs the pipeline over the stored object, and completes it READY with its measured size", async () => {
    const w = makeWorld({
      flag: true,
      assets: [asset(1, { thumbnail_path: `${OWNER}/1.thumb.jpg`, thumbnail_url: `${BUCKET}/${OWNER}/1.thumb.jpg` })],
      objects: { [obj(1)]: await jpeg(64, 48) },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.claimed, 1, JSON.stringify(r));
    assert.equal(r.completed, 1, JSON.stringify(r));
    const a = w.row(1);
    assert.equal(a.processing_status, "ready");
    assert.equal(a.width, 64);
    assert.equal(a.height, 48);
    assert.equal(a.processing_lease_token, null);
    assert.equal(a.processing_attempt_count, 1);
    assert.equal(a.thumbnail_path, `${OWNER}/1.thumb.jpg`, "completion keeps the thumbnail the asset already had");
    assert.equal(a.thumbnail_url, `${BUCKET}/${OWNER}/1.thumb.jpg`);
    assert.deepEqual(w.downloads, [obj(1)]);
    assert.deepEqual(w.storageWrites, [], "the worker never writes storage");
    const attempts = w.tables.media_processing_attempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "succeeded");
  });

  it("completes a QUEUED video with the container's DISPLAY size and duration (portrait swaps)", async () => {
    const w = makeWorld({
      flag: true,
      assets: [asset(2, { media_type: "video", mime_type: "video/mp4", storage_path: `${OWNER}/2.mp4` })],
      objects: { [obj(2, "mp4")]: Buffer.from(PORTRAIT_MP4) },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 1, JSON.stringify(r));
    const a = w.row(2);
    assert.equal(a.processing_status, "ready");
    assert.equal(a.width, 48);
    assert.equal(a.height, 64);
    assert.equal(a.duration_ms, 1800);
  });

  it("FAILS, terminal at once, when the stored bytes do not verify — and never marks the asset ready", async () => {
    const w = makeWorld({
      flag: true,
      assets: [asset(3)],
      objects: { [obj(3)]: Buffer.from("this is not an image, it is a text file padded out") },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.terminal, 1);
    const a = w.row(3);
    assert.equal(a.processing_status, "failed");
    assert.equal(a.processing_terminal, true);
    assert.equal(a.processing_next_retry_at, null);
    assert.match(a.processing_error, /Unrecognized or corrupt/);
    assert.equal(w.tables.media_processing_attempts[0].status, "terminal_failure");
  });

  it("FAILS terminally when the bytes are not the kind the row says (a still stored under a video row)", async () => {
    const w = makeWorld({
      flag: true,
      assets: [asset(4, { media_type: "video", mime_type: "video/mp4" })],
      objects: { [obj(4)]: await jpeg(64, 48) },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 0, JSON.stringify(r));
    assert.equal(w.row(4).processing_status, "failed");
    assert.equal(w.row(4).processing_terminal, true);
    assert.match(w.row(4).processing_error, /bytes are image, but video was declared/);
  });

  it("FAILS terminally, never ready, when a stored still carries a GPS IFD", async () => {
    const w = makeWorld({ flag: true, assets: [asset(5)], objects: { [obj(5)]: withGpsIfd(await jpeg(64, 48)) } });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 0, JSON.stringify(r));
    assert.equal(w.row(5).processing_status, "failed");
    assert.equal(w.row(5).processing_terminal, true);
    assert.match(w.row(5).processing_error, /GPS/);
  });

  it("FAILS terminally, never ready, when a stored video still carries a location atom (its size is readable)", async () => {
    // CONTROL first: the same real MP4 without the atom completes, so the
    // refusal below is the location atom's and not a size or verify failure.
    const control = makeWorld({
      flag: true,
      assets: [asset(6, { media_type: "video", mime_type: "video/mp4", storage_path: `${OWNER}/6.mp4` })],
      objects: { [obj(6, "mp4")]: Buffer.from(PLAIN_MP4) },
    });
    assert.equal((await runMediaProcessingPass({ client: control.sc })).completed, 1);
    assert.equal(control.row(6).width, 64);

    const w = makeWorld({
      flag: true,
      assets: [asset(6, { media_type: "video", mime_type: "video/mp4", storage_path: `${OWNER}/6.mp4` })],
      objects: { [obj(6, "mp4")]: withLocationAtom(Buffer.from(PLAIN_MP4)) },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 0, JSON.stringify(r));
    assert.equal(w.row(6).processing_status, "failed");
    assert.equal(w.row(6).processing_terminal, true);
    assert.match(w.row(6).processing_error, /location/);

    const webm = makeWorld({
      flag: true,
      assets: [asset(7, { media_type: "video", mime_type: "video/webm", storage_path: `${OWNER}/7.webm` })],
      objects: { [obj(7, "webm")]: webmWithLocationTag() },
    });
    await runMediaProcessingPass({ client: webm.sc });
    assert.equal(webm.row(7).processing_status, "failed");
    assert.match(webm.row(7).processing_error, /location/);
  });

  it("FAILS RETRYABLY when the stored object cannot be read: not terminal, retry scheduled", async () => {
    const now = new Date();
    const w = makeWorld({ flag: true, assets: [asset(8)], objects: {} });
    const r = await runMediaProcessingPass({ client: w.sc, now });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.terminal, 0);
    const a = w.row(8);
    assert.equal(a.processing_status, "failed");
    assert.equal(a.processing_terminal, false);
    assert.ok(Date.parse(a.processing_next_retry_at) > now.getTime(), "a retry is scheduled");
    assert.equal(w.tables.media_processing_attempts[0].status, "retryable_failure");
  });

  it("re-claims a FAILED asset once its retry clock is due, and skips one whose clock has not come round", async () => {
    const now = new Date();
    const w = makeWorld({
      flag: true,
      assets: [
        asset(10, { processing_status: "failed", processing_attempt_count: 1, processing_next_retry_at: new Date(now.getTime() - 1000).toISOString() }),
        asset(11, { processing_status: "failed", processing_attempt_count: 1, processing_next_retry_at: new Date(now.getTime() + 60_000).toISOString() }),
      ],
      attempts: [
        { media_asset_id: id(10), attempt_number: 1, lease_token: "t10", status: "retryable_failure" },
        { media_asset_id: id(11), attempt_number: 1, lease_token: "t11", status: "retryable_failure" },
      ],
      objects: { [obj(10)]: await jpeg(32, 32), [obj(11)]: await jpeg(32, 32) },
    });
    const r = await runMediaProcessingPass({ client: w.sc, now });
    assert.equal(r.completed, 1, JSON.stringify(r));
    assert.equal(r.notDue, 1);
    assert.equal(w.row(10).processing_status, "ready");
    assert.equal(w.row(10).processing_attempt_count, 2);
    assert.equal(w.row(11).processing_status, "failed");
    assert.deepEqual(w.downloads, [obj(10)]);
  });

  it("RECOVERS a stale lease: the lapsed `processing` row is failed for retry and its attempt recorded `recovered`", async () => {
    const now = new Date();
    const w = makeWorld({
      flag: true,
      assets: [asset(12, {
        processing_status: "processing", processing_attempt_count: 1,
        processing_lease_token: "lease-dead", processing_lease_until: new Date(now.getTime() - 60_000).toISOString(),
      })],
      attempts: [{ media_asset_id: id(12), attempt_number: 1, lease_token: "lease-dead", status: "claimed" }],
    });
    const r = await runMediaProcessingPass({ client: w.sc, now });
    assert.equal(r.recovered, 1, JSON.stringify(r));
    const a = w.row(12);
    assert.equal(a.processing_status, "failed");
    assert.equal(a.processing_lease_token, null);
    assert.equal(a.processing_terminal, false);
    assert.ok(Date.parse(a.processing_next_retry_at) > now.getTime());
    assert.equal(w.tables.media_processing_attempts[0].status, "recovered");
    assert.equal(r.notDue, 1, "recovered this pass, due on a later one");
  });

  it("never claims a READY asset, nor a live-leased one", async () => {
    const now = new Date();
    const w = makeWorld({
      flag: true,
      assets: [
        asset(13, { processing_status: "ready", width: 10, height: 10 }),
        asset(14, { processing_status: "processing", processing_lease_token: "live", processing_lease_until: new Date(now.getTime() + 60_000).toISOString() }),
      ],
    });
    const r = await runMediaProcessingPass({ client: w.sc, now });
    assert.equal(r.scanned, 0, JSON.stringify(r));
    assert.equal(r.recovered, 0);
    assert.equal(w.row(13).processing_status, "ready");
    assert.equal(w.row(14).processing_lease_token, "live");
    assert.equal(w.writesTo("media_assets").length, 0);
  });

  it("an owner's retry is followed through end to end: failed → queued (route) → ready (worker)", async () => {
    const w = makeWorld({
      flag: true,
      assets: [asset(15, { processing_status: "failed", processing_terminal: true, processing_attempt_count: 1 })],
      attempts: [{ media_asset_id: id(15), attempt_number: 1, lease_token: "old", status: "terminal_failure" }],
      objects: { [obj(15)]: await jpeg(40, 30) },
    });
    assert.deepEqual(await retryMediaProcessing(w.sc, id(15), OWNER), { ok: true, alreadyQueued: false });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 1, JSON.stringify(r));
    assert.equal(w.row(15).processing_status, "ready");
    assert.equal(w.row(15).width, 40);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The boot wiring
// ═════════════════════════════════════════════════════════════════════════════

/** Line comments stripped, so a commented-out call does not count (backgroundWorkerWiring.test.ts). */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s\/\/ .*$/gm, "");
}

describe("census-media §30 (MD338) — the worker is started at boot", () => {
  afterEach(() => {
    stopMediaProcessingWorker();
    mock.timers.reset();
    _setTestServiceClient(null);
  });

  it("src/index.ts imports startMediaProcessingWorker from the worker module and calls it", () => {
    const index = stripComments(readFileSync(join(SRC, "index.ts"), "utf8"));
    assert.match(index, /import \{ startMediaProcessingWorker \} from "\.\/lib\/media\/mediaProcessingWorker\.js"/);
    // A call, not merely an import (schedulerRegistration.test.ts's disguise).
    const calls = index
      .replace(/import\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g, "")
      .replace(/import\s+\w+\s+from\s*["'][^"']+["'];?/g, "");
    assert.match(calls, /\bstartMediaProcessingWorker\s*\(\s*\)/, "src/index.ts never calls startMediaProcessingWorker()");
  });

  it("arms once, runs the pass after the startup delay, re-arms after each pass, and stops", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let passes = 0;
    const settle = () => new Promise<void>((r) => setImmediate(r));
    assert.equal(_mediaProcessingWorkerArmed(), false);
    startMediaProcessingWorker({ runPass: async () => { passes += 1; } });
    startMediaProcessingWorker({ runPass: async () => { passes += 100; } });
    assert.equal(_mediaProcessingWorkerArmed(), true);
    mock.timers.tick(MEDIA_PROCESSING_STARTUP_DELAY_MS - 1);
    await settle();
    assert.equal(passes, 0, "nothing before the startup delay");
    mock.timers.tick(1);
    await settle(); await settle();
    assert.equal(passes, 1, "one pass at the startup delay, from the FIRST start only");
    mock.timers.tick(MEDIA_PROCESSING_INTERVAL_MS);
    await settle(); await settle();
    assert.equal(passes, 2, "re-armed after the pass");
    stopMediaProcessingWorker();
    assert.equal(_mediaProcessingWorkerArmed(), false);
    mock.timers.tick(MEDIA_PROCESSING_INTERVAL_MS * 5);
    await settle();
    assert.equal(passes, 2, "stopped means stopped");
  });

  it("with no arguments — exactly as src/index.ts calls it — runs the REAL pass against the service client", async () => {
    const w = makeWorld({ flag: true, assets: [asset(20)], objects: { [obj(20)]: await jpeg(24, 16) } });
    _setTestServiceClient(w.sc);
    mock.timers.enable({ apis: ["setTimeout"] });
    startMediaProcessingWorker();
    mock.timers.tick(MEDIA_PROCESSING_STARTUP_DELAY_MS);
    // Date is not mocked (only setTimeout is), so this bound is real time.
    const deadline = Date.now() + 10_000;
    while (w.row(20).processing_status !== "ready" && Date.now() < deadline) {
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(w.row(20).processing_status, "ready", "the boot-started loop claimed and completed the queued asset");
    assert.equal(w.row(20).width, 24);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Migration 3338
// ═════════════════════════════════════════════════════════════════════════════

describe("census-media §30 (MD338) — migration 3338", () => {
  it("seeds exactly the flag the service reads, FALSE, ON CONFLICT DO NOTHING, and is a seed, not DDL", () => {
    const sql = readFileSync(join(SRC, "migrations", "3338_media_processing_worker_flag.sql"), "utf8");
    assert.match(sql, new RegExp(`'${MEDIA_PROCESSING_WORKER_FLAG}',\\s*false,`));
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    const code = sql.replace(/--[^\n]*/g, "");
    assert.ok(!/\b(ALTER|CREATE|DROP)\s+(TABLE|TYPE|INDEX|POLICY|FUNCTION)\b/i.test(code), "3338 must be a seed, not DDL");
    assert.ok(!/UPDATE\s+public\.media_assets/i.test(code), "3338 must not transition any asset itself");
    assert.equal((code.match(/INSERT INTO/g) ?? []).length, 1);
    assert.match(code, /enabled = TRUE;\s*IF on_count <> 0 THEN\s*RAISE EXCEPTION/, "a seed that finds it ON refuses");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. census-media §32 — the dimension sweep finishes recordEntityMedia's rows
// ═════════════════════════════════════════════════════════════════════════════
//
// Imports are at the TAIL so no line above moves: census-media cites this file
// by line. ESM hoists them, so evaluation order is unchanged.
import { readdirSync } from "node:fs";
import { authorizeMediaAccess, _clearMediaAccessCache } from "../lib/mediaAccess.js";
import { probeVideoContainer } from "../lib/videoMetadata.js";
import { isEntityMediaSweepRow } from "../lib/media/mediaProcessingWorker.js";
import { webmWithoutLocationTag } from "./videoFixtures.js";

/** `media_attachments` as 0191 declares it. */
const ATTACHMENT_COLUMNS = [
  "id", "media_asset_id", "entity_type", "entity_id", "position", "is_cover", "visibility_override", "created_at",
];

/**
 * A row exactly as `recordEntityMedia` stages it (lib/mediaAssets.ts): size 0,
 * no dimensions, `processing`, no lease — plus the column defaults the
 * migrations give every column it does not send (0191 `visibility`, 3321
 * `moderation_status`, 2951's lifecycle columns via `asset()`).
 */
function staged(n: number, over: Row = {}): Row {
  return asset(n, {
    size_bytes: 0,
    width: null,
    height: null,
    processing_status: "processing",
    moderation_status: "processing",
    visibility: "inherit",
    source_type: "user",
    created_at: new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString(),
    ...over,
  });
}

/** The §6.1 link recordEntityMedia writes after the asset. */
function link(n: number, entityType: string, entityId: string): Row {
  return {
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`,
    media_asset_id: id(n),
    entity_type: entityType,
    entity_id: entityId,
    position: 0,
    is_cover: true,
    visibility_override: null,
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

/** `makeWorld` with `media_attachments` in it, under 0191's column list. */
function makeSweepWorld(w: World & { links?: Row[] }) {
  const tables: Record<string, Row[]> = {
    feature_flags: w.flag === undefined || w.flag === "unreadable"
      ? []
      : [{ flag: MEDIA_PROCESSING_WORKER_FLAG, enabled: w.flag }],
    media_assets: w.assets,
    media_processing_attempts: w.attempts ?? [],
    media_attachments: w.links ?? [],
  };
  const oracle = makeOracle({
    tables,
    columns: {
      media_assets: MEDIA_ASSET_COLUMNS,
      media_processing_attempts: ATTEMPT_COLUMNS,
      media_attachments: ATTACHMENT_COLUMNS,
    },
    unique: { media_processing_attempts: ["media_asset_id", "attempt_number"] },
    failReads: w.flag === "unreadable" ? { feature_flags: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined,
  });
  const objects = new Map(Object.entries(w.objects ?? {}));
  const downloads: string[] = [];
  const storageWrites: string[] = [];
  const sc: any = {
    from: (table: string) => oracle.client.from(table),
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            downloads.push(`${bucket}/${path}`);
            const b = objects.get(`${bucket}/${path}`);
            return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "Object not found" } };
          },
          async upload(path: string) { storageWrites.push(`upload ${bucket}/${path}`); return { error: { message: "refused by the test" } }; },
          async remove(paths: string[]) { storageWrites.push(`remove ${bucket}/${paths.join(",")}`); return { error: { message: "refused by the test" } }; },
        };
      },
    },
  };
  const writesTo = (table: string) =>
    oracle.log.filter((r) => r.method !== "GET" && r.method !== "HEAD" && new URL(r.url).pathname.endsWith(`/${table}`));
  const row = (n: number) => tables.media_assets.find((r) => r.id === id(n))!;
  return { sc, oracle, tables, objects, downloads, storageWrites, writesTo, row };
}

describe("census-media §32 — the dimension sweep finishes recordEntityMedia's staged rows", () => {
  const MEMORY = id(900);
  const GEM = id(901);
  const POSTCARD = id(902);
  const POST = id(903);

  it("sweeps a memory, hidden-gem, postcard and post-link image to READY with the measured width, height and SIZE — and never writes storage", async () => {
    const images = { 30: await jpeg(64, 48), 31: await jpeg(40, 90), 32: await jpeg(120, 30), 33: await jpeg(17, 23) };
    const w = makeSweepWorld({
      flag: true,
      assets: [staged(30), staged(31), staged(32), staged(33)],
      links: [link(30, "memory", MEMORY), link(31, "hidden_gem", GEM), link(32, "postcard", POSTCARD), link(33, "post", POST)],
      objects: { [obj(30)]: images[30], [obj(31)]: images[31], [obj(32)]: images[32], [obj(33)]: images[33] },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.staged, 4, JSON.stringify(r));
    assert.equal(r.claimed, 4);
    assert.equal(r.completed, 4);
    const expected: Record<number, [number, number]> = { 30: [64, 48], 31: [40, 90], 32: [120, 30], 33: [17, 23] };
    for (const n of [30, 31, 32, 33] as const) {
      const a = w.row(n);
      assert.equal(a.processing_status, "ready", `asset ${n}`);
      assert.deepEqual([a.width, a.height], expected[n], `asset ${n}: measured, not guessed`);
      assert.equal(a.size_bytes, images[n].length, `asset ${n}: the honest zero became the stored object's size`);
      assert.equal(a.processing_lease_token, null);
      assert.equal(a.processing_error, null);
      assert.equal(a.processing_attempt_count, 1);
    }
    assert.deepEqual(w.tables.media_processing_attempts.map((t) => t.status), ["succeeded", "succeeded", "succeeded", "succeeded"]);
    assert.deepEqual(w.storageWrites, [], "the sweep never writes storage");
  });

  it("sweeps an entity VIDEO with the container's display size, its stated duration and its size; FAILS terminally one whose container states no size", async () => {
    const plain = Buffer.from(PLAIN_MP4);
    const silent = webmWithoutLocationTag();
    const w = makeSweepWorld({
      flag: true,
      assets: [
        staged(34, { media_type: "video", mime_type: "video/mp4", storage_path: `${OWNER}/34.mp4` }),
        staged(35, { media_type: "video", mime_type: "video/mp4", storage_path: `${OWNER}/35.webm` }),
      ],
      links: [link(34, "memory", MEMORY), link(35, "memory", MEMORY)],
      objects: { [obj(34, "mp4")]: plain, [obj(35, "webm")]: silent },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 1, JSON.stringify(r));
    assert.equal(r.terminal, 1);
    const v = w.row(34);
    assert.equal(v.processing_status, "ready");
    assert.deepEqual([v.width, v.height], [64, 48]);
    const stated = probeVideoContainer(Buffer.from(PLAIN_MP4))?.durationMs ?? null;
    assert.ok(stated !== null && stated > 0, "fixture: the container states a duration");
    assert.equal(v.duration_ms, stated, "the container's duration, not a guess");
    assert.equal(v.size_bytes, plain.length);
    const s = w.row(35);
    assert.equal(s.processing_status, "failed");
    assert.equal(s.processing_terminal, true);
    assert.match(s.processing_error, /no display size/);
    assert.equal(s.width, null);
    assert.equal(s.size_bytes, 0, "a failed row keeps its honest zero");
  });

  it("FAILS terminally, never ready, a staged entity still whose stored bytes carry a GPS IFD — no dimensions, no size written", async () => {
    const w = makeSweepWorld({
      flag: true,
      assets: [staged(36)],
      links: [link(36, "memory", MEMORY)],
      objects: { [obj(36)]: withGpsIfd(await jpeg(64, 48)) },
    });
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.claimed, 1, JSON.stringify(r));
    assert.equal(r.completed, 0);
    const a = w.row(36);
    assert.equal(a.processing_status, "failed");
    assert.equal(a.processing_terminal, true);
    assert.match(a.processing_error, /GPS/);
    assert.equal(a.width, null);
    assert.equal(a.height, null);
    assert.equal(a.size_bytes, 0);
  });

  it("never claims the upload route's dimensionless VIDEO (its size is recorded; this tier cannot measure it), a live-leased staged row, or an unattached one — while a linked staged row in the same pass IS swept", async () => {
    const now = new Date();
    const silent = webmWithoutLocationTag();
    const upload = asset(60, {
      processing_status: "processing", media_type: "video", mime_type: "video/webm",
      storage_path: `${OWNER}/60.webm`, size_bytes: silent.length, width: null, height: null,
      thumbnail_path: `${OWNER}/60.webm.poster.jpg`, visibility: "inherit",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const leased = staged(61, {
      processing_lease_token: "live", processing_lease_until: new Date(now.getTime() + 60_000).toISOString(), processing_attempt_count: 1,
    });
    const orphan = staged(62);
    const linked = staged(63);
    const w = makeSweepWorld({
      flag: true,
      assets: [upload, leased, orphan, linked],
      // The upload row is linked too (recordPostMediaAttachments reuses it), so
      // the attachment is not what keeps it out: its recorded size is.
      links: [link(60, "post", POST), link(61, "memory", MEMORY), link(63, "memory", MEMORY)],
      objects: { [obj(60, "webm")]: silent, [obj(61)]: await jpeg(8, 8), [obj(62)]: await jpeg(8, 8), [obj(63)]: await jpeg(8, 8) },
    });
    const before = structuredClone([w.row(60), w.row(61), w.row(62)]);
    const r = await runMediaProcessingPass({ client: w.sc, now });
    assert.equal(r.completed, 1, JSON.stringify(r));
    assert.equal(r.staged, 1);
    assert.equal(r.unattached, 1, "the orphan is seen and left");
    assert.equal(w.row(63).processing_status, "ready", "CONTROL: the sweep ran");
    assert.deepEqual([w.row(60), w.row(61), w.row(62)], before, "untouched: no claim, no lease, no attempt");
    assert.deepEqual(w.downloads, [obj(63)]);
    assert.deepEqual(w.tables.media_processing_attempts.map((t) => t.media_asset_id), [id(63)]);
  });

  it("GATED OFF: with staged entity rows waiting, one flag read and nothing else", async () => {
    for (const flag of [false, undefined, "unreadable"] as const) {
      const w = makeSweepWorld({
        flag,
        assets: [staged(64)],
        links: [link(64, "memory", MEMORY)],
        objects: { [obj(64)]: await jpeg(8, 8) },
      });
      const before = structuredClone(w.row(64));
      const r = await runMediaProcessingPass({ client: w.sc });
      assert.equal(r.reason, "disabled");
      assert.equal(r.claimed, 0);
      assert.equal(w.oracle.requests(), 1, `flag ${String(flag)}: only the flag read`);
      assert.deepEqual(w.downloads, []);
      assert.deepEqual(w.row(64), before);
    }
  });

  it("a staged row whose object could not be read is failed for retry — then completed by the claimable path WITH its measured size", async () => {
    const now = new Date();
    const w = makeSweepWorld({ flag: true, assets: [staged(65)], links: [link(65, "hidden_gem", GEM)], objects: {} });
    const first = await runMediaProcessingPass({ client: w.sc, now });
    assert.equal(first.failed, 1, JSON.stringify(first));
    assert.equal(w.row(65).processing_status, "failed");
    assert.equal(w.row(65).processing_terminal, false);
    assert.equal(w.row(65).size_bytes, 0);
    const bytes = await jpeg(33, 44);
    w.objects.set(obj(65), bytes);
    const later = new Date(now.getTime() + 10 * 60_000);
    const second = await runMediaProcessingPass({ client: w.sc, now: later });
    assert.equal(second.staged, 0, "no longer staged: it is claimable work now");
    assert.equal(second.completed, 1, JSON.stringify(second));
    const a = w.row(65);
    assert.equal(a.processing_status, "ready");
    assert.deepEqual([a.width, a.height], [33, 44]);
    assert.equal(a.size_bytes, bytes.length, "the claimable path writes the size too");
    assert.equal(a.processing_attempt_count, 2);
  });

  it("keeps §30.3's per-pass bound: the sweep takes only what the DUE claimable work leaves, oldest first", async () => {
    const now = new Date();
    const w = makeSweepWorld({
      flag: true,
      assets: [
        asset(80),
        asset(81, { processing_status: "failed", processing_attempt_count: 1, processing_next_retry_at: new Date(now.getTime() + 60_000).toISOString() }),
        staged(82),
        staged(83),
      ],
      attempts: [{ media_asset_id: id(81), attempt_number: 1, lease_token: "t81", status: "retryable_failure" }],
      links: [link(82, "memory", MEMORY), link(83, "memory", MEMORY)],
      objects: { [obj(80)]: await jpeg(8, 8), [obj(81)]: await jpeg(8, 8), [obj(82)]: await jpeg(8, 8), [obj(83)]: await jpeg(8, 8) },
    });
    const r = await runMediaProcessingPass({ client: w.sc, now, limit: 2 });
    assert.equal(r.notDue, 1, JSON.stringify(r));
    assert.equal(r.staged, 1, "limit 2, one DUE claimable item: one staged row");
    assert.equal(r.claimed, 2);
    assert.equal(w.row(80).processing_status, "ready");
    assert.equal(w.row(82).processing_status, "ready", "the OLDER staged row");
    assert.equal(w.row(83).processing_status, "processing");
    assert.equal(w.row(83).processing_attempt_count, 0);

    const full = makeSweepWorld({
      flag: true,
      assets: [asset(84), staged(85)],
      links: [link(85, "memory", MEMORY)],
      objects: { [obj(84)]: await jpeg(8, 8), [obj(85)]: await jpeg(8, 8) },
    });
    const f = await runMediaProcessingPass({ client: full.sc, now, limit: 1 });
    assert.equal(f.staged, 0, JSON.stringify(f));
    assert.equal(full.row(85).processing_status, "processing");
    assert.ok(
      !full.oracle.log.some((q) => new URL(q.url).pathname.endsWith("/media_attachments")),
      "no budget left: the sweep does not even read",
    );
  });

  it("isEntityMediaSweepRow is exactly recordEntityMedia's signature", () => {
    const base = { id: id(1), processing_status: "processing", processing_lease_token: null, size_bytes: 0, width: null, height: null, processing_terminal: false };
    assert.equal(isEntityMediaSweepRow(base), true);
    for (const [why, over] of [
      ["a recorded size (the upload route)", { size_bytes: 5702 }],
      ["no size at all", { size_bytes: null }],
      ["a width", { width: 10 }],
      ["a height", { height: 10 }],
      ["a lease", { processing_lease_token: "t" }],
      ["queued", { processing_status: "queued" }],
      ["failed", { processing_status: "failed" }],
      ["ready", { processing_status: "ready" }],
      ["terminal", { processing_terminal: true }],
      ["no id", { id: undefined }],
    ] as const) {
      assert.equal(isEntityMediaSweepRow({ ...base, ...over }), false, why);
    }
    assert.equal(isEntityMediaSweepRow(null), false);
  });
});

// ── The byte gate, driven by the fake mediaAccess.test.ts uses ────────────────
//
// A COPY of `makeClient`'s query builder in src/test/mediaAccess.test.ts — the
// same filter semantics (eq / in / is / contains / overlaps / a real top-level
// `or`), the same live-column enforcement for the tables it enforces — keyed by
// table name instead of by FakeState field. It is copied, not imported: that
// file does not export it, and importing a test file runs its suites.

const BYTE_GATE_LIVE_COLUMNS: Record<string, readonly string[]> = {
  user_follows: ["follower_id", "following_id", "created_at"],
  post_media: [
    "id", "post_id", "user_id", "media_type", "mime_type", "storage_bucket",
    "storage_path", "public_url", "thumbnail_storage_path", "thumbnail_url",
    "feed_storage_path", "feed_url", "width", "height", "duration_seconds",
    "file_size_bytes", "sort_order", "moderation_status", "processing_status",
    "phash", "dedup_processed", "canonical_place_id", "stamp_overlay",
    "created_at", "updated_at",
  ],
  media_attachments: ATTACHMENT_COLUMNS,
  circle_member_visibility_overrides: [
    "id", "user_id", "target_user_id", "context_type",
    "context_id", "direction", "hidden", "created_at",
  ],
};

function byteGateClient(tables: Record<string, Row[]>): any {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let unknownColumn: string | null = null;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const undefinedColumn = () => ({ data: null, error: { code: "42703", message: `column ${table}.${unknownColumn} does not exist` } });
    const b: any = {
      select(cols?: string) {
        if (typeof cols === "string" && cols !== "*") {
          const live = BYTE_GATE_LIVE_COLUMNS[table];
          if (live) unknownColumn = cols.split(",").map((c) => c.trim()).filter(Boolean).find((c) => !live.includes(c)) ?? null;
        }
        return b;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      contains(col: string, vals: any[]) { filters.push((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v))); return b; },
      overlaps(col: string, vals: any[]) { filters.push((r) => Array.isArray(r[col]) && vals.some((v) => r[col].includes(v))); return b; },
      or(expr: string) {
        const clauses: string[] = [];
        let depth = 0, cur = "";
        for (const ch of expr) {
          if (ch === "(") depth++;
          if (ch === ")") depth--;
          if (ch === "," && depth === 0) { clauses.push(cur); cur = ""; continue; }
          cur += ch;
        }
        if (cur.trim()) clauses.push(cur);
        const preds = clauses.map((c) => {
          const m = c.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
          if (!m) return () => false;
          const [, col, op, rawVal] = m;
          if (op === "in") {
            const vals = (rawVal.match(/"((?:[^"\\]|\\.)*)"/g) ?? []).map((q) => q.slice(1, -1).replace(/\\"/g, '"'));
            return (r: any) => vals.includes(String(r[col]));
          }
          return (r: any) => String(r[col]) === rawVal;
        });
        filters.push((r) => preds.some((f) => f(r)));
        return b;
      },
      limit() { return b; }, not() { return b; }, order() { return b; },
      maybeSingle() {
        if (unknownColumn) return Promise.resolve(undefinedColumn());
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        if (unknownColumn) return Promise.resolve(undefinedColumn()).then(onF, onR);
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { from: builder };
}

describe("census-media §32 — PRIVACY: a swept entity asset reaches nobody its entity would not be shown to", () => {
  const FOLLOWER = "33333333-3333-4333-8333-333333333333";
  const MEMORY = id(910);
  const GEM = id(911);
  const POSTCARD = id(912);
  const PRIVATE_POST = id(913);
  const PUBLIC_POST = id(914);
  const OLD_SUPABASE_URL = process.env.SUPABASE_URL;
  before(() => { process.env.SUPABASE_URL = "http://sb.example.test"; });
  after(() => { process.env.SUPABASE_URL = OLD_SUPABASE_URL; });

  /** The objects each file belongs to, as their own tables hold them (decide() reads none of the first three). */
  const entityTables = (): Record<string, Row[]> => ({
    passport_memories: [{ id: MEMORY, user_id: OWNER, status: "active", visibility: "private", photo_url: `${BUCKET}/${OWNER}/40.jpg` }],
    hidden_gems: [{ id: GEM, submitted_by: OWNER, status: "pending", image_url: `${BUCKET}/${OWNER}/41.jpg` }],
    passport_postcards: [{ id: POSTCARD, post_id: PRIVATE_POST, user_id: OWNER, status: "active", visibility: "private", media_url: `${BUCKET}/${OWNER}/42.jpg` }],
    posts: [
      { id: PRIVATE_POST, author_id: OWNER, visibility: "private", status: "active", post_status: "published", trip_id: null, media_urls: [`${BUCKET}/${OWNER}/42.jpg`] },
      { id: PUBLIC_POST, author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null, media_urls: [`${BUCKET}/${OWNER}/43.jpg`] },
    ],
    post_media: [
      { post_id: PRIVATE_POST, storage_path: `${OWNER}/42.jpg`, moderation_status: "approved", processing_status: "ready" },
      { post_id: PUBLIC_POST, storage_path: `${OWNER}/43.jpg`, moderation_status: "approved", processing_status: "ready" },
    ],
    user_follows: [{ follower_id: FOLLOWER, following_id: OWNER, created_at: "2026-01-01T00:00:00.000Z" }],
    blocks: [],
  });

  it("a PRIVATE memory's photo, a hidden gem's photo and a private post's postcard, swept READY, are refused to a stranger and to a follower exactly as before the sweep; a PUBLIC post's file is the control", async () => {
    const w = makeSweepWorld({
      flag: true,
      assets: [staged(40), staged(41), staged(42), staged(43)],
      links: [link(40, "memory", MEMORY), link(41, "hidden_gem", GEM), link(42, "postcard", POSTCARD), link(43, "post", PUBLIC_POST)],
      objects: { [obj(40)]: await jpeg(40, 30), [obj(41)]: await jpeg(41, 30), [obj(42)]: await jpeg(42, 30), [obj(43)]: await jpeg(43, 30) },
    });
    const viewers = { stranger: STRANGER, follower: FOLLOWER, owner: OWNER } as const;
    const decisions = async () => {
      const out: Record<string, Record<string, boolean>> = {};
      for (const n of [40, 41, 42, 43]) {
        out[n] = {};
        for (const [who, viewer] of Object.entries(viewers)) {
          _clearMediaAccessCache();
          // The byte gate reads the canonical rows exactly as the sweep left them.
          const gate = byteGateClient({
            ...entityTables(),
            media_assets: structuredClone(w.tables.media_assets),
            media_attachments: structuredClone(w.tables.media_attachments),
          });
          out[n][who] = await authorizeMediaAccess(gate, viewer, BUCKET, `${OWNER}/${n}.jpg`);
        }
      }
      return out;
    };

    const before = await decisions();
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 4, JSON.stringify(r));
    for (const n of [40, 41, 42, 43]) {
      assert.equal(w.row(n).processing_status, "ready", `asset ${n}: the sweep really did publish it as ready`);
      assert.equal(w.row(n).visibility, "inherit", `asset ${n}: still inherits its entity's audience`);
    }
    const after = await decisions();

    for (const n of [40, 41, 42]) {
      assert.deepEqual(after[n], { stranger: false, follower: false, owner: true }, `asset ${n}: only its owner, after the sweep`);
    }
    assert.deepEqual(after[43], { stranger: true, follower: true, owner: true }, "CONTROL: a file a PUBLIC post publishes is served — the double can say yes");
    assert.deepEqual(after, before, "ready changed no viewer's access to any object");
  });

  it("the sweep writes lifecycle, dimension and size columns only — never visibility, owner, moderation, a storage key or an attachment — and never `ready` without both dimensions (2089)", async () => {
    const w = makeSweepWorld({
      flag: true,
      assets: [
        staged(44),
        staged(45, { media_type: "video", mime_type: "video/mp4", storage_path: `${OWNER}/45.mp4` }),
        staged(46),
      ],
      links: [link(44, "memory", MEMORY), link(45, "postcard", POSTCARD), link(46, "hidden_gem", GEM)],
      objects: { [obj(44)]: await jpeg(20, 10), [obj(45, "mp4")]: Buffer.from(PLAIN_MP4), [obj(46)]: withGpsIfd(await jpeg(20, 10)) },
    });
    const PROTECTED = ["owner_user_id", "uploader_user_id", "storage_bucket", "storage_path", "public_url", "visibility", "moderation_status", "source_type", "media_type", "provenance", "location_visibility"];
    const snapshot = () => w.tables.media_assets.map((a) => Object.fromEntries(PROTECTED.map((k) => [k, a[k]])));
    const before = structuredClone(snapshot());
    const r = await runMediaProcessingPass({ client: w.sc });
    assert.equal(r.completed, 2, JSON.stringify(r));
    assert.equal(r.failed, 1);

    const ALLOWED = new Set([
      "processing_status", "processing_attempt_count", "processing_last_attempt_at", "processing_lease_until",
      "processing_lease_token", "processing_error", "processing_completed_at", "processing_next_retry_at",
      "processing_terminal", "width", "height", "duration_ms", "thumbnail_path", "thumbnail_url", "size_bytes", "updated_at",
    ]);
    const patches = w.writesTo("media_assets");
    assert.ok(patches.length > 0);
    for (const p of patches) {
      assert.equal(p.method, "PATCH", "the sweep only updates rows it recognised; it inserts none");
      const body = JSON.parse(p.body ?? "{}");
      for (const k of Object.keys(body)) assert.ok(ALLOWED.has(k), `the sweep wrote ${k}`);
      if (body.processing_status === "ready") {
        assert.ok(Number.isInteger(body.width) && body.width > 0 && Number.isInteger(body.height) && body.height > 0,
          "2089: ready and both dimensions in ONE statement");
      }
    }
    assert.equal(w.writesTo("media_attachments").length, 0, "no attachment is written, moved or widened");
    assert.deepEqual(snapshot(), before);
  });

  it("the proof's premises are in the tree: each canonical reader that serves a READY asset to a non-owner resolves it through a POST, and the byte gate reads the canonical row for its owner only", () => {
    const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
    // (1) The projection's canonical read is `post` unless a caller names another
    //     entity type, and its one caller names none.
    assert.match(read("lib/media/mediaCanonicalRead.ts"), /const entityType = opts\.entityType \?\? "post";/);
    const callers: string[] = [];
    for (const f of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f.startsWith("test")) continue;
      const src = stripComments(read(f));
      for (const m of src.matchAll(/\battachCanonicalMedia\s*\(([^)]*)\)/g)) {
        if (/function\s+attachCanonicalMedia\s*\($/.test(src.slice(Math.max(0, m.index! - 40), m.index! + "attachCanonicalMedia(".length))) continue;
        callers.push(`${f}: ${m[1]!.trim()}`);
      }
    }
    assert.deepEqual(callers, ["services/media/MediaProjectionService.ts: sc, rows"]);
    // (2) The Wall's Quick Media serves a ready asset only through a post or
    //     postcard attachment (or a post_media row), then only if that POST is
    //     the owner's and readable by this viewer.
    const wall = read("services/wall/WallCandidateLoaders.ts");
    assert.match(wall, /\.in\("entity_type", \["post", "postcard"\]\)/);
    assert.match(wall, /readableByPost\.set\(pid, active && published && decidePostReadable\(p, viewerId, tripMember\)\.readable\);/);
    assert.match(wall, /if \(String\(post\.author_id\) !== ownerId\) continue;/);
    // (3) The byte gate reads the canonical row once, for owner attribution.
    const gate = read("lib/mediaAccess.ts");
    assert.equal((gate.match(/\.from\("media_assets"\)/g) ?? []).length, 1);
    assert.match(gate, /\.from\("media_assets"\)\s*\.select\("id, owner_user_id"\)/);
    // (4) Telegraph's MEDIA share needs `public` for a non-owner, and the
    //     canonical writer never sends `visibility` (0191 defaults it to inherit).
    assert.match(read("services/telegraph/shareables.ts"), /if \(!mine\) \{\s*if \(r\.visibility !== "public"\) return \{ state: UNAVAILABLE\("private"\), projection: null \};/);
    assert.doesNotMatch(read("lib/mediaAssets.ts"), /\bvisibility\s*:/);
  });
});
