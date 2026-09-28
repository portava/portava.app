/**
 * tagPendingInbox.test.ts — census-discovery §95 (lane W11-X3; DV-76, §81.4
 * routed hunk R3's server leg; register D-W11X3-4): GET /api/me/tags/pending,
 * the list the client's "Ask me first" inbox approves or declines.
 *
 *   I1  flag OFF (tag_permission_approval_required_enabled, 3468, FALSE):
 *       404 `feature_disabled` — the client's capability probe
 *   I2  flag ON: only the CALLER's pending, unremoved tags, newest first, the
 *       tagger by @handle; approved, removed and other people's tags never appear
 *   I3  an unreadable tags table is a 5xx, never an empty inbox
 *   I4  a tagger with no readable handle is listed with none (the fake cannot fail
 *       the profile read alone: requireUser reads the same table first)
 *   I5  no session: 401
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tagPendingInbox.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import tagsRouter, { TAG_PERMISSION_APPROVAL_REQUIRED_FLAG } from "../routes/tags.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";   // a tagger
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";   // the person tagged, the caller
const C = "cccccccc-0000-4000-8000-0000000000c3";   // a second tagger
const tag = (id: string, over: Record<string, unknown> = {}) => ({
  id, source_type: "post", source_id: "eeeeeeee-0000-4000-8000-0000000000e5", tagger_id: A, tagged_user_id: B,
  status: "pending", suppressed: false, created_at: "2026-09-27T10:00:00.000Z", ...over,
});
const T1 = "d1d1d1d1-0000-4000-8000-000000000001";
const T2 = "d2d2d2d2-0000-4000-8000-000000000002";
const T3 = "d3d3d3d3-0000-4000-8000-000000000003";
const T4 = "d4d4d4d4-0000-4000-8000-000000000004";
const T5 = "d5d5d5d5-0000-4000-8000-000000000005";

let server: http.Server;
let base = "";

function stage(flag: boolean, tags: Array<Record<string, unknown>>, failures: Record<string, { message: string }> = {}) {
  const tables = {
    feature_flags: flag ? [{ flag: TAG_PERMISSION_APPROVAL_REQUIRED_FLAG, enabled: true }] : [],
    profiles: [{ id: A, handle: "ana", username: null }, { id: B, handle: "bo" }, { id: C, handle: null, username: "cy" }],
    tags,
  };
  _setTestClient(makeLayoverDb(tables, { users: { [A]: A, [B]: B, [C]: C }, failures }), true);
}

function get(token: string | null, path: string): Promise<{ status: number; raw: string; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api${path}`, base);
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers }, (res) => {
      let acc = ""; res.setEncoding("utf8");
      res.on("data", (c) => { acc += c; });
      res.on("end", () => { let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; } resolve({ status: res.statusCode ?? 0, raw: acc, body: parsed }); });
    });
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { Object.assign(r, { log: { error() {}, info() {}, warn() {}, debug() {} } }); next(); });
  app.use("/api", tagsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr !== null && typeof addr === "object" ? addr.port : 0}`;
});
after(() => { server?.close(); _setTestClient(null, false); });

describe("I — GET /me/tags/pending", () => {
  it("I1 flag OFF: 404 feature_disabled", async () => {
    stage(false, [tag(T1)]);
    const r = await get(B, "/me/tags/pending");
    assert.equal(r.status, 404, r.raw);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("I2 flag ON: only the caller's pending, unremoved tags, newest first, tagger by @handle", async () => {
    stage(true, [
      tag(T1),
      tag(T2, { tagger_id: C, created_at: "2026-09-28T09:00:00.000Z" }),
      tag(T3, { status: "approved" }),
      tag(T4, { suppressed: true }),
      tag(T5, { tagged_user_id: A, tagger_id: C }),
    ]);
    const r = await get(B, "/me/tags/pending");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.tags, [
      { id: T2, sourceType: "post", sourceId: "eeeeeeee-0000-4000-8000-0000000000e5", taggedAt: "2026-09-28T09:00:00.000Z", taggerId: C, taggerHandle: "cy" },
      { id: T1, sourceType: "post", sourceId: "eeeeeeee-0000-4000-8000-0000000000e5", taggedAt: "2026-09-27T10:00:00.000Z", taggerId: A, taggerHandle: "ana" },
    ]);
    assert.ok(!/"name"|full_name|display_name/.test(r.raw), "no real name leaves the API");
  });

  it("I3 an unreadable tags table is a 5xx, never an empty inbox", async () => {
    stage(true, [tag(T1)], { "tags:select": { message: "down" } });
    const r = await get(B, "/me/tags/pending");
    assert.ok(r.status >= 500, r.raw);
    assert.ok(!Array.isArray(r.body?.tags));
  });

  it("I4 a tagger with no readable handle is listed with none — never a guessed name", async () => {
    const GONE = "f0f0f0f0-0000-4000-8000-0000000000f0";
    stage(true, [tag(T1, { tagger_id: GONE })]);
    const r = await get(B, "/me/tags/pending");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.tags.map((t: any) => [t.id, t.taggerId, t.taggerHandle]), [[T1, GONE, null]]);
  });

  it("I5 no session: 401", async () => {
    stage(true, [tag(T1)]);
    const r = await get(null, "/me/tags/pending");
    assert.equal(r.status, 401, r.raw);
  });
});
