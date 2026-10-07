/**
 * census-media MD269 (a) — lead ruling D-82 (docs/ops/lead-rulings-20261007-media.md):
 * while the §36 moderation stage holds any of a general post's media, the post is
 * REFUSED and nothing is written (census-media §37.8.5 option 3).
 *
 *   A. the decision (lib/media/postMediaModerationHold): stage off ⇒ clear, without
 *      reading a file; stage on ⇒ every canonical state but `active` holds; no row ⇒
 *      clear; a failed read ⇒ unknown; every app-storage form, the relay path
 *      included, is resolved;
 *   B. POST /posts: held ⇒ 409 and no posts row; unreadable ⇒ 503 (retryable) and no
 *      row; cleared ⇒ 201; stage off ⇒ 201 exactly as before;
 *   C. PATCH /posts/:id: an edit cannot put held media into a post.
 *
 * Run: node --import tsx/esm --test src/test/mediaPostMediaHoldD82.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import {
  postMediaModerationHold,
  postMediaStorageRef,
  POST_MEDIA_HELD_MESSAGE,
} from "../lib/media/postMediaModerationHold.js";
import { MEDIA_MODERATION_STAGE_FLAG } from "../lib/media/vendors/mediaVendorStages.js";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import { makeFakeClient, BEARER, type FakeState } from "./helpers.js";

const HELD = "post-media/author-1/held.jpg";
const CLEARED = "post-media/author-1/cleared.jpg";
const UNRECORDED = "post-media/author-1/legacy.jpg";
const POST_ID = "20000000-0000-4000-a000-000000000001";

type Asset = { storage_bucket: string; storage_path: string; moderation_status: string };
const ASSETS: Asset[] = [
  { storage_bucket: "post-media", storage_path: "author-1/held.jpg", moderation_status: "limited" },
  { storage_bucket: "post-media", storage_path: "author-1/cleared.jpg", moderation_status: "active" },
];

/** feature_flags + media_assets over any base client. `assetsFail` makes every media_assets read error. */
function withStage(base: any, stageOn: boolean, assets: Asset[] = ASSETS, assetsFail = false) {
  const reads: string[] = [];
  const from = base.from?.bind(base);
  const client: any = {
    ...base,
    reads,
    from(table: string) {
      if (table === "feature_flags") {
        const rows = stageOn ? [{ flag: MEDIA_MODERATION_STAGE_FLAG, enabled: true }] : [];
        const filters: Array<(r: any) => boolean> = [];
        const b: any = {
          select() { return b; },
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
          in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
          maybeSingle() { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }); },
          then(onF: any, onR: any) { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(onF, onR); },
        };
        return b;
      }
      if (table === "media_assets") {
        reads.push(table);
        const filters: Array<(r: any) => boolean> = [];
        const b: any = {
          select() { return b; },
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
          maybeSingle() {
            if (assetsFail) return Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } });
            return Promise.resolve({ data: assets.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
          },
        };
        return b;
      }
      return from(table);
    },
  };
  return client;
}

describe("A. the hold decision", () => {
  it("stage OFF ⇒ clear, and no file is read", async () => {
    const sc = withStage({ from() { throw new Error("unexpected table"); } }, false);
    assert.deepEqual(await postMediaModerationHold(sc, [HELD]), { state: "clear" });
    assert.deepEqual(sc.reads, []);
  });

  it("no media ⇒ clear, and not even the stage is read", async () => {
    let touched = 0;
    const sc: any = { from() { touched++; throw new Error("must not read"); } };
    assert.deepEqual(await postMediaModerationHold(sc, []), { state: "clear" });
    assert.equal(touched, 0);
  });

  it("stage ON: every canonical state except `active` holds the post", async () => {
    for (const status of ["limited", "processing", "rejected", "removed", "owner_deleted", "something_new"]) {
      const sc = withStage({ from() { throw new Error("x"); } }, true, [{ storage_bucket: "post-media", storage_path: "a/b.jpg", moderation_status: status }]);
      assert.deepEqual(await postMediaModerationHold(sc, ["post-media/a/b.jpg"]), { state: "held", heldCount: 1 }, status);
    }
    const ok = withStage({ from() { throw new Error("x"); } }, true);
    assert.deepEqual(await postMediaModerationHold(ok, [CLEARED]), { state: "clear" });
  });

  it("one held file among cleared ones holds the post", async () => {
    const sc = withStage({ from() { throw new Error("x"); } }, true);
    assert.deepEqual(await postMediaModerationHold(sc, [CLEARED, HELD]), { state: "held", heldCount: 1 });
  });

  it("verifier F3: with the stage ON, an app-storage file with NO canonical row is held — the stage never cleared it", async () => {
    const sc = withStage({ from() { throw new Error("x"); } }, true);
    assert.deepEqual(await postMediaModerationHold(sc, [UNRECORDED]), { state: "held", heldCount: 1 });
  });

  it("verifier F3: another spelling of the held object — double slash, query string, percent-encoding — is still held", async () => {
    for (const spelling of ["post-media//author-1/held.jpg", "post-media/author-1/held.jpg?x=1", "post-media/author-1/held%2Ejpg", "/api/media/file/post-media//author-1/held.jpg"]) {
      const sc = withStage({ from() { throw new Error("x"); } }, true);
      assert.deepEqual(await postMediaModerationHold(sc, [spelling]), { state: "held", heldCount: 1 }, spelling);
    }
    // Each canonicalises to the held row itself (not merely "no row").
    assert.deepEqual(postMediaStorageRef("post-media//author-1/held.jpg"), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" });
    assert.deepEqual(postMediaStorageRef("post-media/author-1/held.jpg?x=1"), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" });
    assert.deepEqual(postMediaStorageRef("post-media/author-1/held%2Ejpg"), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" });
    // A spelling that names our bucket but no clean object is held outright.
    for (const bad of ["post-media/a/../held.jpg", "post-media/a/%2E%2E/held.jpg", "post-media/author-1/", "post-media/a%2F%2Fb.jpg"]) {
      assert.deepEqual(postMediaStorageRef(bad), { kind: "unclean" }, bad);
      const sc = withStage({ from() { throw new Error("x"); } }, true);
      assert.deepEqual(await postMediaModerationHold(sc, [bad]), { state: "held", heldCount: 1 }, bad);
    }
  });

  it("verifier F2: a stage flag that cannot be read is UNKNOWN — refused with 'try again', never clear", async () => {
    const erroring: any = { from(table: string) {
      const b: any = { select() { return b; }, eq() { return b; }, maybeSingle() { return Promise.resolve(table === "feature_flags" ? { data: null, error: { code: "57014", message: "timeout" } } : { data: null, error: null }); } };
      return b;
    } };
    assert.deepEqual(await postMediaModerationHold(erroring, [CLEARED]), { state: "unknown", reason: "unreadable" });
    const throwing: any = { from() { throw new Error("socket hang up"); } };
    assert.deepEqual(await postMediaModerationHold(throwing, [CLEARED]), { state: "unknown", reason: "unreadable" });
    assert.deepEqual(await postMediaModerationHold(null, [CLEARED]), { state: "unknown", reason: "unreadable" });
  });

  it("verifier F4: the state is read in the §36 vocabulary — legacy 'approved' is active, legacy 'pending' and 'flagged' are held", async () => {
    const at = (status: string) => withStage({ from() { throw new Error("x"); } }, true, [{ storage_bucket: "post-media", storage_path: "a/b.jpg", moderation_status: status }]);
    assert.deepEqual(await postMediaModerationHold(at("approved"), ["post-media/a/b.jpg"]), { state: "clear" });
    assert.deepEqual(await postMediaModerationHold(at("pending"), ["post-media/a/b.jpg"]), { state: "held", heldCount: 1 });
    assert.deepEqual(await postMediaModerationHold(at("flagged"), ["post-media/a/b.jpg"]), { state: "held", heldCount: 1 });
  });

  it("a FAILED read is unknown — never clear", async () => {
    const sc = withStage({ from() { throw new Error("x"); } }, true, ASSETS, true);
    assert.deepEqual(await postMediaModerationHold(sc, [CLEARED]), { state: "unknown", reason: "unreadable" });
  });

  it("the relay path is resolved too, relative and absolute — it is not a way around the hold", async () => {
    assert.deepEqual(postMediaStorageRef("/api/media/file/post-media/author-1/held.jpg"), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" });
    assert.deepEqual(postMediaStorageRef("https://api.example.com/api/media/file/post-media/author-1/held.jpg?x=1"), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" });
    assert.deepEqual(postMediaStorageRef("/api/media/file/secrets/a.jpg"), { kind: "unclean" }, "a relay path to a bucket we do not serve is not a clean object — held, not skipped");
    assert.deepEqual(postMediaStorageRef("/api/media/file/post-media/../x.jpg"), { kind: "unclean" });
    assert.deepEqual(postMediaStorageRef("https://elsewhere.example/photo.jpg"), { kind: "foreign" }, "a foreign URL names no app object");
    const sc = withStage({ from() { throw new Error("x"); } }, true);
    assert.deepEqual(await postMediaModerationHold(sc, ["/api/media/file/post-media/author-1/held.jpg"]), { state: "held", heldCount: 1 });
  });

  it("verifier N3: a signed, authenticated or render URL to the held object is the held object — the uploader cannot sign their way past the hold", async () => {
    const host = "https://abcdefghijklmnop.supabase.co";
    for (const spelling of [
      `${host}/storage/v1/object/sign/post-media/author-1/held.jpg?token=eyJhbGciOi.x.y`,
      `${host}/storage/v1/object/authenticated/post-media/author-1/held.jpg`,
      `${host}/storage/v1/render/image/sign/post-media/author-1/held.jpg?token=t&width=400`,
      `${host}/storage/v1/render/image/authenticated/post-media/author-1/held.jpg`,
      `${host}/storage/v1/object/public/post-media/author-1/held.jpg`,
      `${host}/storage/v1/object/sign/post%2Dmedia/author-1/held.jpg?token=t`,
    ]) {
      assert.deepEqual(postMediaStorageRef(spelling), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" }, spelling);
      const sc = withStage({ from() { throw new Error("x"); } }, true);
      assert.deepEqual(await postMediaModerationHold(sc, [spelling]), { state: "held", heldCount: 1 }, spelling);
    }
    assert.deepEqual(
      postMediaStorageRef(`${host}/storage/v1/object/sign/post-media/author-1/held.jpg?token=t`),
      { kind: "object", bucket: "post-media", path: "author-1/held.jpg" },
      "it resolves to the held row itself, not merely to 'no row'",
    );
    // A storage path that still names our bucket in a shape no form above has is held outright.
    // So is our storage path behind another host (a proxy serving our project is still our storage).
    for (const odd of [
      `${host}/storage/v1/object/upload/sign/post-media/author-1/held.jpg`,
      `${host}/storage/v1/s3/post-media/author-1/held.jpg`,
      `https://cdn.example.net/proxy/storage/v1/object/sign/post-media/author-1/held.jpg?token=t`,
    ]) {
      assert.deepEqual(postMediaStorageRef(odd), { kind: "unclean" }, odd);
      const sc = withStage({ from() { throw new Error("x"); } }, true);
      assert.deepEqual(await postMediaModerationHold(sc, [odd]), { state: "held", heldCount: 1 }, odd);
    }
    // The cleared object, signed, still clears: the rule is the hold, not a ban on signed links.
    const sc = withStage({ from() { throw new Error("x"); } }, true);
    assert.deepEqual(await postMediaModerationHold(sc, [`${host}/storage/v1/object/sign/post-media/author-1/cleared.jpg?token=t`]), { state: "clear" });
  });

  it("verifier N4: the relay path in any letter case is the relay path — Express routes /API/media/file and /api/MEDIA/FILE to it", async () => {
    for (const spelling of [
      "https://api.example.com/API/media/file/post-media/author-1/held.jpg",
      "https://api.example.com/api/MEDIA/FILE/post-media/author-1/held.jpg",
      "/API/media/file/post-media/author-1/held.jpg",
      "/Api/Media/File/post-media/author-1/held.jpg",
    ]) {
      assert.deepEqual(postMediaStorageRef(spelling), { kind: "object", bucket: "post-media", path: "author-1/held.jpg" }, spelling);
      const sc = withStage({ from() { throw new Error("x"); } }, true);
      assert.deepEqual(await postMediaModerationHold(sc, [spelling]), { state: "held", heldCount: 1 }, spelling);
    }
    assert.deepEqual(postMediaStorageRef("/api/media/file/POST-MEDIA/author-1/held.jpg"), { kind: "unclean" }, "a bucket in another case is no clean object — held");
  });
});

// ── B/C. the routes ──────────────────────────────────────────────────────────

function state(): FakeState {
  return {
    users: { "author-tok": { id: "author-1" } },
    trips: new Set(),
    members: [],
    posts: [{ id: POST_ID, author_id: "author-1", status: "active", visibility: "public", content: "old", trip_id: null }],
  };
}

async function serve(client: any) {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error() {}, info() {}, warn() {} }; next(); });
  app.use("/api", postsRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function send(base: string, method: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: BEARER("author-tok"), connection: "close" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const inserted = (c: any) => (c.__inserted ?? []).filter((i: any) => i.table === "posts").length;
const updated = (c: any) => (c.__updated ?? []).filter((i: any) => i.table === "posts").length;

describe("B. POST /posts", () => {
  it("stage ON + held media ⇒ 409 with the review message, and NO posts row", async () => {
    const c = withStage(makeFakeClient(state()), true);
    const s = await serve(c);
    try {
      const r = await send(s.base, "POST", "/api/posts", { content: "sunset", visibility: "public", mediaUrls: [CLEARED, HELD] });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "conflict");
      assert.equal(r.body.message ?? r.body.error_description ?? POST_MEDIA_HELD_MESSAGE, POST_MEDIA_HELD_MESSAGE);
      assert.equal(inserted(c), 0);
    } finally { s.close(); }
  });

  it("stage ON + an unreadable media state ⇒ 503 (retryable), and NO posts row", async () => {
    const c = withStage(makeFakeClient(state()), true, ASSETS, true);
    const s = await serve(c);
    try {
      const r = await send(s.base, "POST", "/api/posts", { content: "sunset", visibility: "public", mediaUrls: [CLEARED] });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(inserted(c), 0);
    } finally { s.close(); }
  });

  it("stage ON + cleared media ⇒ 201, written", async () => {
    const c = withStage(makeFakeClient(state()), true);
    const s = await serve(c);
    try {
      const r = await send(s.base, "POST", "/api/posts", { content: "sunset", visibility: "public", mediaUrls: [CLEARED] });
      assert.equal(r.status, 201);
      assert.equal(inserted(c), 1);
    } finally { s.close(); }
  });

  it("stage OFF ⇒ the held file posts exactly as before (nothing changes until the stage is on)", async () => {
    const c = withStage(makeFakeClient(state()), false);
    const s = await serve(c);
    try {
      const r = await send(s.base, "POST", "/api/posts", { content: "sunset", visibility: "public", mediaUrls: [HELD] });
      assert.equal(r.status, 201);
      assert.equal(inserted(c), 1);
      assert.deepEqual(c.reads, [], "no media state is read while the stage is off");
    } finally { s.close(); }
  });
});

describe("C. PATCH /posts/:id", () => {
  it("an edit that adds held media ⇒ 409 and NO update; a cleared edit is applied", async () => {
    const held = withStage(makeFakeClient(state()), true);
    let s = await serve(held);
    try {
      const r = await send(s.base, "PATCH", `/api/posts/${POST_ID}`, { mediaUrls: [HELD] });
      assert.equal(r.status, 409);
      assert.equal(updated(held), 0);
    } finally { s.close(); }
    const ok = withStage(makeFakeClient(state()), true);
    s = await serve(ok);
    try {
      const r = await send(s.base, "PATCH", `/api/posts/${POST_ID}`, { mediaUrls: [CLEARED] });
      assert.notEqual(r.status, 409);
      assert.notEqual(r.status, 503);
    } finally { s.close(); }
  });
});
