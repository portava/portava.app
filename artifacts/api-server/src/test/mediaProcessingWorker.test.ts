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
