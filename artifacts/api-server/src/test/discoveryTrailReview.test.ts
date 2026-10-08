/**
 * Lead ruling D-66 (2026-10-06), census-discovery §122: a new Trail is reviewed
 * before anyone else can see it.
 *
 *   "A newly started Trail is visible only to its creator. Until an admin
 *    approves it, it is not ranked, surfaced, linked or shared. A rejected
 *    Trail stays private to its creator and shows the reason. The
 *    3-per-person-per-day allowance (migration 3975) stays in force. Trail
 *    creation stays behind its feature flag, seeded false."
 *
 * Through the real routes (routes/trails.ts, routes/adminTrails.ts) over the
 * certification harness, for each party:
 *   C   the CREATOR sees their pending / rejected Trail (page, own list, reason);
 *   O   ANOTHER VIEWER gets 404 for it and never finds it in a list, a related
 *       list, a follow, a report, a suggestion, a link or the trending read;
 *   A   an ADMIN approves (then everyone sees it) or rejects with a reason; a
 *       non-admin is refused; a decided Trail cannot be decided again;
 *   F   a FAILED READ is a refusal, never an empty list or a public Trail;
 *   P   starting a Trail is behind trail_creation_enabled (3977, seeded FALSE);
 *   M   3977's SQL, statically (no PostgreSQL here; CI's local-db job runs it).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/discoveryTrailReview.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import trailsRouter from "../routes/trails.js";
import adminTrailsRouter from "../routes/adminTrails.js";
import { trailIsPublic, trailVisibleTo, loadViewerTrailModifier } from "../services/trails/TrailService.js";
import { maskUnseenTrailIds } from "../services/trails/trailReview.js";
import { makeFakeClient, startRouter, call, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const CREATOR = "11111111-0000-4000-8000-000000000001";
const OTHER = "22222222-0000-4000-8000-000000000002";
const ADMIN = "33333333-0000-4000-8000-000000000003";
const PENDING = "aaaaaaaa-0000-4000-8000-00000000000a";
const REJECTED = "aaaaaaaa-0000-4000-8000-00000000000b";
const PUBLIC = "aaaaaaaa-0000-4000-8000-00000000000c";
const PLACE = "ffffffff-0000-4000-8000-00000000000f";
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Rows = Array<Record<string, unknown>>;
const trail = (id: string, over: Record<string, unknown>) => ({
  id, slug: `slug-${id.slice(-2)}`, title: `Trail ${id.slice(-2)}`, description: null, destination: "lisbon", destination_key: "lisbon",
  place_scope: null, parent_trail_id: null, lifecycle_status: "active", created_by: CREATOR,
  created_at: iso(-30), updated_at: iso(-30), review_state: "approved", review_reason: null, ...over,
});

function seed(): Record<string, Rows> {
  return {
    feature_flags: [{ flag: "trail_creation_enabled", enabled: true }],
    profiles: [CREATOR, OTHER, ADMIN].map((id) => ({ id, handle: id.slice(0, 4), role: id === ADMIN ? "admin" : "user" })),
    trails: [
      trail(PENDING, { lifecycle_status: "proposed", review_state: "pending", title: "Secret Tiles Walk", slug: "secret-tiles-walk" }),
      trail(REJECTED, { review_state: "rejected", review_reason: "Duplicates an existing Trail", title: "Rejected Walk", slug: "rejected-walk" }),
      trail(PUBLIC, { created_by: OTHER, title: "Open Walk", slug: "open-walk" }),
    ],
    content_trails: [], trail_edges: [], trail_follows: [], trail_reports: [], trail_health_snapshots: [], trail_content_suggestions: [],
    trust_restrictions: [],
    places: [{ id: PLACE, name: "Cafe", latitude: 38.7, longitude: -9.1 }],
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(trailsRouter);
  all.use(adminTrailsRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

/** The harness answers no rpc; model 3977's trail_review_decide at the level the routes need. */
function withReview(c: FakeClient): FakeClient {
  (c as any).rpc = async (name: string, args: any) => {
    if (name !== "trail_review_decide") return { data: null, error: { message: `rpc ${name} not modelled` } };
    const row = ((c as any)._store.trails as any[]).find((t) => t.id === args.p_trail_id);
    if (!row) return { data: { outcome: "unknown_trail" }, error: null };
    if (row.review_state !== "pending") return { data: { outcome: "not_pending", review_state: row.review_state }, error: null };
    if (args.p_decision === "approve") { row.review_state = "approved"; if (row.lifecycle_status === "proposed") row.lifecycle_status = "active"; }
    else { row.review_state = "rejected"; row.review_reason = args.p_reason; }
    row.reviewed_by = args.p_admin_id;
    (c as any)._observed.updates.push({ table: "trails", values: { review_state: row.review_state } });
    return { data: { outcome: "decided", trail: row }, error: null };
  };
  return c;
}
function use(s: Record<string, Rows> = seed(), opts: FakeDbOptions = {}): FakeClient {
  const c = withReview(makeFakeClient(s, opts));
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  return c;
}
const get = (path: string, who: string) => call(harness.base, "GET", path, who);
/** `call` with PUT too (the harness's own helper types four methods). */
async function req(method: "GET" | "POST" | "PUT", path: string, who: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${harness.base}${path}`, {
    method, headers: { authorization: `Bearer ${who}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

describe("C — the creator", () => {
  it("C1. THE POINT: sees their pending Trail on its page, marked pending", async () => {
    use();
    const r = await get(`/v1/discovery/trails/${PENDING}`, CREATOR);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.trail.review.state, "pending");
  });
  it("C2. sees a rejected Trail with the reason", async () => {
    use();
    const r = await get(`/v1/discovery/trails/${REJECTED}`, CREATOR);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.trail.review, { state: "rejected", reason: "Duplicates an existing Trail" });
  });
  it("C3. their own list carries pending and rejected with their states; the public list carries neither", async () => {
    use();
    const mine = await get("/v1/discovery/me/trails", CREATOR);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const byId = new Map((mine.body.trails as any[]).map((t) => [t.id, t.review]));
    assert.equal(byId.get(PENDING)?.state, "pending");
    assert.equal(byId.get(REJECTED)?.reason, "Duplicates an existing Trail");
    const all = await get("/v1/discovery/trails", CREATOR);
    assert.deepEqual((all.body.trails as any[]).map((t) => t.id), [PUBLIC]);
  });
});

describe("O — another viewer: not visible, not ranked, surfaced, linked or shared", () => {
  it("O1. THE POINT: the pending Trail's page is 404, and so is the rejected one's (no reason leaks)", async () => {
    use();
    for (const id of [PENDING, REJECTED]) {
      const r = await get(`/v1/discovery/trails/${id}`, OTHER);
      assert.equal(r.status, 404, `${id}: ${JSON.stringify(r.body)}`);
      assert.doesNotMatch(JSON.stringify(r.body), /Secret Tiles|Duplicates/);
    }
  });
  it("O2. not in the public list, not in their own list", async () => {
    use();
    const all = await get("/v1/discovery/trails", OTHER);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual((all.body.trails as any[]).map((t) => t.id), [PUBLIC], "approved Trails only");
    const mine = await get("/v1/discovery/me/trails", OTHER);
    assert.ok(!(mine.body.trails as any[]).some((t) => t.id === PENDING || t.id === REJECTED));
  });
  it("O3. cannot follow, report, suggest into, link to, read trending of or the modules of the pending Trail — each 404, nothing written", async () => {
    const c = use();
    const doors: Array<["GET" | "POST" | "PUT", string, unknown]> = [
      ["PUT", `/v1/discovery/trails/${PENDING}/follow`, undefined],
      ["POST", `/v1/discovery/trails/${PENDING}/reports`, { reason: "abuse" }],
      ["POST", `/v1/discovery/trails/${PENDING}/suggestions`, { labels: [{ sourceType: "place", sourceId: PLACE, relationship: "primary" }] }],
      ["GET", `/v1/discovery/trails/${PENDING}/trending`, undefined],
      ["GET", `/v1/discovery/trails/${PENDING}/modules`, undefined],
      ["GET", `/v1/discovery/trails/${PENDING}/related`, undefined],
    ];
    for (const [m, p, b] of doors) {
      const r = await req(m, p, OTHER, b);
      assert.equal(r.status, 404, `${m} ${p}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    // Linking TO it answers exactly what linking to a Trail that does not exist answers (no oracle), and writes nothing.
    const toPending = await call(harness.base, "POST", `/v1/discovery/trails/${PUBLIC}/relations`, OTHER, { toTrailId: PENDING, edgeType: "related" });
    const toNothing = await call(harness.base, "POST", `/v1/discovery/trails/${PUBLIC}/relations`, OTHER, { toTrailId: "aaaaaaaa-0000-4000-8000-0000000000ff", edgeType: "related" });
    assert.deepEqual([toPending.status, toPending.body], [toNothing.status, toNothing.body]);
    assert.equal(c._observed.inserts.length + c._observed.updates.length + c._observed.upserts.length, 0);
  });
  it("O4. even its creator cannot follow it, link it or read it as trending while it is pending (never ranked or linked)", async () => {
    use();
    assert.equal((await req("PUT", `/v1/discovery/trails/${PENDING}/follow`, CREATOR)).status, 404);
    assert.equal((await call(harness.base, "POST", `/v1/discovery/trails/${PENDING}/relations`, CREATOR, { toTrailId: PUBLIC, edgeType: "related" })).status, 404);
    assert.equal((await get(`/v1/discovery/trails/${PENDING}/trending`, CREATOR)).status, 404);
  });
  it("O5. a related list never names a pending neighbour", async () => {
    const s = seed();
    s.trail_edges = [{ from_trail_id: PUBLIC, to_trail_id: PENDING, edge_type: "related", strength: 0.5 }];
    use(s);
    const r = await get(`/v1/discovery/trails/${PUBLIC}/related`, OTHER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(PENDING));
  });
});

describe("O6 (verifier F3 on dc0107eda5) — the canonicalisation 409 never names another person's Trail under review", () => {
  // trail_propose (3415/3977) compares a proposal against EVERY Trail, pending and rejected included, so its
  // refusal can name one. The route masks any id the caller may not see (maskUnseenTrailIds). Modelled here at
  // the rpc, as the harness answers none: the database's refusal names the conflicting Trail and suggests it as
  // the parent, which is exactly what it does for a near-duplicate.
  const refuseAgainst = (c: FakeClient, conflict: string) => {
    const base = (c as any).rpc;
    (c as any).rpc = async (name: string, args: any) => name === "trail_propose"
      ? { data: { outcome: "refused", refusals: [{ check: "duplicate_title_similarity", conflictsWith: conflict, similarity: 0.9 },
        { check: "destination_overlap", conflictsWith: conflict, similarity: 0.8 }], suggestedParentTrailId: conflict }, error: null }
      : base(name, args);
  };
  const propose = (who: string) => req("POST", "/v1/discovery/trails", who, { title: "Secret Tiles Walk Again", destination: "lisbon" });
  it("O6a. THE POINT: colliding with someone else's PENDING Trail — 409, every conflictsWith and the suggested parent are null", async () => {
    refuseAgainst(use(), PENDING);
    const r = await propose(OTHER);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.refusals.length, 2, "vacuity guard: the refusals are served, only the id is withheld");
    assert.deepEqual(r.body.refusals.map((x: any) => x.conflictsWith), [null, null]);
    assert.equal(r.body.suggestedParentTrailId, null);
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(PENDING));
  });
  it("O6b. the same for someone else's REJECTED Trail", async () => {
    refuseAgainst(use(), REJECTED);
    const r = await propose(OTHER);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(REJECTED));
  });
  it("O6c. CONTROL: colliding with an APPROVED Trail names it, and its creator's own pending Trail is named to its creator", async () => {
    refuseAgainst(use(), PUBLIC);
    const pub = await propose(OTHER);
    assert.deepEqual(pub.body.refusals.map((x: any) => x.conflictsWith), [PUBLIC, PUBLIC]);
    assert.equal(pub.body.suggestedParentTrailId, PUBLIC);
    refuseAgainst(use(), PENDING);
    const own = await propose(CREATOR);
    assert.equal(own.body.suggestedParentTrailId, PENDING);
  });
  it("O6d. the review states unreadable: no id is named (a failed read is not 'public'); CONTROL readable names only what the caller may see", async () => {
    const down = makeFakeClient(seed(), { errors: { trails: { message: "trails down", code: "57P01", ops: ["select"] } } });
    assert.deepEqual([...(await maskUnseenTrailIds(down, [PUBLIC, PENDING], OTHER))], [[PUBLIC, null], [PENDING, null]]);
    const up = makeFakeClient(seed());
    assert.deepEqual([...(await maskUnseenTrailIds(up, [PUBLIC, PENDING, REJECTED, null], OTHER))], [[PUBLIC, PUBLIC], [PENDING, null], [REJECTED, null]]);
    assert.deepEqual([...(await maskUnseenTrailIds(up, [PENDING], CREATOR))], [[PENDING, PENDING]]);
  });
});

describe("O7 (verifier on dc0107eda5, L2) — a followed Trail under review feeds nobody's ranking", () => {
  // loadViewerTrailModifier turns the viewer's followed Trails into a place affinity. A follow placed on a
  // `proposed` Trail before 3977 survives its move to `pending`, so the read narrows to approved Trails.
  const followSeed = (followed: string) => {
    const s = seed();
    s.trail_follows = [{ user_id: OTHER, trail_id: followed, created_at: iso(-5) }];
    s.content_trails = [{ id: `m-${followed.slice(-2)}`, trail_id: followed, source_type: "place", source_id: PLACE, relationship: "primary",
      confidence: 0.9, contributor_id: CREATOR, content_state: "active", created_at: iso(-10) }];
    return s;
  };
  it("O7a. THE POINT: a followed PENDING (or REJECTED) Trail contributes no affinity and is not reported as followed", async () => {
    for (const t of [PENDING, REJECTED]) {
      const r = await loadViewerTrailModifier(makeFakeClient(followSeed(t)), OTHER, [PLACE]);
      assert.equal(r.refusal, null);
      assert.deepEqual(r.followedTrailIds, [], t);
      assert.deepEqual(r.trailAffinity, {}, t);
    }
  });
  it("O7b. CONTROL: a followed APPROVED Trail does", async () => {
    const s = followSeed(PUBLIC);
    const r = await loadViewerTrailModifier(makeFakeClient(s), OTHER, [PLACE]);
    assert.deepEqual(r.followedTrailIds, [PUBLIC]);
    assert.ok((r.trailAffinity[PLACE] ?? 0) > 0, JSON.stringify(r.trailAffinity));
  });
  it("O7c. the review state unreadable: a refusal, never 'approved'", async () => {
    const r = await loadViewerTrailModifier(makeFakeClient(followSeed(PUBLIC), { errors: { trails: { message: "trails down", code: "57P01", ops: ["select"] } } }), OTHER, [PLACE]);
    assert.notEqual(r.refusal, null);
    assert.deepEqual(r.trailAffinity, {});
  });
});

describe("A — the admin", () => {
  it("A1. THE POINT: approving makes the Trail everyone's (and activates a proposed lifecycle)", async () => {
    const c = use();
    const r = await call(harness.base, "POST", `/admin/discovery/trails/${PENDING}/review`, ADMIN, { decision: "approve" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.trail.reviewState, "approved");
    assert.equal(r.body.trail.lifecycle, "active");
    assert.equal((await get(`/v1/discovery/trails/${PENDING}`, OTHER)).status, 200);
    assert.ok(c._observed.updates.length > 0);
  });
  it("A2. rejecting needs a reason (400 without one, nothing written); with one, the creator reads it and others still 404", async () => {
    const c = use();
    const none = await call(harness.base, "POST", `/admin/discovery/trails/${PENDING}/review`, ADMIN, { decision: "reject" });
    assert.equal(none.status, 400, JSON.stringify(none.body));
    assert.equal(c._observed.updates.length, 0);
    const r = await call(harness.base, "POST", `/admin/discovery/trails/${PENDING}/review`, ADMIN, { decision: "reject", reason: "Please add places first" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mine = await get(`/v1/discovery/trails/${PENDING}`, CREATOR);
    assert.deepEqual(mine.body.trail.review, { state: "rejected", reason: "Please add places first" });
    assert.equal((await get(`/v1/discovery/trails/${PENDING}`, OTHER)).status, 404);
  });
  it("A3. a non-admin cannot decide (403) and nothing changes; a decided Trail cannot be decided again (409)", async () => {
    const c = use();
    const r = await call(harness.base, "POST", `/admin/discovery/trails/${PENDING}/review`, CREATOR, { decision: "approve" });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(c._observed.updates.length, 0);
    const again = await call(harness.base, "POST", `/admin/discovery/trails/${REJECTED}/review`, ADMIN, { decision: "approve" });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.reason, "not_pending");
  });
  it("A4. the queue lists pending Trails only; a non-admin gets 403", async () => {
    use();
    const q = await get("/admin/discovery/trail-reviews/pending", ADMIN);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual((q.body.trails as any[]).map((t) => t.id), [PENDING]);
    assert.equal((await get("/admin/discovery/trail-reviews/pending", OTHER)).status, 403);
  });
});

describe("F — a failed read is a refusal", () => {
  const down: FakeDbOptions = { errors: { trails: { message: "trails down", code: "57P01", ops: ["select"] } } };
  it("F1. the creator's own list unreadable → 503, never an empty list", async () => {
    use(seed(), down);
    const r = await get("/v1/discovery/me/trails", CREATOR);
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
  it("F2. the admin queue unreadable → 503, never 'nothing pending'", async () => {
    use(seed(), { errors: { trails: { message: "trails down", code: "57P01", ops: ["select"] } } });
    const r = await get("/admin/discovery/trail-reviews/pending", ADMIN);
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
  it("F3. 3977 not applied (review_state absent, 42703) → the Trail page and the list are 503, never served as public", async () => {
    use(seed(), { errors: { trails: { message: "column trails.review_state does not exist", code: "42703", ops: ["select"] } } });
    assert.equal((await get(`/v1/discovery/trails/${PUBLIC}`, OTHER)).status, 503);
    assert.equal((await get("/v1/discovery/trails", OTHER)).status, 503);
  });
  it("F4. the pure rule fails closed: a row that does not carry review_state is not public, and is visible only to its creator", () => {
    assert.equal(trailIsPublic({}), false);
    assert.equal(trailIsPublic({ review_state: "approved" }), true);
    assert.equal(trailVisibleTo({ created_by: CREATOR }, OTHER), false);
    assert.equal(trailVisibleTo({ created_by: CREATOR, review_state: "pending" }, CREATOR), true);
    assert.equal(trailVisibleTo({ created_by: CREATOR, review_state: "pending" }, null), false);
  });
});

describe("P — starting a Trail is behind trail_creation_enabled", () => {
  it("P1. THE POINT: flag off (or not there) → refused, nothing written", async () => {
    for (const flags of [[{ flag: "trail_creation_enabled", enabled: false }], []]) {
      const s = seed(); s.feature_flags = flags;
      const c = use(s);
      const r = await call(harness.base, "POST", "/v1/discovery/trails", CREATOR, { title: "Lisbon Night Tiles", destination: "lisbon" });
      assert.notEqual(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(c._observed.inserts.length, 0);
    }
  });
  it("P2. the flag unreadable → refused (isFlagEnabled fails closed)", async () => {
    const c = use(seed(), { errors: { feature_flags: { message: "flags down", code: "57P01", ops: ["select"] } } });
    const r = await call(harness.base, "POST", "/v1/discovery/trails", CREATOR, { title: "Lisbon Night Tiles", destination: "lisbon" });
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(c._observed.inserts.length, 0);
  });
});

describe("M — 3977's SQL, statically", () => {
  const m = readFileSync(new URL("../migrations/3977_trail_review_before_visible.sql", import.meta.url), "utf8");
  const old = readFileSync(new URL("../migrations/3975_trail_proposal_daily_allowance.sql", import.meta.url), "utf8");
  const fnOf = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.trail_propose("), sql.indexOf("$fn$;", sql.indexOf("CREATE OR REPLACE FUNCTION public.trail_propose(")));
  it("M1. trail_propose is 3975's byte for byte, but for the review state in its INSERT and its answer; a person's Trail is 'pending'", () => {
    const fn = fnOf(m);
    assert.match(fn, /CASE WHEN p_created_by IS NULL THEN 'approved' ELSE 'pending' END\)/);
    const stripped = fn
      .replace(", lifecycle_status, review_state)", ", lifecycle_status)")
      .replace(/'proposed',\n    -- 3977[^\n]*\n    CASE WHEN p_created_by IS NULL THEN 'approved' ELSE 'pending' END\)/, "'proposed')")
      .replace(",\n    'review_state', v_row.review_state, 'review_reason', v_row.review_reason));", "));")
      // the parent must be approved (verifier on dc0107eda5, L3): one declared variable, one wider read, one wider refusal
      .replace("  v_parent_state text;\n  v_parent_review text;\n", "  v_parent_state text;\n")
      .replace(/  -- 2\. The declared parent, read by id and held against a concurrent archive\.\n  --    3977[^\n]*\n  --[^\n]*\n/, "  -- 2. The declared parent, read by id and held against a concurrent archive.\n")
      .replace("SELECT tr.lifecycle_status, tr.review_state INTO v_parent_state, v_parent_review", "SELECT tr.lifecycle_status INTO v_parent_state")
      .replace("IF NOT FOUND OR v_parent_state = 'archived' OR v_parent_review IS DISTINCT FROM 'approved' THEN", "IF NOT FOUND OR v_parent_state = 'archived' THEN");
    assert.equal(stripped, fnOf(old));
    assert.match(fn, /IF NOT FOUND OR v_parent_state = 'archived' OR v_parent_review IS DISTINCT FROM 'approved' THEN\s+RETURN jsonb_build_object\('outcome', 'invalid_parent'\);/,
      "a parent under review is refused at the decision, not only by the API's pre-check");
  });
  it("M2. the client door: three RESTRICTIVE select policies (trails, members, edges); 3390's permissive ones untouched", () => {
    for (const p of ["trails_review_visible ON public.trails AS RESTRICTIVE", "content_trails_review_visible ON public.content_trails AS RESTRICTIVE", "trail_edges_review_visible ON public.trail_edges AS RESTRICTIVE"]) {
      assert.ok(m.includes(`CREATE POLICY ${p}\n  FOR SELECT\n  USING (`), `${p}: SELECT, naming no role (3390's postcondition reads a role-named restrictive policy on a kept path as a deny)`);
    }
    assert.doesNotMatch(m, /_review_visible ON public\.[a-z_]+ AS RESTRICTIVE\s+FOR SELECT TO /, "no review policy names a role");
    assert.match(m, /polroles = ARRAY\[0::oid\]/, "the postcondition checks they apply to every role");
    assert.doesNotMatch(m, /DROP POLICY IF EXISTS (trails|content_trails|trail_edges)_public_select/);
  });
  it("M3. the decision: pending only, a rejection needs a reason, client roles cannot call it; the flag is seeded FALSE", () => {
    assert.match(m, /IF v_row\.review_state <> 'pending' THEN\s+RETURN jsonb_build_object\('outcome', 'not_pending'/);
    assert.match(m, /p_decision = 'reject' AND \(v_reason IS NULL/);
    assert.match(m, /REVOKE ALL ON FUNCTION public\.trail_review_decide\(uuid, uuid, text, text\) FROM PUBLIC, anon, authenticated;/);
    assert.match(m, /\('trail_creation_enabled', false,/);
    assert.match(m, /CHECK \(review_state IN \('pending', 'approved', 'rejected'\)\)/);
  });
  it("M4. co-occurrence reads approved Trails only (both joins), asserted by the migration's own postcondition", () => {
    assert.match(m, /replace\(d, 'AND t\.lifecycle_status <> ''archived''', 'AND t\.lifecycle_status <> ''archived'' AND t\.review_state = ''approved'''\)/);
    assert.match(m, /rebuild_place_cooccurrence does not read approved Trails only/);
  });
});
