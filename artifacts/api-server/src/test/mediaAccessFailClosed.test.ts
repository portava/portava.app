/**
 * mediaAccessFailClosed — the media guard measured on the FAILURE paths, and
 * the reachability of the guard itself.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM mediaAccess.test.ts ─────────────────
 * That suite is not vacuous — hand-reverting the §3a moderation check takes it
 * from 43 pass to 42 pass / 1 fail, and hand-reverting the §3d story-owner check
 * takes storyMediaOwnership from 15 pass to 12 pass / 3 fail. But every fake
 * client in it answers `error: null` on every read, so none of its 43 tests can
 * distinguish "no row" from "the table could not be read". supabase-js RESOLVES
 * on a database error: `{ data: null, error }` has the same `data` an empty
 * table returns. That is the whole class of defect this file measures, with a
 * fake that can fail a NAMED table and that COUNTS the reads it served.
 *
 * ── WHAT WAS MEASURED, AND WHAT IT FOUND ────────────────────────────────────
 * `lib/mediaAccess.ts` branch §3a is the only carrier of `moderation_status` on
 * the post-media path. Branch §3b, which runs next, resolves the same object
 * through `posts.media_urls` — a `text[]` with no moderation column at all. So
 * §3a is the one branch in the file where falling through is not the safe
 * outcome, and it was the one branch that fell through. Three runs of the probe
 * in this file, against the code as it stood:
 *
 *   healthy read, post_media.moderation_status='rejected'   → denied   correct
 *   same rows, post_media resolves { error: 57P01 }         → ALLOWED  leak
 *   two post_media rows on one storage_path (PGRST116)      → ALLOWED  leak
 *
 * The third needs no injected failure to reach. 2027_media_private_buckets_prep
 * .sql:31 creates `post_media_storage_path_idx` as a PLAIN index and no
 * migration puts a UNIQUE constraint on `post_media` — only `media_assets`
 * carries `UNIQUE (storage_bucket, storage_path)` (0191:39). One object attached
 * to two posts is ordinary data, `.maybeSingle()` answers it with a resolved
 * PGRST116, and that read as "no such row" exactly like a healthy miss.
 *
 * The module's own log line said "access falls through to deny". It fell
 * through to §3b, which allowed.
 *
 * Run: node --import tsx/esm --test src/test/mediaAccessFailClosed.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { authorizeMediaAccess, _clearMediaAccessCache } from "../lib/mediaAccess.js";
import mediaFileRouter from "../routes/mediaFile.js";

const SB = "http://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;

const OWNER  = "a1000000-0000-4000-a000-000000000001";
const VIEWER = "a1000000-0000-4000-a000-000000000002";
const TRIP   = "b1000000-0000-4000-a000-000000000001";
const TOKEN  = "media-fail-closed-token";

const OBJ  = `${OWNER}/p1.jpg`;
const BARE = `post-media/${OBJ}`;

/** The resolved shape supabase-js returns for a failed read. Never thrown. */
interface DbError { code: string; message: string }

interface FailFakeSpec {
  postMedia?: any[];
  posts?: any[];
  blocks?: any[];
  tripMembers?: any[];
  trips?: any[];
  mediaAssets?: any[];
  /** table -> the resolved error that read answers with. */
  failTables?: Record<string, DbError>;
}

/**
 * A PostgREST double that can FAIL a named table the way the real client fails
 * — resolved, never thrown — and that COUNTS terminal reads, so a claim about
 * how much work a request does is measured rather than asserted.
 *
 * `.maybeSingle()` raises the real resolved PGRST116 on more than one match.
 * `.overlaps()` is modelled because §3b needs it; `src/test/helpers/
 * failClosedSupabase.ts` does not model it and this file does not reach into
 * that helper to add it.
 */
function makeFailFake(spec: FailFakeSpec = {}) {
  const fail = spec.failTables ?? {};
  const counters = { reads: 0, signs: 0 };
  const signedPaths: Array<{ bucket: string; path: string; options: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN = Infinity;
    const src = () =>
      table === "post_media"   ? spec.postMedia   ?? [] :
      table === "posts"        ? spec.posts       ?? [] :
      table === "blocks"       ? spec.blocks      ?? [] :
      table === "trip_members" ? spec.tripMembers ?? [] :
      table === "trips"        ? spec.trips       ?? [] :
      table === "media_assets" ? spec.mediaAssets ?? [] : [];
    const rows = () => src().filter((r: any) => filters.every((f) => f(r))).slice(0, limitN);
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return b; },
      is: (c: string, v: any) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not: () => b,
      order: () => b,
      or: () => b,
      overlaps: (c: string, v: any[]) => {
        filters.push((r) => Array.isArray(r[c]) && v.some((x) => r[c].includes(x)));
        return b;
      },
      limit: (n: number) => { limitN = n; return b; },
      maybeSingle() {
        counters.reads++;
        if (fail[table]) return Promise.resolve({ data: null, error: fail[table] });
        const l = rows();
        if (l.length > 1) {
          return Promise.resolve({
            data: null,
            error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
          });
        }
        return Promise.resolve({ data: l[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        counters.reads++;
        const res = fail[table] ? { data: null, error: fail[table] } : { data: rows(), error: null };
        return Promise.resolve(res).then(onF, onR);
      },
    };
    return b;
  }

  const client: any = {
    from,
    counters,
    signedPaths,
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (p: string, ttl: number, options?: any) => {
            counters.signs++;
            signedPaths.push({ bucket, path: p, options });
            const kind = options?.transform ? "render/image/sign" : "object/sign";
            return { data: { signedUrl: `${SB}/storage/v1/${kind}/${bucket}/${p}?token=signed&ttl=${ttl}` }, error: null };
          },
        };
      },
    },
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "bad" } },
    },
  };
  return client;
}

const publicPost = {
  id: "post9", author_id: OWNER, visibility: "public", status: "active",
  post_status: "published", trip_id: null, media_urls: [BARE],
};

before(() => { process.env.SUPABASE_URL = SB; });
after(() => { process.env.SUPABASE_URL = OLD_SUPABASE_URL; });
beforeEach(() => _clearMediaAccessCache());

// ─────────────────────────────────────────────────────────────────────────────
describe("mediaAccess §3a — the moderation carrier fails CLOSED", () => {
  const rejectedRow = { storage_path: OBJ, post_id: "post9", moderation_status: "rejected", processing_status: "ready" };
  const approvedRow = { storage_path: OBJ, post_id: "post9", moderation_status: "approved", processing_status: "ready" };

  it("CONTROL — a healthy read of a rejected attachment denies", async () => {
    const sc = makeFailFake({ postMedia: [rejectedRow], posts: [publicPost] });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
    assert.ok(sc.counters.reads > 0, "the fake must actually have served reads");
  });

  it("CONTROL — a healthy read of an approved attachment on a public post allows", async () => {
    const sc = makeFailFake({ postMedia: [approvedRow], posts: [publicPost] });
    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), true,
      "the fix must not turn into a blanket deny — the ordinary allow still has to work",
    );
  });

  it("an UNREADABLE post_media table denies, and does NOT fall through to §3b", async () => {
    // Same rows as the control that denies. The only difference is that the
    // read carrying moderation_status now resolves an error. Before the fix
    // this returned TRUE: §3b found the post via media_urls and allowed it,
    // so a database blip re-published media a moderator had removed.
    const sc = makeFailFake({
      postMedia: [rejectedRow],
      posts: [publicPost],
      failTables: { post_media: { code: "57P01", message: "connection terminated unexpectedly" } },
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("a PGRST204/42703 rejection of the same read also denies", async () => {
    // A renamed or not-yet-migrated column is the other way this read fails,
    // and it is not transient — it stays broken until someone deploys.
    const sc = makeFailFake({
      postMedia: [rejectedRow],
      posts: [publicPost],
      failTables: { post_media: { code: "42703", message: 'column "moderation_status" does not exist' } },
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("TWO attachments on one storage_path, one rejected → denied (no UNIQUE index exists)", async () => {
    // Reachable with ordinary data: post_media has no UNIQUE constraint on
    // storage_path in any migration. Under `.maybeSingle()` this resolved
    // PGRST116, read as "no row", and §3b allowed the object.
    const sc = makeFailFake({
      postMedia: [rejectedRow, { ...approvedRow, post_id: "post8" }],
      posts: [publicPost, { ...publicPost, id: "post8" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("TWO clean attachments on one storage_path still authorize (not a blanket deny)", async () => {
    const sc = makeFailFake({
      postMedia: [approvedRow, { ...approvedRow, post_id: "post8" }],
      posts: [publicPost, { ...publicPost, id: "post8" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), true);
  });

  it("a page of attachments at the cap denies rather than scanning a truncated list", async () => {
    // 50 clean rows: the deny-if-any scan cannot prove the 51st is clean, so the
    // answer is deny. The count is deliberately >= the module's cap.
    const many = Array.from({ length: 60 }, (_, i) => ({ ...approvedRow, post_id: `post${i}` }));
    const sc = makeFailFake({ postMedia: many, posts: [publicPost] });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("an unreadable PARENT POST denies (unchanged, and still not a fall-through)", async () => {
    const sc = makeFailFake({
      postMedia: [approvedRow],
      posts: [publicPost],
      failTables: { posts: { code: "57P01", message: "connection terminated unexpectedly" } },
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("an unreadable BLOCKS table denies before any branch runs", async () => {
    const sc = makeFailFake({
      postMedia: [approvedRow],
      posts: [publicPost],
      failTables: { blocks: { code: "57P01", message: "connection terminated unexpectedly" } },
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("trip_only: a non-member is denied even when a second attachment exists", async () => {
    const tripPost = { ...publicPost, visibility: "trip_only", trip_id: TRIP };
    const sc = makeFailFake({
      postMedia: [approvedRow],
      posts: [tripPost],
      trips: [{ id: TRIP, owner_id: OWNER }],
      tripMembers: [],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), false);
  });

  it("trip_only: a member is allowed", async () => {
    const tripPost = { ...publicPost, visibility: "trip_only", trip_id: TRIP };
    const sc = makeFailFake({
      postMedia: [approvedRow],
      posts: [tripPost],
      trips: [{ id: TRIP, owner_id: OWNER }],
      tripMembers: [{ trip_id: TRIP, user_id: VIEWER, role: "member" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", OBJ), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the guard is upstream of every signing on the relay", () => {
  let server: http.Server;
  let base: string;

  // `_setTestClient` takes (client, ready): without the second argument
  // `requireUser` reads `_testReady === undefined` as NOT ready and answers 503,
  // which would look like a fail-closed 4xx to a test that only asserted
  // `status !== 200`.
  function setClients(sc: any) { _setTestClient(sc, true); _setTestServiceClient(sc); }

  function req(method: string, p: string, body?: any): Promise<{ status: number; body: any; location?: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(p, base);
      const payload = body ? JSON.stringify(body) : null;
      const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
      const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers }, (res) => {
        let raw = ""; res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, location: res.headers.location as string | undefined });
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  before(() => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      // Without this shim the route CRASHES and a 500-from-crash would read as
      // fail-closed. The server installs the same one.
      r.log = { error() {}, info() {}, warn() {}, debug() {}, child() { return r.log; } };
      next();
    });
    app.use("/api", mediaFileRouter);
    return new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("GET: a denied object is 403 with the forbidden code AND zero signings", async () => {
    const sc = makeFailFake({ postMedia: [{ storage_path: OBJ, post_id: "post9", moderation_status: "rejected", processing_status: "ready" }], posts: [publicPost] });
    setClients(sc);
    const r = await req("GET", `/api/media/file/post-media/${OBJ}`);
    // The CODE, not merely "!== 200": a 400 here would mean the request died at
    // validation and never reached the gate at all.
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "forbidden");
    assert.equal(sc.counters.signs, 0, "a denied object must never be signed");
  });

  it("GET: an object denied only because the moderation read FAILED is also unsigned", async () => {
    const sc = makeFailFake({
      postMedia: [{ storage_path: OBJ, post_id: "post9", moderation_status: "approved", processing_status: "ready" }],
      posts: [publicPost],
      failTables: { post_media: { code: "57P01", message: "connection terminated unexpectedly" } },
    });
    setClients(sc);
    const r = await req("GET", `/api/media/file/post-media/${OBJ}`);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(sc.counters.signs, 0);
  });

  it("GET: the allow path DOES sign, so the two outcomes are distinguishable", async () => {
    const sc = makeFailFake({
      postMedia: [{ storage_path: OBJ, post_id: "post9", moderation_status: "approved", processing_status: "ready" }],
      posts: [publicPost],
    });
    setClients(sc);
    const r = await req("GET", `/api/media/file/post-media/${OBJ}`);
    assert.equal(r.status, 302);
    assert.equal(sc.counters.signs, 1);
  });

  it("POST /media/sign: every denied url is null and NOTHING is signed", async () => {
    const sc = makeFailFake({
      postMedia: [{ storage_path: OBJ, post_id: "post9", moderation_status: "rejected", processing_status: "ready" }],
      posts: [publicPost],
    });
    setClients(sc);
    const r = await req("POST", "/api/media/sign", { urls: [BARE, `${SB}/storage/v1/object/public/post-media/${OBJ}`] });
    assert.equal(r.status, 200);
    assert.equal(r.body.signed[BARE], null);
    assert.equal(sc.counters.signs, 0, "no url in the batch was authorized, so none may be signed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("transform parameters are bounded, and the two handlers agree", () => {
  let server: http.Server;
  let base: string;

  // `_setTestClient` takes (client, ready): without the second argument
  // `requireUser` reads `_testReady === undefined` as NOT ready and answers 503,
  // which would look like a fail-closed 4xx to a test that only asserted
  // `status !== 200`.
  function setClients(sc: any) { _setTestClient(sc, true); _setTestServiceClient(sc); }
  function req(method: string, p: string, body?: any): Promise<{ status: number; body: any; location?: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(p, base);
      const payload = body ? JSON.stringify(body) : null;
      const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
      const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers }, (res) => {
        let raw = ""; res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, location: res.headers.location as string | undefined });
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  before(() => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {}, child() { return r.log; } }; next(); });
    app.use("/api", mediaFileRouter);
    return new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
    });
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  /** A client for which the object is legitimately authorized. */
  const allowSpec = (): FailFakeSpec => ({
    postMedia: [{ storage_path: OBJ, post_id: "post9", moderation_status: "approved", processing_status: "ready" }],
    posts: [publicPost],
  });

  it("POST /media/sign: { width: 0.1 } must NOT forward width:0 to the signer", async () => {
    // MEASURED before the fix: 0.1 cleared `<= 0`, cleared `> 0`, and then
    // Math.round(Math.min(0.1, 3000)) produced 0 — so a /render/image/sign/ URL
    // was minted asking Storage for a zero-pixel image. Every value under 0.5
    // did this. The quality arm two lines below already rounded first; the
    // width arm did not.
    const sc = makeFailFake(allowSpec());
    setClients(sc);
    const r = await req("POST", "/api/media/sign", { urls: [BARE], transform: { width: 0.1 } });
    assert.equal(r.status, 200);
    assert.equal(sc.counters.signs, 1);
    const opts = sc.signedPaths[0].options;
    assert.notEqual(
      opts?.transform?.width, 0,
      "width:0 must never reach createSignedUrl — a zero-pixel render is not a size",
    );
    assert.equal(opts, undefined, "a sub-unit width is a no-resize signal: the whole transform is dropped");
  });

  it("POST /media/sign: { width: 0.5 } still rounds UP to a real size", async () => {
    const sc = makeFailFake(allowSpec());
    setClients(sc);
    const r = await req("POST", "/api/media/sign", { urls: [BARE], transform: { width: 0.5 } });
    assert.equal(r.status, 200);
    assert.equal(sc.signedPaths[0].options?.transform?.width, 1);
  });

  it("POST /media/sign: width is capped at 3000 however large the ask", async () => {
    const sc = makeFailFake(allowSpec());
    setClients(sc);
    await req("POST", "/api/media/sign", { urls: [BARE], transform: { width: 10_000_000 } });
    assert.equal(sc.signedPaths[0].options?.transform?.width, 3000);
  });

  it("GET /media/file: width is capped at 3000 and never lands on 0", async () => {
    for (const [raw, expected] of [["10000000", 3000], ["0.1", 1], ["0", undefined]] as const) {
      const sc = makeFailFake(allowSpec());
      setClients(sc);
      _clearMediaAccessCache();
      const r = await req("GET", `/api/media/file/post-media/${OBJ}?width=${raw}`);
      assert.equal(r.status, 302, `width=${raw} should still serve`);
      const w = sc.signedPaths[0].options?.transform?.width;
      assert.equal(w, expected, `width=${raw} produced ${w}`);
      assert.notEqual(w, 0, "the GET handler must never forward width:0 either");
    }
  });

  it("the batch caps how many objects one request may ask to sign", async () => {
    const sc = makeFailFake(allowSpec());
    setClients(sc);
    const r = await req("POST", "/api/media/sign", { urls: Array.from({ length: 51 }, () => BARE) });
    assert.equal(r.status, 400, "51 urls must be refused, not served");
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(sc.counters.signs, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Every place in the tree that mints a signed URL over a MEDIA bucket, and what
 * authorizes it. A new signing site that is not on this list fails the test —
 * the point is that adding one has to be a decision someone writes down, not a
 * line that slips in next to an existing import.
 *
 * The two non-relay entries are not exemptions granted here; they are what the
 * code does, restated so the test can check it still does it:
 *   routes/postcards.ts — signs for 60s and reads 64 bytes of the object with
 *     `fetch(..., { Range })` to verify the stored bytes are a video. The URL is
 *     never put in a response body.
 *   routes/adminMedia.ts — signs for 300s behind `requireAdmin` to HEAD the
 *     object for its size and dimensions. The URL is never put in a response.
 * `authorizes: "mediaAccess"` is the only value that may hand the URL to a
 * caller, and this test asserts those files import the guard.
 */
const SIGNING_SITES: ReadonlySet<string> = new Set([
  "routes/mediaFile.ts",
  "routes/postcards.ts",
  "routes/adminMedia.ts",
]);
const RELAY_FILES: ReadonlySet<string> = new Set(["routes/mediaFile.ts"]);

describe("no un-guarded signing site has appeared", () => {
  const SRC = path.resolve(import.meta.dirname, "..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "test" || e.name === "node_modules" || e.name === "migrations" || e.name === "scripts") continue;
        walk(p, out);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        out.push(p);
      }
    }
    return out;
  }

  it("enumerates every createSignedUrl site and finds only known ones", () => {
    const files = walk(SRC);
    assert.ok(files.length > 100, `expected a real tree walk, inspected only ${files.length} files`);

    const found: string[] = [];
    for (const f of files) {
      const body = fs.readFileSync(f, "utf8");
      if (/\bcreateSignedUrls?\s*\(/.test(body)) {
        found.push(path.relative(SRC, f).split(path.sep).join("/"));
      }
    }
    // Anti-vacuity: if the scan finds nothing, the regex or the walk is broken
    // and every assertion below is trivially true.
    assert.ok(found.length >= 3, `expected at least 3 signing sites, found ${found.length}: ${found.join(", ")}`);

    const unknown = found.filter((f) => !SIGNING_SITES.has(f) && !f.startsWith("routes/stamps"));
    assert.deepEqual(
      unknown, [],
      `a new signed-URL site appeared and nothing here says what authorizes it: ${unknown.join(", ")}. ` +
      `Add it to SIGNING_SITES with the reason, or route it through lib/mediaAccess.`,
    );
  });

  it("every relay file imports the guard, and calls it before signing", () => {
    let checked = 0;
    for (const rel of RELAY_FILES) {
      const body = fs.readFileSync(path.join(SRC, rel), "utf8");
      checked++;
      assert.match(body, /from "\.\.\/lib\/mediaAccess\.js"/, `${rel} must import lib/mediaAccess`);
      const authorizeAt = body.indexOf("authorizeMediaAccess(sc");
      const signAt = body.indexOf("createSignedUrl(");
      assert.ok(authorizeAt > 0, `${rel} must call authorizeMediaAccess`);
      assert.ok(signAt > 0, `${rel} must call createSignedUrl`);
      // Both handlers call the guard; count them so a handler that stops
      // calling it is caught even while the other still does.
      const calls = body.match(/authorizeMediaAccess\(sc/g) ?? [];
      assert.equal(calls.length, 2, `${rel} has 2 handlers that serve media; both must authorize (found ${calls.length})`);
    }
    assert.ok(checked > 0, "vacuous: no relay file was inspected");
  });
});
