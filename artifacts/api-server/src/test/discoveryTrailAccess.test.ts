/**
 * `11` §3's nine Trail actions — who may be served what, and what a retry or a
 * partial failure leaves behind (census-discovery DC-20, DV-13, DV-23, DV-24,
 * DC-02, DC-04; §51).
 *
 * Every describe below pins a defect that was LIVE at the start of §51 and was
 * RED against the code before its fix:
 *
 *   ARCHIVED     2910's RLS hides an archived Trail from every client, but the
 *                routes read on the SERVICE client and served it — detail,
 *                modules, trending, related — and accepted follows, content and
 *                reports for it.
 *   BLOCKS       a member contributed or created by someone the viewer blocked
 *                (or who blocked the viewer) was served to them.
 *   REVOCATION   a post deleted, unpublished or made private after it was
 *                attached, an event whose row is gone, a creator whose account
 *                is no longer active — all still served.
 *   DV-13        §10's creator cap counted the CONTRIBUTOR who attached a row,
 *                so one author's posts suggested by three people were three
 *                "creators".
 *   DV-23        §10 "cluster by place": posts carried no place, so near-duplicate
 *                posts about one place were never clustered; and one place
 *                attached under three labels filled two slots of one page.
 *   REPORTS      every retry of a report was a new row and a new unit of
 *                `report_rate`; a report could name another Trail's membership.
 *   DC-02        one request attaching two different contents as `primary`
 *                refused the second as a "duplicate".
 *   DC-04        the lifecycle writer wrote over a state it had not read.
 *   DV-24        a sub-Trail whose `child` edge write failed was unreachable
 *                although its `parent_trail_id` named the parent.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import {
  getTrail, getTrailModules, trailTrending, moveTrailLifecycle, relatedTrails,
  attachContentToTrail,
} from "../services/trails/TrailService.js";
import { MAX_PER_CONTRIBUTOR_PER_PAGE, MAX_PER_PLACE_PER_PAGE } from "../lib/discoveryTrailHealth.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";

const VIEWER = "11111111-1111-4111-8111-1111111111e1";
const BLOCKED = "11111111-1111-4111-8111-1111111111e2";
const AUTHOR = "11111111-1111-4111-8111-1111111111e3";
const C1 = "11111111-1111-4111-8111-1111111111e4";
const C2 = "11111111-1111-4111-8111-1111111111e5";
const C3 = "11111111-1111-4111-8111-1111111111e6";
const T = "22222222-2222-4222-8222-2222222222e1";
const T_KID = "22222222-2222-4222-8222-2222222222e2";
const T_GONE = "22222222-2222-4222-8222-2222222222e3";
const T_OTHER = "22222222-2222-4222-8222-2222222222e4";
const PLACE = "33333333-3333-4333-8333-3333333333e1";
const PLACE_2 = "33333333-3333-4333-8333-3333333333e2";
const CANON = "44444444-4444-4444-8444-4444444444e1";
const POST_1 = "55555555-5555-4555-8555-5555555555e1";
const POST_2 = "55555555-5555-4555-8555-5555555555e2";
const POST_3 = "55555555-5555-4555-8555-5555555555e3";
const EVENT = "66666666-6666-4666-8666-6666666666e1";

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Row = Record<string, any>;

/** A PostgREST-shaped fake with a REAL `.or()` (blocks narrow inside it). */
function makeDb(seed: Record<string, Row[]>, erroring: string[] = []) {
  const tables: Record<string, Row[]> = {
    trails: [], content_trails: [], trail_follows: [], trail_reports: [], trail_edges: [],
    trail_health_snapshots: [], rank_events: [], blocks: [], posts: [], events: [],
    route_plans: [], discovery_places: [],
    // census-discovery §61: attach requires the content to exist; PLACE_2 is a canonical `places` row.
    places: [{ id: PLACE_2 }],
    profiles: [VIEWER, BLOCKED, AUTHOR, C1, C2, C3].map((id) => ({ id, account_status: "active" })),
    ...seed,
  };
  const broken = new Set(erroring);
  const writes: Array<{ table: string; op: string }> = [];
  let n = 0;
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    const store = () => (tables[table] ??= []);
    const fail = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      or(expr: string) { filters.push(orPredicate(expr)); return b; },
      order() { return b; },
      limit(k: number) { limitN = k; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() {
        if (broken.has(table)) return Promise.resolve(fail());
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      insert(payload: any) {
        const list = (Array.isArray(payload) ? payload : [payload]).map((x) => ({ id: `gen-${table}-${n++}`, ...x }));
        if (!broken.has(table)) { store().push(...list); writes.push({ table, op: "insert" }); }
        const settled = broken.has(table) ? fail() : { data: list, error: null };
        const r: any = { select: () => r, maybeSingle: () => Promise.resolve({ ...settled, data: settled.data?.[0] ?? null }), then: (res: any) => Promise.resolve(settled).then(res) };
        return r;
      },
      update(patch: Row) {
        let representation = false;
        const u: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return u; },
          select() { representation = true; return u; },
          then(res: any) {
            const hit = rows();
            for (const r of hit) Object.assign(r, patch);
            writes.push({ table, op: "update" });
            return Promise.resolve({ data: representation ? hit.map((r) => ({ ...r })) : null, error: null }).then(res);
          },
        };
        return u;
      },
      delete() {
        const d: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return d; },
          then(res: any) {
            tables[table] = store().filter((r) => !filters.every((f) => f(r)));
            writes.push({ table, op: "delete" });
            return Promise.resolve({ data: null, error: null }).then(res);
          },
        };
        return d;
      },
      then(res: (r: any) => any, rej?: (e: any) => any) {
        return Promise.resolve(broken.has(table) ? fail() : { data: rows(), error: null }).then(res, rej);
      },
    };
    return b;
  }
  const auth = {
    async getUser(token: string) {
      return tables.profiles!.some((p) => p.id === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, _tables: tables, _writes: writes };
}

const trail = (id: string, over: Row = {}): Row => ({
  id, slug: `slug-${id.slice(-2)}`, title: `Trail ${id.slice(-2)}`, description: null,
  destination: "bangkok", place_scope: null, parent_trail_id: null,
  lifecycle_status: "active", created_by: VIEWER,
  created_at: iso(86_400_000), updated_at: iso(86_400_000), ...over,
});

const member = (id: string, over: Row = {}): Row => ({
  id, trail_id: T, source_type: "place", source_id: PLACE,
  relationship: "primary", signal: null, source: "user", confidence: 0.8,
  contributor_id: C1, content_state: "just_arrived", created_at: iso(3_600_000), ...over,
});

const post = (id: string, over: Row = {}): Row => ({
  id, author_id: AUTHOR, visibility: "public", status: "active", post_status: "published",
  deleted_at: null, tombstoned_at: null, publish_at: null, trip_id: null,
  canonical_place_id: null, location_place_id: null, ...over,
});

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function call(method: string, path: string, body?: unknown, as = VIEWER): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const served = async (db: any, viewerId: string | null = VIEWER) =>
  (await getTrailModules(db, T, { viewerId, pageSize: 8 })).modules.find((m) => m.key === "just_arrived")!.items.map((i) => i.id);

describe("ARCHIVED — a Trail the database hides from clients is hidden by the API too", () => {
  const seed = () => ({
    trails: [trail(T_GONE, { lifecycle_status: "archived" }), trail(T), trail(T_KID, { parent_trail_id: T, lifecycle_status: "archived" })],
    content_trails: [member("m-1", { trail_id: T_GONE })],
    trail_edges: [{ from_trail_id: T, to_trail_id: T_KID, edge_type: "child", strength: 1 }],
  });

  it("every read of an archived Trail is 404, as for a Trail that does not exist", async () => {
    for (const path of ["", "/modules", "/trending", "/related"]) {
      _setTestClient(makeDb(seed()), true);
      const r = await call("GET", `/v1/discovery/trails/${T_GONE}${path}`);
      assert.equal(r.status, 404, `GET …${path || "/:id"} served an archived Trail`);
    }
  });

  it("follow, attach, suggest and report on an archived Trail are 404 and write nothing", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["PUT", "/follow", undefined],
      ["POST", "/content", { labels: [{ sourceType: "place", sourceId: PLACE_2, relationship: "supporting" }] }],
      ["POST", "/suggestions", { labels: [{ sourceType: "place", sourceId: PLACE_2, relationship: "supporting" }] }],
      ["POST", "/reports", { reason: "stale" }],
    ];
    for (const [method, path, body] of cases) {
      const db = makeDb(seed());
      _setTestClient(db, true);
      const r = await call(method, `/v1/discovery/trails/${T_GONE}${path}`, body);
      assert.equal(r.status, 404, `${method} …${path}`);
      assert.deepEqual(db._writes, [], `${method} …${path} wrote to an archived Trail`);
    }
  });

  it("an archived neighbour is not listed as a related Trail — it would be a link to a 404", async () => {
    const r = await relatedTrails(makeDb(seed()), T);
    assert.equal(r.refusal, null);
    assert.deepEqual(r.edges.map((e) => e.trail.id), []);
  });
});

describe("BLOCKS — a blocked contributor or creator is not served to the viewer", () => {
  it("a member CONTRIBUTED by someone the viewer blocked is withheld from them, and only from them", async () => {
    const seed = () => ({
      trails: [trail(T)],
      content_trails: [member("m-mine", { source_id: PLACE }), member("m-theirs", { source_id: PLACE_2, contributor_id: BLOCKED })],
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    });
    assert.deepEqual((await served(makeDb(seed()))).sort(), ["m-mine"]);
    assert.deepEqual((await served(makeDb(seed()), C2)).sort(), ["m-mine", "m-theirs"], "a third party is not affected");
  });

  it("the block is SYMMETRIC — the contributor who blocked the viewer is withheld as well", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [member("m-theirs", { contributor_id: BLOCKED })],
      blocks: [{ blocker_id: BLOCKED, blocked_id: VIEWER }],
    });
    assert.deepEqual(await served(db), []);
  });

  it("a post whose AUTHOR is blocked is withheld even when someone else attached it", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [member("m-p", { source_type: "post", source_id: POST_1, contributor_id: C2 })],
      posts: [post(POST_1, { author_id: BLOCKED })],
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
    });
    assert.deepEqual(await served(db), []);
  });

  it("an unreadable block list withholds every member that carries a person (fail closed)", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [member("m-anon", { contributor_id: null }), member("m-person", { source_id: PLACE_2 })],
    }, ["blocks"]);
    assert.deepEqual(await served(db), ["m-anon"]);
  });

  it("GET …/modules and GET …/trending apply the block for the signed-in caller", async () => {
    const seed = () => ({
      trails: [trail(T)],
      content_trails: [member("m-theirs", { contributor_id: BLOCKED })],
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
      rank_events: Array.from({ length: 8 }, (_, i) => ({
        id: `e${i}`, surface: "discovery", item_id: `db/${PLACE}`, outcome: "save",
        served_at: iso(3_600_000 + i), outcome_at: iso(3_500_000 + i),
      })),
    });
    _setTestClient(makeDb(seed()), true);
    const mod = await call("GET", `/v1/discovery/trails/${T}/modules`);
    assert.deepEqual(mod.body.modules.flatMap((m: any) => m.items.map((i: any) => i.id)), []);
    _setTestClient(makeDb(seed()), true);
    const tr = await call("GET", `/v1/discovery/trails/${T}/trending`);
    assert.deepEqual(tr.body.items, []);
  });
});

describe("REVOCATION — content removed or hidden after it was attached is no longer served", () => {
  const withPost = (p: Row, viewer: string | null = VIEWER) => served(makeDb({
    trails: [trail(T)],
    content_trails: [member("m-p", { source_type: "post", source_id: POST_1 })],
    posts: [p],
  }), viewer);

  it("a live, public, published post is served (the control)", async () => {
    assert.deepEqual(await withPost(post(POST_1)), ["m-p"]);
  });

  it("a post DELETED, TOMBSTONED, taken down or not yet published is withheld", async () => {
    assert.deepEqual(await withPost(post(POST_1, { deleted_at: iso(1_000) })), []);
    assert.deepEqual(await withPost(post(POST_1, { tombstoned_at: iso(1_000) })), []);
    assert.deepEqual(await withPost(post(POST_1, { status: "removed" })), []);
    assert.deepEqual(await withPost(post(POST_1, { post_status: "pending_delay" })), []);
    assert.deepEqual(await withPost(post(POST_1, { publish_at: new Date(NOW + 86_400_000).toISOString() })), []);
  });

  it("a post whose row is GONE is withheld", async () => {
    assert.deepEqual(await served(makeDb({
      trails: [trail(T)], content_trails: [member("m-p", { source_type: "post", source_id: POST_1 })],
    })), []);
  });

  it("a post made PRIVATE is withheld from everyone but its author", async () => {
    assert.deepEqual(await withPost(post(POST_1, { visibility: "private" })), []);
    assert.deepEqual(await withPost(post(POST_1, { visibility: "private" }), AUTHOR), ["m-p"]);
  });

  it("a creator whose account is no longer active is not distributed", async () => {
    assert.deepEqual(await served(makeDb({
      trails: [trail(T)],
      content_trails: [member("m-p", { source_type: "post", source_id: POST_1 })],
      posts: [post(POST_1)],
      profiles: [VIEWER, C1].map((id) => ({ id, account_status: "active" })).concat([{ id: AUTHOR, account_status: "deactivated" }]),
    })), []);
  });

  it("an event whose row is gone is withheld; one that exists is served", async () => {
    const seed = (events: Row[]) => makeDb({
      trails: [trail(T)], content_trails: [member("m-e", { source_type: "event", source_id: EVENT })], events,
    });
    assert.deepEqual(await served(seed([])), []);
    // An events row as production stores it (§64 reads its visibility, state and viewer gates; all three are NOT NULL or defaulted).
    assert.deepEqual(await served(seed([{ id: EVENT, host_id: AUTHOR, visibility: "public", state: "open", verified_only: false, trust_score_min: null, age_min: null, age_max: null }])), ["m-e"]);
  });

  it("a community place submitted by a blocked user is withheld", async () => {
    assert.deepEqual(await served(makeDb({
      trails: [trail(T)], content_trails: [member("m-pl", { source_id: PLACE })],
      discovery_places: [{ id: PLACE, submitted_by: BLOCKED }],
      blocks: [{ blocker_id: BLOCKED, blocked_id: VIEWER }],
    })), []);
  });
});

describe("DV-13 — §10's creator cap counts the CREATOR, not whoever attached the row", () => {
  it("one author's three posts, suggested by three different users, are ONE creator", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [
        member("m-1", { source_type: "post", source_id: POST_1, contributor_id: C1 }),
        member("m-2", { source_type: "post", source_id: POST_2, contributor_id: C2 }),
        member("m-3", { source_type: "post", source_id: POST_3, contributor_id: C3 }),
      ],
      posts: [post(POST_1), post(POST_2), post(POST_3)],
    });
    assert.equal((await served(db)).length, MAX_PER_CONTRIBUTOR_PER_PAGE);
  });

  it("GET …/trending is capped too — a momentum list is where one creator's surge fills every place", async () => {
    const places = ["a1", "a2", "a3", "a4", "a5"].map((s) => `33333333-3333-4333-8333-3333333333${s}`);
    const db = makeDb({
      trails: [trail(T)],
      content_trails: places.map((p, i) => member(`m-${i}`, { source_id: p, contributor_id: C1 })),
      rank_events: places.flatMap((p) => Array.from({ length: 8 }, (_, i) => ({
        id: `e-${p}-${i}`, surface: "discovery", item_id: p, outcome: "save",
        served_at: iso(3_600_000 + i), outcome_at: iso(3_500_000 + i),
      }))),
    });
    const r = await trailTrending(db, T, NOW, { viewerId: VIEWER });
    assert.equal(r.items.length, MAX_PER_CONTRIBUTOR_PER_PAGE);
  });
});

describe("DV-23 — §10 saturation: posts cluster by the place they are about; one content takes one slot", () => {
  it("three authors' posts about ONE place are capped, and the remainder stays reachable", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [
        member("m-1", { source_type: "post", source_id: POST_1, contributor_id: C1 }),
        member("m-2", { source_type: "post", source_id: POST_2, contributor_id: C2 }),
        member("m-3", { source_type: "post", source_id: POST_3, contributor_id: C3 }),
      ],
      posts: [
        post(POST_1, { author_id: C1, canonical_place_id: CANON }),
        post(POST_2, { author_id: C2, canonical_place_id: CANON }),
        post(POST_3, { author_id: C3, canonical_place_id: CANON }),
      ],
    });
    const ja = (await getTrailModules(db, T, { viewerId: VIEWER, pageSize: 8 })).modules[0]!;
    assert.equal(ja.items.length, MAX_PER_PLACE_PER_PAGE);
    assert.deepEqual(ja.moreFromThisPlace, { [CANON]: 3 - MAX_PER_PLACE_PER_PAGE });
  });

  it("one place attached under three labels takes ONE slot, not two", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [
        member("m-primary", { created_at: iso(1_000) }),
        member("m-sig-1", { relationship: "signal", signal: "rooftop", created_at: iso(2_000) }),
        member("m-sig-2", { relationship: "signal", signal: "food", created_at: iso(3_000) }),
      ],
    });
    assert.deepEqual(await served(db), ["m-primary"]);
  });
});

describe("REPORTS — a retry is not a second report, and a report names a row of ITS Trail", () => {
  it("re-sending an identical open report answers `duplicate` and writes once", async () => {
    const db = makeDb({ trails: [trail(T)], content_trails: [member("m-1")] });
    _setTestClient(db, true);
    const first = await call("POST", `/v1/discovery/trails/${T}/reports`, { reason: "unrelated_content", contentTrailId: undefined });
    const again = await call("POST", `/v1/discovery/trails/${T}/reports`, { reason: "unrelated_content" });
    assert.equal(first.status, 202);
    assert.equal(again.status, 202);
    assert.equal(again.body.duplicate, true);
    assert.equal(db._tables.trail_reports!.length, 1);
  });

  it("§11 report_rate counts one per reporter per target — three rows from one user are one report", async () => {
    const db = makeDb({
      trails: [trail(T)],
      content_trails: [member("m-1"), member("m-2", { source_id: PLACE_2 })],
      trail_reports: [1, 2, 3].map((i) => ({ id: `r${i}`, trail_id: T, reported_by: C2, content_trail_id: null, reason: "stale", resolution: null })),
    });
    const r = await getTrail(db, T);
    assert.equal(r.health!.metrics.report_rate, 0.5, "1 report over 2 members, not 3 over 2");
  });

  it("a report naming ANOTHER Trail's membership row is 404 and writes nothing", async () => {
    const db = makeDb({
      trails: [trail(T), trail(T_OTHER)],
      content_trails: [member("m-elsewhere", { trail_id: T_OTHER })],
    });
    _setTestClient(db, true);
    const r = await call("POST", `/v1/discovery/trails/${T}/reports`, { reason: "unrelated_content", contentTrailId: "00000000-0000-4000-8000-00000000abcd" });
    assert.equal(r.status, 404);
    db._tables.content_trails![0]!.id = "00000000-0000-4000-8000-00000000abcd";
    const r2 = await call("POST", `/v1/discovery/trails/${T}/reports`, { reason: "unrelated_content", contentTrailId: "00000000-0000-4000-8000-00000000abcd" });
    assert.equal(r2.status, 404, "a membership of T_OTHER is not a membership of T");
    assert.equal(db._tables.trail_reports!.length, 0);
  });
});

describe("DC-02 — §4's budget is judged per content, not per request", () => {
  it("two DIFFERENT posts attached as primary in one request are both attached", async () => {
    const db = makeDb({ trails: [trail(T)], posts: [post(POST_1), post(POST_2)] });
    const r = await attachContentToTrail(db, T, [
      { sourceType: "post", sourceId: POST_1, relationship: "primary" },
      { sourceType: "post", sourceId: POST_2, relationship: "primary" },
    ], { userId: AUTHOR, mode: "attach" });
    assert.equal(r.attached, 2, `refused: ${JSON.stringify(r.capRefusals)}`);
  });

  it("one content's FULL budget does not refuse another content's label", async () => {
    const db = makeDb({
      trails: [trail(T), trail(T_OTHER)],
      content_trails: [member("m-held", { trail_id: T_OTHER, source_type: "post", source_id: POST_1 })],
      posts: [post(POST_1), post(POST_2)],
    });
    const r = await attachContentToTrail(db, T, [
      { sourceType: "post", sourceId: POST_1, relationship: "primary" },
      { sourceType: "post", sourceId: POST_2, relationship: "primary" },
    ], { userId: AUTHOR, mode: "attach" });
    assert.equal(r.attached, 1);
    assert.deepEqual(r.capRefusals.map((x) => x.reason), ["primary_already_set"]);
  });
});

describe("DC-04 — the lifecycle writer is a compare-and-set", () => {
  it("a Trail that moved between the read and the write is not overwritten", async () => {
    const db = makeDb({ trails: [trail(T, { lifecycle_status: "proposed" })] });
    // Another request takes the Trail proposed → active → stale after this
    // writer read `proposed`: simulated by moving the row the moment it is read.
    const racing: any = {
      ...db,
      from(table: string) {
        const q = db.from(table);
        if (table !== "trails") return q;
        const ms = q.maybeSingle.bind(q);
        q.maybeSingle = async () => {
          const r = await ms();
          const copy = r.data ? { ...r.data } : r.data;
          db._tables.trails![0]!.lifecycle_status = "stale";
          return { ...r, data: copy };
        };
        return q;
      },
    };
    const r = await moveTrailLifecycle(racing, T, "active");
    assert.equal(r.moved, false, "the move was decided on `proposed` and the row is `stale`");
    assert.equal(db._tables.trails![0]!.lifecycle_status, "stale");
  });
});

describe("DV-24 — the parent pointer is navigable even when its edge was never written", () => {
  it("a sub-Trail with `parent_trail_id` and NO `child` edge is reachable in both directions", async () => {
    const seed = () => makeDb({ trails: [trail(T), trail(T_KID, { parent_trail_id: T })], trail_edges: [] });
    const down = await relatedTrails(seed(), T);
    assert.deepEqual(down.edges.map((e) => [e.trail.id, e.edgeType, e.direction]), [[T_KID, "child", "out"]]);
    const up = await relatedTrails(seed(), T_KID);
    assert.deepEqual(up.edges.map((e) => [e.trail.id, e.edgeType, e.direction]), [[T, "child", "in"]]);
  });

  it("a pair the edge table already carries is listed once", async () => {
    const db = makeDb({
      trails: [trail(T), trail(T_KID, { parent_trail_id: T })],
      trail_edges: [{ from_trail_id: T, to_trail_id: T_KID, edge_type: "child", strength: 1 }],
    });
    assert.equal((await relatedTrails(db, T)).edges.length, 1);
  });
});
