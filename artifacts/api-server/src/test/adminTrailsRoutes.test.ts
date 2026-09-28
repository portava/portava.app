/**
 * census-discovery §86 (lane W10-T), DV-74 — `11` §8's Trail merge, Trail
 * archive and trend integrity review, and §15's moderation moves, over the
 * real admin router on loopback HTTP.
 *
 * What is proven HERE: the gate (requireAdmin: a signed-in non-admin is 403 and
 * nothing is called), that every write reaches its ONE 3486 function with the
 * admin as actor, the reason and an idempotency key, and how each function
 * outcome maps to HTTP (201 new, 200 replay, 409 decision, 503 not deployed).
 * That the change and its audit row land in ONE transaction, and what a merge
 * does to the data, is proven on the real schema in
 * db/trailsModeration.db.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import adminTrailsRouter from "../routes/adminTrails.js";
import { adminIdempotencyKey } from "../services/trails/trailAdmin.js";
import { makeRulesDb, type Row } from "./helpers/fakeTrailRulesDb.js";

const ADMIN = "11111111-1111-4111-8111-1111111111a1";
const USER = "11111111-1111-4111-8111-1111111111b1";
const T = "22222222-2222-4222-8222-222222222201";
const T2 = "22222222-2222-4222-8222-222222222202";
const PL = "33333333-3333-4333-8333-333333333301";

const app = express();
app.use(express.json());
app.use(adminTrailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); server.listen(0, "127.0.0.1"); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });
async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function world(outcomes: Record<string, Row> = {}, extra: Record<string, Row[]> = {}) {
  const answer = (name: string) => () => ({ data: outcomes[name] ?? { outcome: "moved" }, error: null });
  return makeRulesDb({
    profiles: [{ id: ADMIN, role: "admin", account_status: "active" }, { id: USER, role: "user", account_status: "active" }],
    trails: [{ id: T, slug: "t", title: "T", description: null, destination: null, place_scope: null, parent_trail_id: null, lifecycle_status: "active", created_by: USER, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    content_trails: [{ id: "m1", trail_id: T, source_type: "place", source_id: PL, relationship: "primary", signal: null, source: "user", confidence: 0.8, contributor_id: null, content_state: "just_arrived", created_at: new Date().toISOString() }],
    discovery_places: [{ id: PL, submitted_by: null }],
    rank_events: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, surface: "discovery", item_id: `db/${PL}`, outcome: "save", served_at: new Date(Date.now() - 3_600_000 - i).toISOString(), outcome_at: new Date().toISOString() })),
    ...extra,
  }, {
    rpc: {
      trail_admin_move_lifecycle: answer("trail_admin_move_lifecycle"),
      trail_admin_merge: answer("trail_admin_merge"),
      trail_admin_review_edge: answer("trail_admin_review_edge"),
      trend_integrity_review_record: answer("trend_integrity_review_record"),
      trail_admin_curate: answer("trail_admin_curate"),
    },
  });
}
const rpcCalls = (db: ReturnType<typeof world>) => db.writes.filter((w) => w.op === "rpc");

describe("DV-74 — the gate: requireAdmin, and nothing is called for anyone else", () => {
  it("a signed-in non-admin is 403 on every action, and no function is called", async () => {
    const db = world();
    _setTestClient(db as any, true);
    for (const [path, body] of [
      [`/admin/discovery/trails/${T}/archive`, { reason: "r" }],
      [`/admin/discovery/trails/${T}/merge`, { intoTrailId: T2, reason: "r" }],
      [`/admin/discovery/trails/${T}/lifecycle`, { to: "stale", reason: "r" }],
      [`/admin/discovery/trails/${T}/edges/review`, { toTrailId: T2, edgeType: "related", verdict: "accepted", reason: "r" }],
      ["/admin/discovery/trend-integrity/reviews", { subjectKind: "trail", subjectId: T, verdict: "suppressed", reason: "r" }],
    ] as const) {
      assert.equal((await call("POST", path, USER, body)).status, 403, path);
    }
    assert.equal((await call("GET", `/admin/discovery/trails/${T}/audit`, USER)).status, 403);
    assert.equal((await call("GET", `/admin/discovery/trend-integrity/trails/${T}`, USER)).status, 403);
    assert.equal(rpcCalls(db).length, 0);
  });
  it("a reason is required (400) — `11` §10's audit records WHY", async () => {
    const db = world();
    _setTestClient(db as any, true);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/archive`, ADMIN, {})).status, 400);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/archive`, ADMIN, { reason: "  " })).status, 400);
    assert.equal(rpcCalls(db).length, 0);
  });
});

describe("DV-74 — each action reaches its one audited function", () => {
  it("Trail archive: trail_admin_move_lifecycle(to archived), the admin as actor, the reason, a derived key; 201", async () => {
    const db = world({ trail_admin_move_lifecycle: { outcome: "moved", from: "active", to: "archived" } });
    _setTestClient(db as any, true);
    const r = await call("POST", `/admin/discovery/trails/${T}/archive`, ADMIN, { reason: "duplicate of the canonical Trail" });
    assert.equal(r.status, 201);
    assert.equal(r.body.to, "archived");
    const c = rpcCalls(db)[0]!;
    assert.equal(c.table, "trail_admin_move_lifecycle");
    assert.deepEqual(c.rows, {
      p_trail_id: T, p_to: "archived", p_actor: ADMIN, p_reason: "duplicate of the canonical Trail",
      p_idempotency_key: adminIdempotencyKey("trail_lifecycle", ADMIN, { trail: T, to: "archived", reason: "duplicate of the canonical Trail" }),
    });
  });
  it("a replay answers 200 replayed; a reused key for another request is 409; an illegal move is 409; no 3486 is 503", async () => {
    for (const [out, status] of [
      [{ outcome: "replayed", detail: {} }, 200], [{ outcome: "conflict", reason: "idempotency_key_reused" }, 409],
      [{ outcome: "refused", reason: "transition_not_allowed" }, 409], [{ outcome: "refused", reason: "unknown_trail" }, 404],
    ] as const) {
      _setTestClient(world({ trail_admin_move_lifecycle: out }) as any, true);
      const r = await call("POST", `/admin/discovery/trails/${T}/lifecycle`, ADMIN, { to: "stale", reason: "no new content in a season", idempotencyKey: "k1" });
      assert.equal(r.status, status, JSON.stringify(out));
    }
    const bare = makeRulesDb({ profiles: [{ id: ADMIN, role: "admin", account_status: "active" }] });
    _setTestClient(bare as any, true);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/archive`, ADMIN, { reason: "r" })).status, 503);
  });
  it("Trail merge: trail_admin_merge(from, into); a target that descends from the source is a 409 decision", async () => {
    const db = world({ trail_admin_merge: { outcome: "merged", detail: { members_moved: 3 } } });
    _setTestClient(db as any, true);
    const r = await call("POST", `/admin/discovery/trails/${T}/merge`, ADMIN, { intoTrailId: T2, reason: "same theme", idempotencyKey: "m-1" });
    assert.equal(r.status, 201);
    assert.equal(r.body.detail.members_moved, 3);
    assert.deepEqual(rpcCalls(db)[0]!.rows, { p_from: T, p_into: T2, p_actor: ADMIN, p_reason: "same theme", p_idempotency_key: "client:m-1" });
    _setTestClient(world({ trail_admin_merge: { outcome: "refused", reason: "target_descends_from_source" } }) as any, true);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/merge`, ADMIN, { intoTrailId: T2, reason: "x" })).status, 409);
  });
  it("edge review and trend integrity review reach their functions with the verdict", async () => {
    const db = world({ trail_admin_review_edge: { outcome: "reviewed" }, trend_integrity_review_record: { outcome: "reviewed", verdict: "suppressed" } });
    _setTestClient(db as any, true);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/edges/review`, ADMIN, { toTrailId: T2, edgeType: "geographic_sub", verdict: "accepted", reason: "Thonglor is in Bangkok" })).status, 201);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/edges/review`, ADMIN, { toTrailId: T2, edgeType: "child", verdict: "accepted", reason: "x" })).status, 400, "`child` is not reviewable here");
    assert.equal((await call("POST", "/admin/discovery/trend-integrity/reviews", ADMIN, { subjectKind: "trail", subjectId: T, verdict: "suppressed", reason: "a coordinated burst from new accounts", evidence: { momentum: 1 } })).status, 201);
    const [edge, trend] = rpcCalls(db);
    assert.equal(edge!.rows.p_verdict, "accepted");
    assert.equal(edge!.rows.p_edge_type, "geographic_sub");
    assert.equal(trend!.rows.p_verdict, "suppressed");
    assert.deepEqual(trend!.rows.p_evidence, { momentum: 1 });
  });
  it("the review's evidence is the raw reading (admin diagnostics, `11` §4) of the trend UNDER review, even while suppressed", async () => {
    const db = world({}, { trend_integrity_reviews: [{ id: "rv", subject_kind: "trail", subject_id: T, verdict: "suppressed", reason: "r", reviewed_by: ADMIN, evidence: {}, created_at: new Date().toISOString() }] });
    _setTestClient(db as any, true);
    const r = await call("GET", `/admin/discovery/trend-integrity/trails/${T}`, ADMIN);
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.momentum === "number" && r.body.momentum > 0, "the number itself, for an admin only");
    assert.equal(r.body.reviews.length, 1);
    assert.equal(r.body.reviews[0].verdict, "suppressed");
  });
});

describe("DV-21 — Local Picks' curated source: an audited admin curate over PUBLIC content only", () => {
  it("public content reaches trail_admin_curate; content an anonymous viewer could not be served is 404 and nothing is called", async () => {
    const POST_PUBLIC = "55555555-5555-4555-8555-555555555501", POST_PRIVATE = "55555555-5555-4555-8555-555555555502";
    const post = (id: string, visibility: string) => ({ id, author_id: USER, visibility, status: "active", post_status: "published", deleted_at: null, tombstoned_at: null, publish_at: null, trip_id: null, canonical_place_id: null, location_place_id: null });
    const db = world({ trail_admin_curate: { outcome: "curated", mode: "inserted" } }, { posts: [post(POST_PUBLIC, "public"), post(POST_PRIVATE, "followers")] });
    db.writes.length = 0;
    _setTestClient(db as any, true);
    const ok = await call("POST", `/admin/discovery/trails/${T}/curate`, ADMIN, { sourceType: "post", sourceId: POST_PUBLIC, relationship: "supporting", reason: "a local's pick" });
    assert.equal(ok.status, 201);
    const c = rpcCalls(db).find((w) => w.table === "trail_admin_curate")!;
    assert.equal(c.rows.p_source_id, POST_PUBLIC);
    assert.equal(c.rows.p_actor, ADMIN);
    const hidden = await call("POST", `/admin/discovery/trails/${T}/curate`, ADMIN, { sourceType: "post", sourceId: POST_PRIVATE, relationship: "supporting", reason: "x" });
    assert.equal(hidden.status, 404);
    assert.equal(rpcCalls(db).filter((w) => w.table === "trail_admin_curate").length, 1);
    assert.equal((await call("POST", `/admin/discovery/trails/${T}/curate`, USER, { sourceType: "post", sourceId: POST_PUBLIC, relationship: "supporting", reason: "x" })).status, 403);
  });
});

describe("§86.14 — a resolved rpc error is a failed admin action, never a success (check:unchecked-supabase-reads)", () => {
  it("each action whose function resolves { error } answers 503 and reports nothing as done", async () => {
    const failing = () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const db = makeRulesDb({
      profiles: [{ id: ADMIN, role: "admin", account_status: "active" }],
      trails: [{ id: T, slug: "t", title: "T", description: null, destination: null, place_scope: null, parent_trail_id: null, lifecycle_status: "active", created_by: USER, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    }, { rpc: { trail_admin_move_lifecycle: failing, trail_admin_merge: failing, trail_admin_review_edge: failing, trend_integrity_review_record: failing } });
    _setTestClient(db as any, true);
    for (const [path, body] of [
      [`/admin/discovery/trails/${T}/archive`, { reason: "r" }],
      [`/admin/discovery/trails/${T}/lifecycle`, { to: "stale", reason: "r" }],
      [`/admin/discovery/trails/${T}/merge`, { intoTrailId: T2, reason: "r" }],
      [`/admin/discovery/trails/${T}/edges/review`, { toTrailId: T2, edgeType: "related", verdict: "accepted", reason: "r" }],
      ["/admin/discovery/trend-integrity/reviews", { subjectKind: "trail", subjectId: T, verdict: "suppressed", reason: "r" }],
    ] as const) {
      const r = await call("POST", path, ADMIN, body);
      assert.equal(r.status, 503, `${path}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.replayed, undefined, "nothing is reported as done");
    }
  });
});
