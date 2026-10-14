/**
 * §20 "Original, viewer, card, and tiny renditions should be distinct signed
 * derivatives" — census-highlights-memories H182, B58 MEM-RENDITIONS, migration
 * 3808 (`media_asset_renditions`).
 *
 * Over the REAL memories router, with a fake database and a fake object store
 * seeded with exactly what POST /media/upload leaves behind — produced by the
 * upload's own functions (processImage, makeThumbnail, makeFeedVariant) from a
 * real JPEG that carries GPS EXIF:
 *
 *   R1  after ADD_MEDIA of an image, four DISTINCT objects/paths are registered
 *       (original, the upload's feed variant as viewer, its thumbnail as card,
 *       and a generated tiny), and the tiny object in storage is <= 64 px and
 *       carries NO EXIF — even when the stored original still carried GPS
 *   R2  a NON-OWNER's GET (detail, list cover, trip cover) returns no `original`
 *       anywhere — not as a key, not as the path — and is served the viewer;
 *       the owner gets all four
 *   R3  a rendition failure never fails the write, and never registers a
 *       broken path; a failed registration removes what it generated
 *   R4  §21: deleting the Memory (DERIVATIVES_PURGED) and removing the item
 *       (REMOVE_MEDIA) delete the rows and the objects the Memory service
 *       wrote, never the upload's own objects, and nothing while a live Memory
 *       item still shows the object; account deletion collects every rung
 *   R5  3808 not applied: nothing is generated, nothing is read beyond the one
 *       probe, and every response is today's
 *   R6  video: viewer IS the original (reported, not hidden), card and tiny
 *       come from the poster
 *   R7  the TS ladder, rung names and mimes equal 3808's SQL
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryMediaRenditions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import {
  FEED_DIM,
  THUMBNAIL_DIM,
  TINY_DIM,
  makeFeedVariant,
  makeThumbnail,
  makeTinyVariant,
  processImage,
  sniffMedia,
} from "../lib/mediaProcessing.js";
import { exifFactsFrom } from "../lib/exifFacts.js";
import {
  LADDER_MAX_EDGE,
  RENDITION_MIMES,
  RENDITION_NAMES,
  collectAccountRenditionPaths,
  purgeRenditionsForMediaUrls,
  readRenditionsForItems,
  registerMemoryItemRenditions,
  registerWithinBudget,
  renditionLayoutFor,
  withinLadder,
} from "../services/memory/memoryMediaRenditions.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js";
import { SERVER_ONLY_TABLES } from "../scripts/lib/serverOnlyTables.js";
import { loadContract } from "../security/authorizationContract.js";
import { listStorageCleanupHooks } from "../services/accountDeletion/hooks.js";
import { ERASED_BY_CASCADE, POST_BASELINE_TABLES } from "../lib/deletionDispositions.js";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
const ORIGIN = new URL(process.env.SUPABASE_URL!).origin;
const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(resolve(__dir, "../migrations/3808_media_asset_renditions.sql"), "utf8");

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEM = "11111111-1111-4111-8111-111111111111";
const MEM2 = "11111111-1111-4111-8111-111111111112";
const TRIP = "44444444-4444-4444-8444-444444444444";
const ASSET = "33333333-3333-4333-8333-333333333333";
const VASSET = "33333333-3333-4333-8333-333333333334";
const BUCKET = "post-media";
const STEM = `${OWNER}/1760000000000`;
const ORIGINAL = `${STEM}.jpg`;
const FEED = `${STEM}.feed.jpg`;
const THUMB = `${STEM}.thumb.jpg`;
const TINY = `${STEM}.tiny.jpg`;
const VSTEM = `${OWNER}/1760000000999`;
const VIDEO = `${VSTEM}.mp4`;
const POSTER = `${VIDEO}.poster.jpg`;
const abs = (path: string) => `${ORIGIN}/storage/v1/object/public/${BUCKET}/${path}`;
const MEDIA_URL = abs(ORIGINAL);

// ── Fixtures: what /media/upload leaves behind, made by its own functions ────

const SENTINEL = "PORTAVA_H182_EXIF_SENTINEL";
const EXIF_MARKER = Buffer.from("Exif\0\0", "latin1");

/** A real JPEG carrying GPS EXIF, a sentinel and an orientation tag. */
async function gpsJpeg(width = 2400, height = 1600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#3a5" } })
    .withExif({
      IFD0: { Copyright: SENTINEL },
      // IFD3 is sharp's GPS IFD. (`GPS:` is silently ignored by sharp — measured: exifFacts finds no GPS IFD with it.)
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

async function assertNoMetadata(buf: Buffer, what: string): Promise<void> {
  const meta = await sharp(buf).metadata();
  assert.equal(meta.exif, undefined, `${what}: no EXIF block`);
  assert.equal(meta.orientation, undefined, `${what}: no orientation tag`);
  assert.equal(buf.includes(EXIF_MARKER), false, `${what}: no Exif APP1 marker in the bytes`);
  assert.equal(buf.includes(Buffer.from(SENTINEL, "latin1")), false, `${what}: the planted sentinel is gone`);
  const facts = exifFactsFrom(buf);
  assert.ok(facts !== null, `${what}: the JPEG was scanned`);
  assert.equal(facts!.hasExif, false, `${what}: exifFacts finds no EXIF`);
  assert.equal(facts!.hasGpsIfd, false, `${what}: exifFacts finds no GPS IFD`);
}

interface UploadSet { original: Buffer; feed: Buffer; thumb: Buffer; width: number; height: number }
let uploadSetCache: UploadSet | null = null;
async function uploadSet(): Promise<UploadSet> {
  if (uploadSetCache) return uploadSetCache;
  const raw = await gpsJpeg();
  const processed = await processImage(raw, sniffMedia(raw)!);
  const thumb = await makeThumbnail(processed.buffer);
  const feed = await makeFeedVariant(processed.buffer);
  uploadSetCache = { original: processed.buffer, feed: feed.buffer, thumb: thumb.buffer, width: processed.width, height: processed.height };
  return uploadSetCache;
}

// ── Fake object store ────────────────────────────────────────────────────────

interface StorageFail { op: "list" | "download" | "upload" | "remove"; path?: string; error?: any }
class FakeStorage {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  ops: Array<{ op: string; path: string }> = [];
  fails: StorageFail[] = [];
  key(bucket: string, path: string) { return `${bucket}/${path}`; }
  put(bucket: string, path: string, body: Buffer, contentType = "image/jpeg") { this.objects.set(this.key(bucket, path), { body, contentType }); }
  has(bucket: string, path: string) { return this.objects.has(this.key(bucket, path)); }
  get(bucket: string, path: string) { return this.objects.get(this.key(bucket, path))?.body ?? null; }
  failing(op: StorageFail["op"], path: string) {
    const f = this.fails.find((x) => x.op === op && (x.path === undefined || x.path === path));
    return f ? (f.error ?? { message: `injected ${op} failure`, statusCode: "500" }) : null;
  }
  from(bucket: string) {
    return {
      list: async (folder: string, opts?: { search?: string }) => {
        this.ops.push({ op: "list", path: folder });
        const e = this.failing("list", folder); if (e) return { data: null, error: e };
        const prefix = folder ? `${bucket}/${folder}/` : `${bucket}/`;
        const names = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes("/"));
        return { data: names.filter((n) => !opts?.search || n.includes(opts.search)).map((name) => ({ name })), error: null };
      },
      download: async (path: string) => {
        this.ops.push({ op: "download", path });
        const e = this.failing("download", path); if (e) return { data: null, error: e };
        const o = this.objects.get(this.key(bucket, path));
        if (!o) return { data: null, error: { message: "Object not found", statusCode: "404" } };
        return { data: new Blob([o.body]), error: null };
      },
      upload: async (path: string, body: Buffer, opts: { contentType: string; upsert: boolean }) => {
        this.ops.push({ op: "upload", path });
        const e = this.failing("upload", path); if (e) return { error: e };
        if (!opts.upsert && this.objects.has(this.key(bucket, path))) return { error: { message: "The resource already exists", statusCode: "409" } };
        this.objects.set(this.key(bucket, path), { body: Buffer.from(body), contentType: opts.contentType });
        return { error: null };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) this.ops.push({ op: "remove", path: p });
        const e = paths.map((p) => this.failing("remove", p)).find(Boolean); if (e) return { data: null, error: e };
        const gone = paths.filter((p) => this.objects.delete(this.key(bucket, p)));
        return { data: gone.map((name) => ({ name })), error: null };
      },
    };
  }
}

// ── Fake database ────────────────────────────────────────────────────────────

interface DbFail { table: string; op?: "select" | "insert" | "upsert" | "delete" | "update"; error: any; times?: number }
interface FakeOpts { absent?: Set<string>; fails?: DbFail[] }
const PROJECTED = new Set(["media_asset_renditions", "media_assets", "memory_items"]);

function makeDb(store: Record<string, any[]>, opts: FakeOpts = {}) {
  const reads: string[] = [];
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "update" | "insert" | "delete" | "upsert" = "select";
    let payload: any = null; let selected: string | null = null; let wantRows = false; let single = false; let countMode = false;
    let onConflict: string[] = []; let ignoreDuplicates = false; let limitN: number | null = null;
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(c?: string, o?: any) { if (mode !== "select") wantRows = true; else if (typeof c === "string") selected = c; if (o?.count === "exact" && o?.head) countMode = true; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o?: any) { mode = "upsert"; payload = d; onConflict = String(o?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); ignoreDuplicates = Boolean(o?.ignoreDuplicates); return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f((r) => r[c] === v),
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      or: (expr: string) => f((r) => expr.split(",").some((term) => { const [c, op, ...v] = term.split("."); return op === "eq" && String(r[c]) === v.join("."); })),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; },
      not() { return obj; }, order() { return obj; }, range() { return obj; }, contains() { return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      reads.push(`${table}.${mode}`);
      if (opts.absent?.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      const fail = opts.fails?.find((x) => x.table === table && (!x.op || x.op === mode) && (x.times === undefined || x.times > 0));
      if (fail) { if (fail.times !== undefined) fail.times -= 1; return { data: null, error: fail.error }; }
      const all = (store[table] ??= []);
      const matched = all.filter((r) => filters.every((p) => p(r)));
      const project = (r: any) => (PROJECTED.has(table) && selected && !/[*()]/.test(selected)
        ? Object.fromEntries(selected.split(",").map((k) => k.trim()).map((k) => [k, r[k]]))
        : { ...r });
      const one = (rows: any[] | null) => (single ? (rows?.[0] ?? null) : rows);
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? one(matched.map((x) => ({ ...x }))) : null, error: null }; }
      if (mode === "insert" || mode === "upsert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const had = onConflict.length ? all.find((x) => onConflict.every((k) => x[k] === r[k])) : null;
          if (had) { if (!ignoreDuplicates) { Object.assign(had, r); written.push(had); } continue; }
          const row = { id: r.id ?? `row-${table}-${all.length + 1}`, created_at: "2026-10-14T00:00:00.000Z", ...r };
          all.push(row); written.push(row);
        }
        return { data: wantRows ? one(written.map((x) => project(x))) : null, error: null };
      }
      if (mode === "delete") {
        store[table] = all.filter((r) => !filters.every((p) => p(r)));
        return { data: wantRows ? one(matched.map((x) => project(x))) : null, error: null };
      }
      if (countMode) return { data: null, error: null, count: matched.length };
      const rows = limitN === null ? matched : matched.slice(0, limitN);
      if (single) return { data: rows[0] ? project(rows[0]) : null, error: null };
      return { data: rows.map((x) => project(x)), error: null };
    }
    return obj;
  }
  return { from: (t: string) => chain(t), reads };
}

function makeClient(store: Record<string, any[]>, storage: FakeStorage, opts: FakeOpts = {}) {
  const db = makeDb(store, opts);
  return {
    from: db.from,
    reads: db.reads,
    storage,
    rpc: async () => ({ data: [], error: null }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

function memoryRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Dinner", caption: null, visibility: "public",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: TRIP, event_id: null, place_id: null,
    location_city: null, location_country: null, location_lat: null, location_lng: null,
    canonical_location_id: null, starts_at: null, ends_at: null, state: "published",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...extra,
  };
}

async function seedWorld(opts: { originalBytes?: Buffer; withFeed?: boolean; withThumb?: boolean; asset?: boolean } = {}) {
  const u = await uploadSet();
  const storage = new FakeStorage();
  storage.put(BUCKET, ORIGINAL, opts.originalBytes ?? u.original);
  if (opts.withFeed !== false) storage.put(BUCKET, FEED, u.feed);
  if (opts.withThumb !== false) storage.put(BUCKET, THUMB, u.thumb);
  const store: Record<string, any[]> = {
    feature_flags: [], blocks: [],
    memories: [memoryRow(MEM)],
    memory_items: [],
    memory_tags: [], memory_likes: [], memory_saves: [],
    trips: [{ id: TRIP, owner_id: OWNER, title: "T", status: "active", visibility: "public" }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
    ],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
    ],
    media_assets: opts.asset === false ? [] : [{
      id: ASSET, owner_user_id: OWNER, uploader_user_id: OWNER, storage_bucket: BUCKET, storage_path: ORIGINAL,
      media_type: "image", mime_type: "image/jpeg", width: u.width, height: u.height, deleted_at: null,
      thumbnail_path: THUMB,
    }],
    media_asset_renditions: [],
  };
  return { store, storage, u };
}

interface App { base: string; logs: Array<{ level: string; obj: any; msg?: string }>; close: () => Promise<void> }
async function start(client: any): Promise<App> {
  _setTestClient(client as any, true);
  const logs: App["logs"] = [];
  const ex = express();
  ex.use(express.json());
  ex.use((req: any, _r: any, n: any) => {
    req.log = {
      error: (obj: any, msg?: string) => logs.push({ level: "error", obj, msg }),
      warn: (obj: any, msg?: string) => logs.push({ level: "warn", obj, msg }),
      info: (obj: any, msg?: string) => logs.push({ level: "info", obj, msg }),
    };
    n();
  });
  ex.use("/api", memoriesRouter);
  const srv = http.createServer(ex);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, logs, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
async function call(a: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${a.base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}
const addItem = (a: App, mediaUrl = MEDIA_URL, mediaType = "image/jpeg", memoryId = MEM) =>
  call(a, "POST", `/memories/${memoryId}/items`, OWNER, { mediaUrl, mediaType, caption: null, position: 0 });
const rowsOf = (store: Record<string, any[]>, assetId = ASSET) =>
  (store.media_asset_renditions ?? []).filter((r) => r.asset_id === assetId);

// ═════════════════════════════════════════════════════════════════════════════

describe("R7 — the TS ladder is 3808's SQL", () => {
  it("rung names, size bounds and mimes are pinned equal to the migration and to lib/mediaProcessing", () => {
    const names = /media_asset_renditions_rendition_check\s+CHECK \(rendition IN \(([^)]*)\)\)/.exec(MIGRATION_SQL)?.[1];
    assert.ok(names, "the rendition CHECK is in 3808");
    assert.deepEqual(names!.split(",").map((s) => s.trim().replace(/'/g, "")), [...RENDITION_NAMES]);
    const mimes = /media_asset_renditions_mime_check\s+CHECK \(mime IN \(([^)]*)\)\)/.exec(MIGRATION_SQL)?.[1];
    assert.deepEqual(mimes!.split(",").map((s) => s.trim().replace(/'/g, "")), [...RENDITION_MIMES]);
    const bound = (rung: string) => Number(new RegExp(`WHEN '${rung}'\\s+THEN [^\\n]*greatest\\(width, height\\) <= (\\d+)`).exec(MIGRATION_SQL)?.[1]);
    assert.deepEqual([bound("tiny"), bound("card"), bound("viewer")], [TINY_DIM, THUMBNAIL_DIM, FEED_DIM]);
    assert.deepEqual(LADDER_MAX_EDGE, { tiny: TINY_DIM, card: THUMBNAIL_DIM, viewer: FEED_DIM });
    assert.equal(TINY_DIM, 64);
  });

  it("withinLadder mirrors the CHECK at every edge", () => {
    assert.equal(withinLadder("tiny", "image/jpeg", 64, 43), true);
    assert.equal(withinLadder("tiny", "image/jpeg", 65, 43), false);
    assert.equal(withinLadder("tiny", "image/png", 64, 43), false);
    assert.equal(withinLadder("tiny", "image/jpeg", null, null), false);
    assert.equal(withinLadder("card", "image/jpeg", 400, 267), true);
    assert.equal(withinLadder("card", "image/jpeg", 401, 267), false);
    assert.equal(withinLadder("viewer", "image/jpeg", 1500, 1000), true);
    assert.equal(withinLadder("viewer", "image/jpeg", 1501, 1000), false);
    assert.equal(withinLadder("viewer", "video/mp4", null, null), true);
    assert.equal(withinLadder("original", "image/jpeg", null, null), false);
    assert.equal(withinLadder("original", "video/mp4", null, null), true);
    assert.equal(withinLadder("original", "image/jpeg", 10, null), false, "one dimension without the other");
    assert.equal(withinLadder("original", "application/pdf", 10, 10), false);
  });

  it("the layout names four distinct paths and refuses what it may not build on", () => {
    const l = renditionLayoutFor(BUCKET, ORIGINAL)!;
    assert.deepEqual([l.uploadViewer, l.uploadCard, l.tiny], [FEED, THUMB, TINY]);
    assert.equal(new Set([l.original, l.uploadViewer, l.uploadCard, l.tiny, l.ownedViewer, l.ownedCard]).size, 6);
    assert.equal(l.poster, `${ORIGINAL}.poster.jpg`);
    for (const bad of [`memories/${OWNER}/a.jpg`, `stories/${OWNER}/a.jpg`, `/${OWNER}/a.jpg`, `${OWNER}/../x/a.jpg`, `${OWNER}/noext`, `${OWNER}/trailing.`]) {
      assert.equal(renditionLayoutFor(BUCKET, bad), null, bad);
    }
  });
});

describe("makeTinyVariant — longest edge <= 64, no metadata", () => {
  it("a real JPEG carrying GPS EXIF comes out <= 64 px with no EXIF at all", async () => {
    const src = await gpsJpeg(5000, 2500);
    const meta = await sharp(src).metadata();
    assert.ok((meta.exif?.length ?? 0) > 0 && meta.orientation === 6, "fixture precondition: EXIF and an orientation tag");
    assert.equal(exifFactsFrom(src)!.hasGpsIfd, true, "fixture precondition: a GPS IFD");
    const tiny = await makeTinyVariant(src);
    assert.ok(Math.max(tiny.width, tiny.height) <= 64);
    assert.equal(Math.max(tiny.width, tiny.height), 64, "a large source lands on the bound, not below it");
    assert.ok(tiny.height > tiny.width, "auto-oriented before the strip (orientation 6 swaps the axes)");
    await assertNoMetadata(tiny.buffer, "tiny");
  });

  it("a source smaller than the bound is not upscaled", async () => {
    const small = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const t = await makeTinyVariant(small);
    assert.deepEqual([t.width, t.height], [40, 20]);
  });
});

describe("R1 — ADD_MEDIA of an image registers four distinct renditions", () => {
  it("original, viewer (feed), card (thumb) and a generated tiny: four rows, four distinct paths, four objects", async () => {
    const { store, storage, u } = await seedWorld();
    const a = await start(makeClient(store, storage));
    try {
      const r = await addItem(a);
      assert.equal(r.status, 201, r.text);
      const rows = rowsOf(store);
      assert.equal(rows.length, 4, JSON.stringify(rows));
      const byName = Object.fromEntries(rows.map((x) => [x.rendition, x]));
      assert.deepEqual(Object.keys(byName).sort(), ["card", "original", "tiny", "viewer"]);
      assert.equal(new Set(rows.map((x) => x.storage_path)).size, 4, "four DISTINCT paths");
      assert.deepEqual([byName.original.storage_path, byName.viewer.storage_path, byName.card.storage_path, byName.tiny.storage_path], [ORIGINAL, FEED, THUMB, TINY]);
      for (const x of rows) assert.ok(storage.has(BUCKET, x.storage_path), `${x.rendition}: a registered path names an object that exists`);
      assert.deepEqual([byName.original.width, byName.original.height], [u.width, u.height]);
      assert.ok(Math.max(byName.viewer.width, byName.viewer.height) <= FEED_DIM);
      assert.ok(Math.max(byName.card.width, byName.card.height) <= THUMBNAIL_DIM);
      assert.ok(Math.max(byName.tiny.width, byName.tiny.height) <= TINY_DIM);
      // The tiny OBJECT, as stored, measured from its bytes.
      const tinyBytes = storage.get(BUCKET, TINY)!;
      const tm = await sharp(tinyBytes).metadata();
      assert.ok(Math.max(tm.width!, tm.height!) <= 64, `stored tiny is ${tm.width}x${tm.height}`);
      await assertNoMetadata(tinyBytes, "stored tiny");
      // Only the tiny was generated: the upload's own variants were reused.
      assert.deepEqual(storage.ops.filter((o) => o.op === "upload").map((o) => o.path), [TINY]);
      // The owner's response carries the ladder.
      const ren = r.json.item.renditions;
      assert.deepEqual(ren, { viewer: `${BUCKET}/${FEED}`, card: `${BUCKET}/${THUMB}`, tiny: `${BUCKET}/${TINY}`, viewerDistinct: true, original: `${BUCKET}/${ORIGINAL}` });
      assert.equal(r.json.item.mediaUrl, MEDIA_URL, "the owner's mediaUrl is unchanged");
    } finally { await a.close(); }
  });

  it("the tiny carries no EXIF even when the STORED original still carries GPS", async () => {
    const raw = await gpsJpeg(1200, 800);
    const { store, storage } = await seedWorld({ originalBytes: raw });
    const a = await start(makeClient(store, storage));
    try {
      assert.equal((await addItem(a)).status, 201);
      const tinyBytes = storage.get(BUCKET, TINY);
      assert.ok(tinyBytes, "the tiny was written");
      assert.ok(Math.max(...[(await sharp(tinyBytes!).metadata()).width!, (await sharp(tinyBytes!).metadata()).height!]) <= 64);
      await assertNoMetadata(tinyBytes!, "tiny from a geotagged original");
    } finally { await a.close(); }
  });

  it("a rung the upload did not leave is generated from the stored original under the module's own name", async () => {
    const { store, storage } = await seedWorld({ withFeed: false, withThumb: false });
    const a = await start(makeClient(store, storage));
    try {
      const r = await addItem(a);
      assert.equal(r.status, 201, r.text);
      const by = Object.fromEntries(rowsOf(store).map((x) => [x.rendition, x.storage_path]));
      assert.deepEqual(by, { original: ORIGINAL, viewer: `${STEM}.viewer.jpg`, card: `${STEM}.card.jpg`, tiny: TINY });
      assert.ok(storage.has(BUCKET, `${STEM}.viewer.jpg`) && storage.has(BUCKET, `${STEM}.card.jpg`));
      assert.ok(!storage.has(BUCKET, FEED) && !storage.has(BUCKET, THUMB), "never writes under the upload's names");
      await assertNoMetadata(storage.get(BUCKET, `${STEM}.viewer.jpg`)!, "generated viewer");
    } finally { await a.close(); }
  });

  it("is idempotent: a second ADD_MEDIA of the same object writes nothing new", async () => {
    const { store, storage } = await seedWorld();
    const a = await start(makeClient(store, storage));
    try {
      assert.equal((await addItem(a)).status, 201);
      const uploads = storage.ops.filter((o) => o.op === "upload").length;
      const second = await addItem(a);
      assert.equal(second.status, 201);
      assert.equal(storage.ops.filter((o) => o.op === "upload").length, uploads, "no object generated twice");
      const opsBefore = storage.ops.length;
      const direct = await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
      assert.equal(direct.state, "registered");
      assert.equal(storage.ops.length, opsBefore, "a complete ladder costs no storage call at all");
      assert.equal(rowsOf(store).length, 4);
      assert.equal(second.json.item.renditions.tiny, `${BUCKET}/${TINY}`);
    } finally { await a.close(); }
  });

  it("a registered rung is never rewritten (ON CONFLICT DO NOTHING keeps the first)", async () => {
    const { store, storage } = await seedWorld();
    store.media_asset_renditions.push({ asset_id: ASSET, rendition: "card", storage_path: THUMB, width: 1, height: 1, mime: "image/jpeg" });
    const r = await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
    assert.equal(r.state, "registered");
    const card = rowsOf(store).find((x) => x.rendition === "card");
    assert.deepEqual([card.width, card.height], [1, 1], "the existing row stands");
  });
});

describe("R2 — a NON-OWNER is never served the original when a viewer exists", () => {
  async function registeredWorld() {
    const w = await seedWorld();
    w.store.memory_items.push({ id: "21111111-1111-4111-8111-111111111111", memory_id: MEM, media_url: MEDIA_URL, media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z", visibility: null });
    const r = await registerMemoryItemRenditions(makeClient(w.store, w.storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
    assert.equal(r.state, "registered");
    return w;
  }
  /** The original's path, in any spelling, must not appear in the body. */
  const assertNoOriginal = (text: string, what: string) => {
    assert.equal(text.includes(ORIGINAL), false, `${what}: the original's path appears in a non-owner's response`);
    assert.equal(text.includes('"original"'), false, `${what}: an \`original\` key reached a non-owner`);
  };

  it("GET /memories/:id: the non-owner gets the viewer and no `original`; the owner gets all four", async () => {
    const { store, storage } = await registeredWorld();
    const a = await start(makeClient(store, storage));
    try {
      const other = await call(a, "GET", `/memories/${MEM}`, VIEWER);
      assert.equal(other.status, 200, other.text);
      assertNoOriginal(other.text, "detail");
      const it0 = other.json.memory.items[0];
      assert.equal(it0.mediaUrl, `${BUCKET}/${FEED}`, "the non-owner's single URL is the viewer");
      assert.deepEqual(it0.renditions, { viewer: `${BUCKET}/${FEED}`, card: `${BUCKET}/${THUMB}`, tiny: `${BUCKET}/${TINY}`, viewerDistinct: true });
      const own = await call(a, "GET", `/memories/${MEM}`, OWNER);
      assert.equal(own.status, 200, own.text);
      assert.equal(own.json.memory.items[0].mediaUrl, MEDIA_URL);
      assert.equal(own.json.memory.items[0].renditions.original, `${BUCKET}/${ORIGINAL}`);
    } finally { await a.close(); }
  });

  it("the list cover (GET /users/:userId/memories) and the trip cover (GET /trips/:tripId/memory) withhold it too", async () => {
    const { store, storage } = await registeredWorld();
    const a = await start(makeClient(store, storage));
    try {
      const list = await call(a, "GET", `/users/${OWNER}/memories`, VIEWER);
      assert.equal(list.status, 200, list.text);
      assertNoOriginal(list.text, "list cover");
      assert.equal(list.json.memories[0].cover.mediaUrl, `${BUCKET}/${FEED}`);
      assert.equal(list.json.memories[0].cover.renditions.card, `${BUCKET}/${THUMB}`);
      const trip = await call(a, "GET", `/trips/${TRIP}/memory`, VIEWER);
      assert.equal(trip.status, 200, trip.text);
      assertNoOriginal(trip.text, "trip cover");
      assert.equal(trip.json.memory.cover.mediaUrl, `${BUCKET}/${FEED}`);
      const ownList = await call(a, "GET", `/users/${OWNER}/memories`, OWNER);
      assert.equal(ownList.json.memories[0].cover.mediaUrl, MEDIA_URL, "the owner's cover is unchanged");
      assert.equal(ownList.json.memories[0].cover.renditions.original, `${BUCKET}/${ORIGINAL}`);
    } finally { await a.close(); }
  });

  it("an item with no ladder is served exactly as today (no `renditions` key, original URL)", async () => {
    const w = await seedWorld();
    w.store.memory_items.push({ id: "21111111-1111-4111-8111-111111111111", memory_id: MEM, media_url: MEDIA_URL, media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z", visibility: null });
    const a = await start(makeClient(w.store, w.storage));
    try {
      const other = await call(a, "GET", `/memories/${MEM}`, VIEWER);
      assert.equal(other.status, 200);
      assert.equal(other.json.memory.items[0].mediaUrl, MEDIA_URL);
      assert.equal("renditions" in other.json.memory.items[0], false);
    } finally { await a.close(); }
  });

  it("an unreadable ladder REFUSES a non-owner read and serves the owner today's shape", async () => {
    const { store, storage } = await registeredWorld();
    const a = await start(makeClient(store, storage, { fails: [{ table: "media_asset_renditions", op: "select", error: { code: "57014", message: "statement timeout" } }] }));
    try {
      const other = await call(a, "GET", `/memories/${MEM}`, VIEWER);
      assert.equal(other.status, 503, other.text);
      assert.equal(other.text.includes(ORIGINAL), false);
      const list = await call(a, "GET", `/users/${OWNER}/memories`, VIEWER);
      assert.equal(list.status, 503, list.text);
      const trip = await call(a, "GET", `/trips/${TRIP}/memory`, VIEWER);
      assert.equal(trip.status, 503, trip.text);
      const own = await call(a, "GET", `/memories/${MEM}`, OWNER);
      assert.equal(own.status, 200, own.text);
      assert.equal(own.json.memory.items[0].mediaUrl, MEDIA_URL);
      assert.equal("renditions" in own.json.memory.items[0], false);
    } finally { await a.close(); }
  });

  it("a ladder is attached only to an object its Memory's owner owns, and only through a confirmed asset", async () => {
    const { store, storage } = await registeredWorld();
    // The asset row now names someone else: the original row no longer counts.
    store.media_assets[0].owner_user_id = VIEWER;
    const look = await readRenditionsForItems(makeClient(store, storage), [{ mediaUrl: MEDIA_URL, ownerId: OWNER }]);
    assert.equal(look.state, "ok");
    assert.equal((look as any).byObject.size, 0);
    // A deleted asset's ladder is not served (its bytes are being purged, 2952).
    store.media_assets[0].owner_user_id = OWNER; store.media_assets[0].deleted_at = "2026-10-01T00:00:00Z";
    const deleted = await readRenditionsForItems(makeClient(store, storage), [{ mediaUrl: MEDIA_URL, ownerId: OWNER }]);
    assert.equal((deleted as any).byObject.size, 0);
    store.media_assets[0].deleted_at = null;
    // A Memory owned by someone whose id the path does not name gets nothing either.
    store.media_assets[0].owner_user_id = OWNER;
    const foreign = await readRenditionsForItems(makeClient(store, storage), [{ mediaUrl: MEDIA_URL, ownerId: VIEWER }]);
    assert.equal((foreign as any).byObject.size, 0);
  });
});

describe("R3 — fail-soft: a rendition failure never fails the write and never registers a broken path", () => {
  it("the tiny upload fails: 201, the item is written, three rungs registered, no tiny row", async () => {
    const { store, storage } = await seedWorld();
    storage.fails.push({ op: "upload", path: TINY });
    const a = await start(makeClient(store, storage));
    try {
      const r = await addItem(a);
      assert.equal(r.status, 201, r.text);
      assert.equal(store.memory_items.length, 1, "the Memory item was written");
      assert.deepEqual(rowsOf(store).map((x) => x.rendition).sort(), ["card", "original", "viewer"]);
      assert.equal(r.json.item.renditions.tiny, null);
      assert.ok(a.logs.some((l) => l.level === "warn" && /in part/.test(String(l.msg))), "the partial registration is logged");
    } finally { await a.close(); }
  });

  it("the original cannot be read: 201, the item is written, NOTHING registered, nothing generated", async () => {
    const { store, storage } = await seedWorld();
    storage.fails.push({ op: "download", path: ORIGINAL });
    const a = await start(makeClient(store, storage));
    try {
      const r = await addItem(a);
      assert.equal(r.status, 201, r.text);
      assert.equal(store.memory_items.length, 1);
      assert.equal(rowsOf(store).length, 0);
      assert.equal(storage.ops.filter((o) => o.op === "upload").length, 0);
      assert.equal("renditions" in r.json.item, false);
    } finally { await a.close(); }
  });

  it("an upload variant that does not decode is not registered under its name", async () => {
    const { store, storage } = await seedWorld();
    storage.put(BUCKET, FEED, Buffer.from("not an image at all, just bytes"));
    const r = await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
    assert.equal(r.state, "registered");
    const viewer = rowsOf(store).find((x) => x.rendition === "viewer");
    assert.equal(viewer?.storage_path, `${STEM}.viewer.jpg`, "a broken sibling is replaced by a generated one, never registered");
  });

  it("an upload variant the store cannot READ is reported missing — nothing is generated beside an object that may be fine", async () => {
    const { store, storage } = await seedWorld();
    storage.fails.push({ op: "download", path: FEED });
    const r = await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
    assert.equal(r.state, "registered");
    assert.deepEqual(rowsOf(store).map((x) => x.rendition).sort(), ["card", "original", "tiny"]);
    assert.deepEqual((r as any).missing.map((m: any) => m.rendition), ["viewer"]);
    assert.equal(storage.has(BUCKET, `${STEM}.viewer.jpg`), false, "no second viewer object");
  });

  it("an upload variant OUTSIDE its rung (a 2000 px 'feed') is never registered as the viewer", async () => {
    const { store, storage } = await seedWorld();
    storage.put(BUCKET, FEED, await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#222" } }).jpeg().toBuffer());
    await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
    const viewer = rowsOf(store).find((x) => x.rendition === "viewer");
    assert.equal(viewer?.storage_path, `${STEM}.viewer.jpg`);
    assert.ok(Math.max(viewer.width, viewer.height) <= FEED_DIM);
  });

  it("the registration write fails: 201, and the objects it generated are removed (no orphan)", async () => {
    const { store, storage } = await seedWorld();
    const a = await start(makeClient(store, storage, { fails: [{ table: "media_asset_renditions", op: "upsert", error: { code: "57014", message: "timeout" } }] }));
    try {
      const r = await addItem(a);
      assert.equal(r.status, 201, r.text);
      assert.equal(store.memory_items.length, 1);
      assert.equal(rowsOf(store).length, 0);
      assert.equal(storage.has(BUCKET, TINY), false, "the generated tiny was removed when nothing records it");
      assert.ok(storage.has(BUCKET, ORIGINAL) && storage.has(BUCKET, FEED) && storage.has(BUCKET, THUMB), "the upload's objects are untouched");
    } finally { await a.close(); }
  });

  it("a registration that throws is a `failed` result, never a rejection", async () => {
    const { store } = await seedWorld();
    const broken = { ...makeClient(store, new FakeStorage()), storage: { from() { throw new Error("storage exploded"); } } };
    const r = await registerMemoryItemRenditions(broken, { ownerId: OWNER, mediaUrl: MEDIA_URL });
    assert.equal(r.state, "failed");
  });

  it("the route never waits past its budget: a stalled store answers `pending`", async () => {
    const { store, storage } = await seedWorld();
    const stalled = { ...makeClient(store, storage), storage: { from: () => ({ ...storage.from(BUCKET), list: () => new Promise(() => {}) }) } };
    const t0 = Date.now();
    const r = await registerWithinBudget(stalled, { ownerId: OWNER, mediaUrl: MEDIA_URL }, 50);
    assert.equal(r.state, "pending");
    assert.ok(Date.now() - t0 < 2000);
  });

  it("only the owner's own server-written objects are ever registered", async () => {
    const { store, storage } = await seedWorld();
    const c = makeClient(store, storage);
    assert.deepEqual(await registerMemoryItemRenditions(c, { ownerId: OWNER, mediaUrl: "https://example.com/x.jpg" }), { state: "skipped", reason: "external" });
    assert.deepEqual(await registerMemoryItemRenditions(c, { ownerId: VIEWER, mediaUrl: MEDIA_URL }), { state: "skipped", reason: "not_owner_storage" });
    assert.deepEqual(await registerMemoryItemRenditions(c, { ownerId: OWNER, mediaUrl: abs(`memories/${OWNER}/raw.jpg`) }), { state: "skipped", reason: "unrecognised_path" }, "a client-writable prefix is never built on");
    store.media_assets[0].owner_user_id = VIEWER;
    assert.deepEqual(await registerMemoryItemRenditions(c, { ownerId: OWNER, mediaUrl: MEDIA_URL }), { state: "skipped", reason: "not_owner_asset" });
    store.media_assets[0].owner_user_id = OWNER; store.media_assets[0].deleted_at = "2026-10-01T00:00:00Z";
    assert.deepEqual(await registerMemoryItemRenditions(c, { ownerId: OWNER, mediaUrl: MEDIA_URL }), { state: "skipped", reason: "asset_deleted" });
    store.media_assets.length = 0;
    assert.deepEqual(await registerMemoryItemRenditions(c, { ownerId: OWNER, mediaUrl: MEDIA_URL }), { state: "skipped", reason: "no_canonical_asset" });
    assert.equal(storage.ops.filter((o) => o.op === "upload").length, 0, "nothing generated for any of them");
    assert.equal(rowsOf(store).length, 0);
  });
});

describe("R5 — 3808 not applied: nothing new is reachable", () => {
  it("ADD_MEDIA: 201 as today, one probe, no media_assets read, no storage call at all", async () => {
    const { store, storage } = await seedWorld();
    const client = makeClient(store, storage, { absent: new Set(["media_asset_renditions"]) });
    const a = await start(client);
    try {
      const r = await addItem(a);
      assert.equal(r.status, 201, r.text);
      assert.equal("renditions" in r.json.item, false);
      assert.deepEqual(storage.ops, [], "no list, download, upload or remove");
      assert.equal(client.reads.filter((x) => x.startsWith("media_assets.")).length, 0);
      assert.equal(client.reads.filter((x) => x.startsWith("media_asset_renditions.")).length, 1, "exactly one probe");
      assert.deepEqual(await registerMemoryItemRenditions(client, { ownerId: OWNER, mediaUrl: MEDIA_URL }), { state: "skipped", reason: "not_deployed" });
      const other = await call(a, "GET", `/memories/${MEM}`, VIEWER);
      assert.equal(other.status, 200);
      assert.equal(other.json.memory.items[0].mediaUrl, MEDIA_URL);
      assert.equal("renditions" in other.json.memory.items[0], false);
    } finally { await a.close(); }
  });

  it("§21 reports the absent table instead of a purge, and the DELETE still completes", async () => {
    const { store, storage } = await seedWorld();
    store.memory_items.push({ id: "i1", memory_id: MEM, media_url: MEDIA_URL, media_type: "image/jpeg", position: 0 });
    store.memories[0].state = "deleted";
    const report = await runMemoryDeletionLifecycle(makeClient(store, storage, { absent: new Set(["media_asset_renditions"]) }), {
      memoryId: MEM, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "public", state: "published" } as any,
    });
    const step = report.steps.find((s) => s.step === "DERIVATIVES_PURGED")!;
    assert.notEqual(step.outcome, "failed", JSON.stringify(step));
    assert.equal((step.facts as any).renditions, "not_deployed");
  });
});

describe("R4 — deletion removes rendition rows and the objects the Memory service wrote", () => {
  async function registered() {
    const w = await seedWorld();
    w.store.memory_items.push({ id: "21111111-1111-4111-8111-111111111111", memory_id: MEM, media_url: MEDIA_URL, media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z", visibility: null });
    assert.equal((await registerMemoryItemRenditions(makeClient(w.store, w.storage), { ownerId: OWNER, mediaUrl: MEDIA_URL })).state, "registered");
    assert.equal(rowsOf(w.store).length, 4);
    return w;
  }

  it("DELETE /memories/:id: §21 DERIVATIVES_PURGED deletes the rows and the tiny, and leaves the upload's objects", async () => {
    const { store, storage } = await registered();
    const a = await start(makeClient(store, storage));
    try {
      const r = await call(a, "DELETE", `/memories/${MEM}`, OWNER);
      assert.equal(r.status, 204, r.text);
      assert.equal(rowsOf(store).length, 0, "every rendition row is gone");
      assert.equal(storage.has(BUCKET, TINY), false, "the tiny object is gone");
      assert.ok(storage.has(BUCKET, ORIGINAL) && storage.has(BUCKET, FEED) && storage.has(BUCKET, THUMB), "the upload's objects are the asset's, not this purge's");
      const report = a.logs.find((l) => l.obj?.report)?.obj.report;
      const step = report.steps.find((s: any) => s.step === "DERIVATIVES_PURGED");
      assert.equal(step.outcome, "done", JSON.stringify(step));
      assert.deepEqual(step.facts.renditions, { purgedAssets: 1, rowsDeleted: 4, objectsRemoved: 1, keptInUse: 0 });
    } finally { await a.close(); }
  });

  it("§21 says `done`, not `not_applicable`, when the registry (2730) is absent but a ladder WAS purged", async () => {
    const { store, storage } = await registered();
    store.memories[0].state = "deleted";
    const report = await runMemoryDeletionLifecycle(makeClient(store, storage, { absent: new Set(["memory_derivative_registry"]) }), {
      memoryId: MEM, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "public", state: "published" } as any,
    });
    const step = report.steps.find((s) => s.step === "DERIVATIVES_PURGED")!;
    assert.equal(step.outcome, "done", JSON.stringify(step));
    assert.equal((step.facts as any).renditions.rowsDeleted, 4);
  });

  it("generated viewer and card go too; the upload's never do", async () => {
    const w = await seedWorld({ withFeed: false, withThumb: false });
    w.store.memory_items.push({ id: "i1", memory_id: MEM, media_url: MEDIA_URL, media_type: "image/jpeg", position: 0 });
    await registerMemoryItemRenditions(makeClient(w.store, w.storage), { ownerId: OWNER, mediaUrl: MEDIA_URL });
    w.store.memories[0].state = "deleted";
    const out = await purgeRenditionsForMediaUrls(makeClient(w.store, w.storage), { ownerId: OWNER, mediaUrls: [MEDIA_URL] });
    assert.deepEqual(out, { state: "done", purgedAssets: 1, rowsDeleted: 4, objectsRemoved: 3, keptInUse: 0 });
    assert.ok(!w.storage.has(BUCKET, `${STEM}.viewer.jpg`) && !w.storage.has(BUCKET, `${STEM}.card.jpg`) && !w.storage.has(BUCKET, TINY));
    assert.ok(w.storage.has(BUCKET, ORIGINAL));
  });

  it("a ladder still shown by another LIVE Memory item is kept", async () => {
    const { store, storage } = await registered();
    store.memories.push(memoryRow(MEM2));
    store.memory_items.push({ id: "i2", memory_id: MEM2, media_url: `${BUCKET}/${ORIGINAL}`, media_type: "image/jpeg", position: 0 });
    store.memories[0].state = "deleted";
    const out = await purgeRenditionsForMediaUrls(makeClient(store, storage), { ownerId: OWNER, mediaUrls: [MEDIA_URL] });
    assert.equal(out.state, "done");
    assert.equal((out as any).keptInUse, 1);
    assert.equal(rowsOf(store).length, 4);
    assert.ok(storage.has(BUCKET, TINY));
  });

  it("a storage failure leaves the rows, so a retry finds the same paths; §21 reports it retryable", async () => {
    const { store, storage } = await registered();
    store.memories[0].state = "deleted";
    storage.fails.push({ op: "remove", path: TINY });
    const report = await runMemoryDeletionLifecycle(makeClient(store, storage), {
      memoryId: MEM, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "public", state: "published" } as any,
    });
    const step = report.steps.find((s) => s.step === "DERIVATIVES_PURGED")!;
    assert.equal(step.outcome, "failed");
    assert.equal(step.retryable, true);
    assert.match(step.detail, /renditions unpurged/);
    assert.equal(rowsOf(store).length, 4, "rows kept for the retry");
    storage.fails.length = 0;
    const again = await purgeRenditionsForMediaUrls(makeClient(store, storage), { ownerId: OWNER, mediaUrls: [MEDIA_URL] });
    assert.equal(again.state, "done");
    assert.equal(rowsOf(store).length, 0);
    assert.equal(storage.has(BUCKET, TINY), false);
  });

  it("DELETE /memories/:id/items/:itemId (REMOVE_MEDIA) purges the item's ladder", async () => {
    const { store, storage } = await registered();
    const a = await start(makeClient(store, storage));
    try {
      const r = await call(a, "DELETE", `/memories/${MEM}/items/21111111-1111-4111-8111-111111111111`, OWNER);
      assert.equal(r.status, 204, r.text);
      assert.equal(store.memory_items.length, 0);
      assert.equal(rowsOf(store).length, 0);
      assert.equal(storage.has(BUCKET, TINY), false);
      assert.ok(storage.has(BUCKET, ORIGINAL) && storage.has(BUCKET, FEED));
    } finally { await a.close(); }
  });

  it("account deletion collects every NON-original rung, owner-guarded per path; 3808 absent collects nothing", async () => {
    const { store, storage } = await registered();
    store.media_asset_renditions.push({ asset_id: ASSET, rendition: "viewer-of-someone-else" as any, storage_path: `${VIEWER}/x.feed.jpg`, width: 1, height: 1, mime: "image/jpeg" });
    const readAll = async (build: () => any, consume: (rows: any[]) => number) => {
      const { data, error } = await build();
      if (error) throw new Error(error.message);
      return consume(data ?? []);
    };
    const targets: Array<{ bucket: string; path: string }> = [];
    const n = await collectAccountRenditionPaths(makeClient(store, storage), OWNER, readAll, targets);
    assert.equal(n, 3);
    assert.deepEqual(targets.map((t) => t.path).sort(), [FEED, THUMB, TINY].sort(), "the original is collect_media_asset_paths'; a foreign path is refused");
    const none: typeof targets = [];
    assert.equal(await collectAccountRenditionPaths(makeClient(store, storage, { absent: new Set(["media_asset_renditions"]) }), OWNER, readAll, none), 0);
    await assert.rejects(
      collectAccountRenditionPaths(makeClient(store, storage, { fails: [{ table: "media_asset_renditions", op: "select", error: { code: "57014", message: "timeout" } }] }), OWNER, readAll, []),
      /media_asset_renditions/,
      "an unreadable table is a failed step (the outcome warns), never a silent zero",
    );
  });
});

describe("R6 — video: the viewer IS the original (no transcoder), card and tiny from the poster", () => {
  async function videoWorld(withPoster: boolean) {
    const w = await seedWorld();
    w.storage.put(BUCKET, VIDEO, Buffer.from("....ftypmp42 fake video bytes"), "video/mp4");
    if (withPoster) w.storage.put(BUCKET, POSTER, (await uploadSet()).feed);
    w.store.media_assets.push({ id: VASSET, owner_user_id: OWNER, uploader_user_id: OWNER, storage_bucket: BUCKET, storage_path: VIDEO, media_type: "video", mime_type: "video/mp4", width: 1920, height: 1080, deleted_at: null });
    w.store.memory_items.push({ id: "21111111-1111-4111-8111-111111111119", memory_id: MEM, media_url: abs(VIDEO), media_type: "video/mp4", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z", visibility: null });
    return w;
  }

  it("registers original = viewer (the same path), and a card and tiny cut from the poster", async () => {
    const { store, storage } = await videoWorld(true);
    const r = await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: abs(VIDEO) });
    assert.equal(r.state, "registered", JSON.stringify(r));
    const by = Object.fromEntries(rowsOf(store, VASSET).map((x) => [x.rendition, x]));
    assert.equal(by.viewer.storage_path, VIDEO);
    assert.equal(by.original.storage_path, VIDEO);
    assert.deepEqual([by.card.storage_path, by.tiny.storage_path], [`${VSTEM}.card.jpg`, `${VSTEM}.tiny.jpg`]);
    assert.ok(Math.max(by.tiny.width, by.tiny.height) <= 64 && Math.max(by.card.width, by.card.height) <= 400);
    // The non-owner keeps the original URL (there is no distinct viewer to give
    // them) and is TOLD so; no `original` key.
    const look = await readRenditionsForItems(makeClient(store, storage), [{ mediaUrl: abs(VIDEO), ownerId: OWNER }]);
    const a = await start(makeClient(store, storage));
    try {
      const other = await call(a, "GET", `/memories/${MEM}`, VIEWER);
      const v = other.json.memory.items[0];
      assert.equal(v.mediaUrl, abs(VIDEO));
      assert.equal(v.renditions.viewerDistinct, false);
      assert.equal("original" in v.renditions, false);
    } finally { await a.close(); }
    assert.equal(look.state, "ok");
  });

  it("without a poster the card and tiny are reported missing, never invented", async () => {
    const { store, storage } = await videoWorld(false);
    const r = await registerMemoryItemRenditions(makeClient(store, storage), { ownerId: OWNER, mediaUrl: abs(VIDEO) });
    assert.equal(r.state, "registered");
    assert.deepEqual(rowsOf(store, VASSET).map((x) => x.rendition).sort(), ["original", "viewer"]);
    assert.deepEqual((r as any).missing.map((m: any) => m.rendition).sort(), ["card", "tiny"]);
  });
});

describe("3808's access boundary and deletion fate are registered where the guards read them", () => {
  it("rule 7, the authorization contract, the deletion manifest and the storage hook all name the table", () => {
    const entry = SERVER_ONLY_TABLES.find((t) => t.table === "media_asset_renditions");
    assert.equal(entry?.closedBy, "3808_media_asset_renditions.sql");
    const c = (loadContract() as any).tables["media_asset_renditions"];
    assert.deepEqual([c.tableGrants, c.insertCols, c.updateCols, c.policies], [{}, {}, {}, []]);
    assert.ok(ERASED_BY_CASCADE.includes("media_asset_renditions") && POST_BASELINE_TABLES.includes("media_asset_renditions"));
    const hook = listStorageCleanupHooks().find((h) => h.tables.includes("media_asset_renditions"));
    assert.equal(hook?.implementedBy, "collect_media_rendition_paths");
    const svc = readFileSync(resolve(__dir, "../services/accountDeletion/AccountDeletionService.ts"), "utf8");
    assert.ok(svc.indexOf('"collect_media_rendition_paths"') > 0 && svc.indexOf('"collect_media_rendition_paths"') < svc.indexOf('"delete_media_assets"'),
      "the objects are collected BEFORE delete_media_assets cascades the rows that name them");
  });

  it("check:client-privilege-boundary rule 7 FAILS a client grant of media_asset_renditions", () => {
    const API_ROOT = resolve(__dir, "..", "..");
    const tmp = mkdtempSync(join(tmpdir(), "rendacl-"));
    try {
      const dir = join(tmp, "case");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "0001_padding.sql"), Array.from({ length: 60 }, (_, i) => `GRANT SELECT ON TABLE public.pad_${i} TO authenticated;`).join("\n"));
      writeFileSync(join(dir, "9999_case.sql"), "GRANT SELECT ON TABLE public.media_asset_renditions TO authenticated;");
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", join(API_ROOT, "src", "scripts", "checkClientPrivilegeBoundary.ts")], {
        cwd: API_ROOT, encoding: "utf8", env: { ...process.env, CLIENT_PRIVILEGE_DIRS: dir }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      assert.notEqual(r.status, 0, out);
      assert.match(out, /server-only table public\.media_asset_renditions is client-reachable/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
