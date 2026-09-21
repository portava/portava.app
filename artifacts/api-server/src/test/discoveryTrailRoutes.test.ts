/**
 * `11` §3 — the DISCOVERY Trails API, over the real router on loopback HTTP.
 *
 * REACHABILITY IS THE POINT OF THIS FILE. A Trail object nothing serves closes
 * no census row. Every assertion below goes through `routes/trails.ts`, which
 * `routes/index.ts:333` mounts into the app at `/api`, so each proven behaviour
 * has a real URL: /api/v1/discovery/trails…
 *
 * NOT THE OTHER TRAIL. The IG route `/v1/trails/:id/live-intel` lives in the
 * same router and reads `route_plans`. The last test in this file pins that it
 * is untouched, because the two objects sharing a filename is exactly how one
 * gets broken while adding the other.
 *
 * census-discovery rows exercised: DC-20 (nine actions), DC-02 (§4 cap refuses
 * over HTTP), DC-03 (§5 four checks refuse over HTTP), DV-21 (modules have
 * different objectives), DV-24 (relationships navigable in both directions),
 * DV-27 (no score reaches a client), DC-21 (trending by Trail — ONE of §4's
 * five).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import { _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import {
  recordTrailHealthSnapshot, moveTrailLifecycle, getTrail, getTrailModules,
  MAX_TRAIL_EXPOSURE_EVENTS,
} from "../services/trails/TrailService.js";
import {
  computeTrailHealth, TRAIL_HEALTH_METRICS, TRAIL_HEALTH_MODEL_VERSION,
  MAX_PER_CONTRIBUTOR_PER_PAGE,
} from "../lib/discoveryTrailHealth.js";
import { loadViewerTrailModifier } from "../services/trails/TrailService.js";
import {
  loadDiscoveryModifiers, invalidateDiscoveryModifiersFlagCache,
  DISCOVERY_MODIFIERS_FLAG,
} from "../lib/discoveryModifiers.js";
import { scoreCandidate } from "../lib/portavaRank.js";
import { TRAIL_AFFINITY_MAX_CONTRIBUTION } from "../lib/discoveryTrailAffinity.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const T_DARK = "22222222-2222-4222-8222-222222222201";
const T_ROOF = "22222222-2222-4222-8222-222222222202";
const T_GONE = "22222222-2222-4222-8222-222222222203";
const MISSING = "22222222-2222-4222-8222-2222222222ff";
const PLACE_A = "33333333-3333-4333-8333-333333333301";
const PLACE_B = "33333333-3333-4333-8333-333333333302";
const M1 = "44444444-4444-4444-8444-444444444401";
const M2 = "44444444-4444-4444-8444-444444444402";

type Row = Record<string, any>;

/**
 * A deterministic v4-shaped uuid for a row the fake inserts. Deterministic so a
 * failure is reproducible; uuid-shaped so the routes' own `z.string().uuid()`
 * guards accept it on the NEXT request of the same flow.
 */
function generatedUuid(table: string, n: number): string {
  let h = 2166136261;
  for (const ch of `${table}:${n}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}00000000`.slice(0, 36);
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/**
 * A small PostgREST-shaped fake. It supports only what these routes call —
 * select/insert/delete/update with eq, neq, in, is, gt, ilike, or, order, limit,
 * maybeSingle — and every unsupported call would throw rather than quietly
 * return everything, so a route that grew a new filter fails here loudly.
 *
 * `missingTables` makes a named table answer with Postgres 42P01, which is how
 * every deployment without migration 2910 behaves today. That is a REFUSAL
 * path, and it is tested as carefully as the happy one.
 */
function makeDb(
  seed: Record<string, Row[]>,
  missingTables: string[] = [],
  // HOW the table reports missing. PostgREST answers one of two ways and they
  // do not look alike: Postgres 42P01 carries `relation "x" does not exist`,
  // while a schema-cache miss carries PGRST205 and a message that says neither
  // "relation" nor "does not exist". Code that recognised only the first would
  // 500 on every request between a migration and a schema reload — which is
  // exactly the window a deploy runs in.
  missingStyle: "postgres" | "schema-cache" | "message-only" = "postgres",
  // A table that is PRESENT and whose read FAILS. Distinct from `missingTables`
  // on purpose: a missing relation is "this deployment has no such object",
  // which is a true fact about the world, while a statement timeout is "the
  // answer is unknown". Code that cannot tell them apart turns the second into
  // the first, and an unknown reported as an absence is a false claim.
  erroringTables: string[] = [],
) {
  const tables: Record<string, Row[]> = {
    profiles: [USER, OTHER].map((id) => ({ id, account_status: "active", role: "user" })),
    trails: [], content_trails: [], trail_edges: [], trail_follows: [],
    trail_reports: [], trail_health_snapshots: [], rank_events: [],
    feature_flags: [],
    ...seed,
  };
  const missing = new Set(missingTables);
  const erroring = new Set(erroringTables);
  const writes: Array<{ table: string; op: string; rows: any }> = [];

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let selectCols: string | null = null;
    let limitN: number | null = null;
    const store = () => (tables[table] ??= []);
    const missingError = () => {
      if (missingStyle === "postgres") {
        return { code: "42P01", message: `relation "public.${table}" does not exist` };
      }
      if (missingStyle === "schema-cache") {
        return { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` };
      }
      // A client that surfaced no code at all. Not hypothetical housekeeping:
      // it is the shape that makes the message fallback load-bearing, and
      // without this case a mutation can delete that fallback unnoticed.
      return { code: "", message: `relation "public.${table}" does not exist` };
    };
    const transientError = () => ({
      code: "57014", message: "canceling statement due to statement timeout",
    });
    const err = () => ({
      data: null,
      error: erroring.has(table) ? transientError() : missingError(),
    });

    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const broken = () => missing.has(table) || erroring.has(table);
    const run = () => (broken() ? err() : { data: rows(), error: null });
    const one = () => {
      if (broken()) return Promise.resolve(err());
      const r = rows();
      return Promise.resolve({ data: r[0] ?? null, error: null });
    };

    const b: any = {
      select(cols?: string) { selectCols = cols ?? null; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      ilike(c: string, pattern: string) {
        const needle = pattern.replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[c] ?? "").toLowerCase().includes(needle));
        return b;
      },
      // The peer read in proposeTrail. The fake returns every row and lets the
      // PURE canonicalisation decide, which is the stricter test: it cannot pass
      // by the comparison set happening to be empty.
      or() { return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle: one,
      single: one,
      insert(payload: any) {
        const inserted = Array.isArray(payload) ? payload : [payload];
        if (broken()) {
          const r: any = { data: null, error: err().error };
          r.select = () => r; r.maybeSingle = () => Promise.resolve(r);
          r.then = (res: any) => Promise.resolve(r).then(res);
          return r;
        }
        writes.push({ table, op: "insert", rows: inserted });
        // A generated id must be a UUID: every :id route validates one with zod
        // before it reaches a service, so a fake that minted `gen-trails-0`
        // could never be followed by a second request in the same story — the
        // end-to-end flow would 400 at step two and look like a route bug.
        const stored = inserted.map((x, i) => ({ id: generatedUuid(table, store().length + i), ...x }));
        store().push(...stored);
        const result: any = { data: stored, error: null };
        result.select = () => result;
        result.maybeSingle = () => Promise.resolve({ data: stored[0] ?? null, error: null });
        result.then = (res: any) => Promise.resolve({ data: stored, error: null }).then(res);
        return result;
      },
      delete() {
        const d: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return d; },
          then(res: any) {
            if (broken()) return Promise.resolve(err()).then(res);
            const keep = store().filter((r) => !filters.every((f) => f(r)));
            const removed = store().length - keep.length;
            tables[table] = keep;
            writes.push({ table, op: "delete", rows: removed });
            return Promise.resolve({ data: null, error: null }).then(res);
          },
        };
        return d;
      },
      update(patch: Row) {
        const u: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return u; },
          then(res: any) {
            if (broken()) return Promise.resolve(err()).then(res);
            for (const r of rows()) Object.assign(r, patch);
            writes.push({ table, op: "update", rows: patch });
            return Promise.resolve({ data: null, error: null }).then(res);
          },
        };
        return u;
      },
      then(res: (r: any) => any, rej?: (e: any) => any) {
        void selectCols;
        return Promise.resolve(run()).then(res, rej);
      },
    };
    return b;
  }

  const auth = {
    async getUser(token: string) {
      return tables.profiles.some((p) => p.id === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, _tables: tables, _writes: writes };
}

const trail = (id: string, over: Row = {}): Row => ({
  id, slug: `slug-${id.slice(-4)}`, title: `Trail ${id.slice(-4)}`, description: null,
  destination: "bangkok", place_scope: null, parent_trail_id: null,
  lifecycle_status: "active", created_by: USER,
  created_at: iso(86_400_000), updated_at: iso(86_400_000), ...over,
});

const member = (id: string, over: Row = {}): Row => ({
  id, trail_id: T_DARK, source_type: "place", source_id: PLACE_A,
  relationship: "primary", signal: null, source: "user", confidence: 0.8,
  contributor_id: USER, content_state: "just_arrived", created_at: iso(3_600_000), ...over,
});

// Typed as the fake's own store shape rather than inferred: an inferred literal
// type makes `seed.rank_events = …` and `{ ...SEED(), trail_follows: [] }` both
// compile errors in a fixture that the fake accepts perfectly well, which is a
// gate firing on the test's shape instead of on production's.
const SEED = (): Record<string, Row[]> => ({
  trails: [
    trail(T_DARK, { slug: "bangkok-after-dark", title: "Bangkok After Dark" }),
    trail(T_ROOF, { slug: "bangkok-rooftops", title: "Bangkok Rooftops", parent_trail_id: T_DARK }),
    trail(T_GONE, { slug: "bangkok-gone", title: "Bangkok Gone", lifecycle_status: "archived" }),
  ],
  content_trails: [
    member(M1),
    member(M2, { source_id: PLACE_B, contributor_id: OTHER, content_state: "evergreen", confidence: 0.9, created_at: iso(10 * 86_400_000) }),
  ],
  trail_edges: [
    { from_trail_id: T_DARK, to_trail_id: T_ROOF, edge_type: "child", strength: 0.8, updated_at: iso(0) },
  ],
  // Present and empty so a test that seeds outcome rows assigns into a declared
  // field instead of widening the seed with an untyped one.
  rank_events: [] as Row[],
});

// ── The app ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";

before(async () => {
  // Port 0 on loopback, and the "listening" event is awaited rather than
  // assumed: a test that races the bind reports a connection refusal as a
  // product failure, which is the worst kind of flake to debug.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function call(
  method: string, path: string, as: string | null, body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${as}`;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const withDb = (
  seed: Record<string, Row[]> = SEED(), missing: string[] = [],
  style: "postgres" | "schema-cache" | "message-only" = "postgres",
  erroring: string[] = [],
) => {
  _resetLocalMomentumCacheForTest();
  const db = makeDb(seed, missing, style, erroring);
  _setTestClient(db, true);
  return db;
};

// ── DC-20: the nine actions of `11` §3 are reachable ────────────────────────

describe("DC-20 — `11` §3's nine Trail actions are reachable over HTTP", () => {
  it("1 list/search — archived Trails are excluded, and search runs on the canonical slug", async () => {
    withDb();
    const all = await call("GET", "/v1/discovery/trails", USER);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.trails.map((t: any) => t.slug).sort(),
      ["bangkok-after-dark", "bangkok-rooftops"]);

    withDb();
    const found = await call("GET", "/v1/discovery/trails?q=rooftops", USER);
    assert.deepEqual(found.body.trails.map((t: any) => t.slug), ["bangkok-rooftops"]);
  });

  it("2 get Trail — returns §12's status WORD and no score of any kind (DV-27)", async () => {
    withDb();
    const r = await call("GET", `/v1/discovery/trails/${T_DARK}`, USER);
    assert.equal(r.status, 200);
    assert.match(r.body.status, /^(Active|Fresh today|Needs updates|Seasonal|Quiet right now)$/);
    const serialised = JSON.stringify(r.body);
    for (const leak of ["healthScale", "contributor_concentration", "confidence", "momentum", "metrics"]) {
      assert.ok(!serialised.includes(leak), `a score/metric leaked to the client: ${leak}`);
    }
  });

  it("2b an unknown Trail is 404 and a non-uuid is 400", async () => {
    withDb();
    assert.equal((await call("GET", `/v1/discovery/trails/${MISSING}`, USER)).status, 404);
    withDb();
    assert.equal((await call("GET", "/v1/discovery/trails/not-a-uuid", USER)).status, 400);
  });

  it("3 get Trail modules — DV-21: four modules, four DIFFERENT objectives, not chronological-only", async () => {
    withDb();
    const r = await call("GET", `/v1/discovery/trails/${T_DARK}/modules`, USER);
    assert.equal(r.status, 200);
    const objectives = r.body.modules.map((m: any) => m.objective);
    assert.deepEqual(objectives, ["recency", "momentum", "durable_quality", "curation"]);
    assert.equal(new Set(objectives).size, 4,
      "DV-21's criterion is that ranking is MODULAR rather than chronological-only");
    assert.ok(r.body.modules.every((m: any) => "horizonMs" in m),
      "§8: each spotlight has its own objective AND time horizon");
  });

  it("4 follow and unfollow", async () => {
    const db = withDb();
    const f = await call("PUT", `/v1/discovery/trails/${T_DARK}/follow`, USER);
    assert.equal(f.status, 200);
    assert.equal(f.body.following, true);
    assert.equal(db._tables.trail_follows.length, 1);

    const u = await call("DELETE", `/v1/discovery/trails/${T_DARK}/follow`, USER);
    assert.equal(u.status, 200);
    assert.equal(u.body.following, false);
    assert.equal(db._tables.trail_follows.length, 0);
  });

  it("5 suggest association writes at a LOWER confidence than 6 attach", async () => {
    const dbAttach = withDb();
    await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "supporting" }],
    });
    const attached = dbAttach._writes.find((w) => w.table === "content_trails")!.rows[0];

    const dbSuggest = withDb();
    await call("POST", `/v1/discovery/trails/${T_ROOF}/suggestions`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "supporting" }],
    });
    const suggested = dbSuggest._writes.find((w) => w.table === "content_trails")!.rows[0];

    assert.ok(suggested.confidence < attached.confidence,
      `a third party's suggestion is evidence, not a statement: ${suggested.confidence} vs ${attached.confidence}`);
  });

  it("6 attach/detach — detach refuses a row the caller did not contribute", async () => {
    withDb();
    const mine = await call("DELETE", `/v1/discovery/trails/${T_DARK}/content/${M1}`, USER);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.detached, true);

    withDb();
    // M2's contributor is OTHER. USER must get the SAME answer as for a row
    // that does not exist — existence must not leak through the refusal shape.
    const theirs = await call("DELETE", `/v1/discovery/trails/${T_DARK}/content/${M2}`, USER);
    withDb();
    const absent = await call("DELETE", `/v1/discovery/trails/${T_DARK}/content/${MISSING}`, USER);
    assert.equal(theirs.status, absent.status);
    assert.deepEqual(theirs.body, absent.body);
  });

  it("7 propose Trail — a clean proposal is created with its canonical slug", async () => {
    const db = withDb({ ...SEED(), trails: [] });
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "Kyoto Hidden Temples", destination: "Kyoto",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.trail.slug, "kyoto-hidden-temples");
    assert.equal(r.body.trail.lifecycle, "proposed");
    assert.equal(db._writes.filter((w) => w.table === "trails").length, 1);
  });

  it("8 report — a reason outside §15's five is refused at the boundary", async () => {
    const db = withDb();
    const ok = await call("POST", `/v1/discovery/trails/${T_DARK}/reports`, USER, { reason: "unrelated_content" });
    assert.equal(ok.status, 202);
    assert.equal(db._tables.trail_reports.length, 1);
    // §15 makes resolution an ADMIN action: the reporting route must never set it.
    assert.equal(db._tables.trail_reports[0].resolution, undefined);

    withDb();
    const bad = await call("POST", `/v1/discovery/trails/${T_DARK}/reports`, USER, { reason: "i_dont_like_it" });
    assert.equal(bad.status, 400);
  });

  it("9 related Trails — DV-24: navigable in BOTH directions", async () => {
    withDb();
    const down = await call("GET", `/v1/discovery/trails/${T_DARK}/related`, USER);
    assert.equal(down.status, 200);
    assert.deepEqual(down.body.related.map((e: any) => [e.trail.slug, e.direction]), [["bangkok-rooftops", "out"]]);

    withDb();
    const up = await call("GET", `/v1/discovery/trails/${T_ROOF}/related`, USER);
    assert.deepEqual(up.body.related.map((e: any) => [e.trail.slug, e.direction]), [["bangkok-after-dark", "in"]]);
  });
});

// ── DC-03 over HTTP ─────────────────────────────────────────────────────────

describe("DC-03 — §5's canonicalization checks refuse a proposal at the API boundary", () => {
  it("a re-spelling of an existing Trail is 409 and NAMES the check that refused", async () => {
    const db = withDb();
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "bangkok  after   dark", destination: "bangkok",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "canonicalization_refused");
    const checks = r.body.refusals.map((x: any) => x.check);
    assert.ok(checks.includes("duplicate_title_similarity"), JSON.stringify(checks));
    assert.equal(db._writes.filter((w) => w.table === "trails").length, 0, "nothing was written");
  });

  it("a narrower title under an existing Trail is refused AND handed its parent (§6)", async () => {
    withDb();
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "Bangkok After Dark Rooftops", destination: "bangkok",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.suggestedParentTrailId, T_DARK,
      "§6: 'this belongs under Bangkok After Dark' is an instruction, not just a No");
  });

  // §6's own example list: `Bangkok After Dark` → Rooftops · **Thonglor** ·
  // Live Music · Luxury Nights. A sub-Trail by definition overlaps its parent,
  // so refusing every overlap would make §6's hierarchy unbuildable. Declaring
  // the parent waives the refusals THAT PARENT raised and nothing else.
  //
  // "Thonglor" rather than "Rooftops" deliberately: "Bangkok After Dark
  // Rooftops" is ALSO a strict superset of the seeded "Bangkok Rooftops", so it
  // genuinely has two candidate parents and is genuinely still refused. That is
  // correct behaviour and it is why the next test exists.
  it("declaring the §6 parent turns the refusal into a created SUB-Trail, and writes the edge", async () => {
    const db = withDb();
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "Bangkok After Dark Thonglor", destination: "bangkok", parentTrailId: T_DARK,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.trail.parentTrailId, T_DARK);
    // DV-24: the NAVIGABLE row, not just the pointer.
    const edge = db._tables.trail_edges.find((e: any) => e.to_trail_id === r.body.trail.id);
    assert.ok(edge, "a trail_edges row must exist — a pointer alone is not navigable");
    assert.equal(edge.from_trail_id, T_DARK);
    assert.equal(edge.edge_type, "child");
  });

  it("a declared parent does NOT waive a collision with a DIFFERENT Trail", async () => {
    withDb();
    // "Bangkok After Dark Rooftops" sits under BOTH seeded Trails. Declaring
    // one parent must leave the other Trail's refusal standing, or the waiver
    // becomes a way to create anything by naming any parent at all.
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "Bangkok After Dark Rooftops", destination: "bangkok", parentTrailId: T_DARK,
    });
    assert.equal(r.status, 409);
    const refused = r.body.refusals.filter((x: any) => x.check === "existing_parent_child");
    assert.deepEqual(refused.map((x: any) => x.conflictsWith), [T_ROOF],
      "only the OTHER Trail's refusal survives the waiver");
  });

  it("a declared parent does not waive a DUPLICATE TITLE — a child that re-spells its parent IS the parent", async () => {
    withDb();
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "bangkok after dark", destination: "bangkok", parentTrailId: T_DARK,
    });
    assert.equal(r.status, 409);
    assert.ok(r.body.refusals.some((x: any) => x.check === "duplicate_title_similarity"));
  });

  it("a parent that does not exist is a 400, never a Trail with a dangling parent", async () => {
    const db = withDb();
    const r = await call("POST", "/v1/discovery/trails", USER, {
      title: "Kyoto Hidden Temples", destination: "kyoto", parentTrailId: MISSING,
    });
    assert.equal(r.status, 400);
    assert.equal(db._writes.length, 0);
  });

  it("a title that cannot be canonicalised is refused — no Trail id is invented", async () => {
    const db = withDb();
    const r = await call("POST", "/v1/discovery/trails", USER, { title: "🌙🌙", destination: "bangkok" });
    assert.equal(r.status, 409);
    assert.ok(r.body.refusals.some((x: any) => x.check === "uncanonicalisable_title"));
    assert.equal(db._writes.length, 0);
  });
});

// ── DC-02 over HTTP ─────────────────────────────────────────────────────────

describe("DC-02 — §4's label cap refuses at the API boundary", () => {
  it("a SECOND primary Trail for one piece of content is 409 and names the budget", async () => {
    const db = withDb();
    // PLACE_A already holds a primary label in T_DARK (seed row M1).
    const r = await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_A, relationship: "primary" }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "label_cap_refused");
    assert.equal(r.body.refusals[0].reason, "primary_already_set");
    assert.equal(db._writes.filter((w) => w.table === "content_trails").length, 0);
  });

  it("a signal outside §4's eight is refused before it reaches the database", async () => {
    const db = withDb();
    const r = await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "signal", signal: "vibes" }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.refusals[0].reason, "unknown_signal");
    assert.equal(db._writes.filter((w) => w.table === "content_trails").length, 0);
  });

  // A PARTIALLY refused batch is where the accepted labels and the request's
  // labels stop lining up by index. If the writer pairs them positionally, the
  // surviving label is written against the REFUSED label's content — a row that
  // is well formed, passes every constraint, and is about the wrong place.
  it("a partially refused batch writes each surviving label against its OWN content", async () => {
    const db = withDb();
    const r = await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [
        // refused: not one of §4's eight
        { sourceType: "place", sourceId: PLACE_A, relationship: "signal", signal: "vibes" },
        // accepted, and it is about PLACE_B
        { sourceType: "place", sourceId: PLACE_B, relationship: "supporting" },
      ],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attached, 1);
    const written = db._writes.find((w) => w.table === "content_trails")!.rows;
    assert.equal(written.length, 1);
    assert.equal(written[0].source_id, PLACE_B,
      "the surviving label must carry its own source, not the refused label's");
    assert.equal(written[0].relationship, "supporting");
    assert.equal(written[0].signal, null);
  });

  it("the sixth Signal is refused while the first five are kept", async () => {
    const seed = SEED();
    seed.content_trails = [
      ...["luxury", "rooftop", "food", "family", "late_night"].map((s, i) =>
        member(`sig-${i}`, { source_id: PLACE_B, relationship: "signal", signal: s, trail_id: T_ROOF })),
    ];
    const db = withDb(seed);
    const r = await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "signal", signal: "hidden_gem" }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.refusals[0].reason, "signal_cap");
    assert.equal(db._writes.filter((w) => w.table === "content_trails").length, 0);
  });
});

// ── DC-21: ONE of `11` §4's five ────────────────────────────────────────────

describe("DC-21 — trending by Trail, and `11` §4's 'never return internal raw scores'", () => {
  it("serves an order and a boolean, never a momentum number", async () => {
    const seed = SEED();
    seed.rank_events = Array.from({ length: 6 }, () => ({
      item_id: PLACE_A, outcome: "save", served_at: iso(3_600_000), outcome_at: iso(3_600_000),
    }));
    withDb(seed);
    const r = await call("GET", `/v1/discovery/trails/${T_DARK}/trending`, USER);
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.trending, "boolean");
    assert.ok(Array.isArray(r.body.items));
    assert.ok(!JSON.stringify(r.body).includes("momentum"), "`11` §4: no internal raw score to a client");
  });
});

// ── The refusal paths ───────────────────────────────────────────────────────

describe("Refusals — the paths that matter most, because they are the state of production", () => {
  it("every action is 401 without a caller", async () => {
    for (const [method, path] of [
      ["GET", "/v1/discovery/trails"],
      ["POST", "/v1/discovery/trails"],
      ["GET", `/v1/discovery/trails/${T_DARK}`],
      ["GET", `/v1/discovery/trails/${T_DARK}/modules`],
      ["GET", `/v1/discovery/trails/${T_DARK}/related`],
      ["GET", `/v1/discovery/trails/${T_DARK}/trending`],
      ["PUT", `/v1/discovery/trails/${T_DARK}/follow`],
      ["DELETE", `/v1/discovery/trails/${T_DARK}/follow`],
      ["POST", `/v1/discovery/trails/${T_DARK}/content`],
      ["POST", `/v1/discovery/trails/${T_DARK}/suggestions`],
      ["POST", `/v1/discovery/trails/${T_DARK}/reports`],
      ["DELETE", `/v1/discovery/trails/${T_DARK}/content/${M1}`],
    ] as const) {
      withDb();
      const r = await call(method, path, null, method === "GET" ? undefined : {});
      assert.equal(r.status, 401, `${method} ${path}`);
    }
  });

  // THE PRODUCTION CASE. Migration 2910 is not applied there, so `trails` does
  // not exist and PostgREST answers 42P01 on every read. That must be a 503
  // (nothing failed; the object is not deployed) and never a 500 or an empty
  // list — an empty list would be a false claim that there are no Trails.
  it("with `trails` absent every read is 503 degraded_unavailable, not 500 and not []", async () => {
    for (const path of [
      "/v1/discovery/trails",
      `/v1/discovery/trails/${T_DARK}`,
      `/v1/discovery/trails/${T_DARK}/modules`,
      `/v1/discovery/trails/${T_DARK}/related`,
      `/v1/discovery/trails/${T_DARK}/trending`,
    ]) {
      withDb(SEED(), ["trails"]);
      const r = await call("GET", path, USER);
      assert.equal(r.status, 503, path);
      assert.equal(r.body.error, "degraded_unavailable", path);
    }
  });

  // THE DEPLOY WINDOW. Between applying 2910 and PostgREST reloading its schema
  // cache the table EXISTS and the API is still told it does not — as PGRST205,
  // whose message mentions neither "relation" nor "does not exist". A detector
  // that only read the message would 500 for the length of that window. This
  // case exists because a mutation showed the message fallback was hiding
  // whether the error CODE was ever consulted.
  it("a PostgREST schema-cache miss (PGRST205) degrades exactly like 42P01, not to a 500", async () => {
    for (const path of [
      "/v1/discovery/trails",
      `/v1/discovery/trails/${T_DARK}`,
      `/v1/discovery/trails/${T_DARK}/related`,
    ]) {
      withDb(SEED(), ["trails"], "schema-cache");
      const r = await call("GET", path, USER);
      assert.equal(r.status, 503, path);
      assert.equal(r.body.error, "degraded_unavailable", path);
    }
  });

  it("an error carrying NO code but the relation message still degrades, never 500", async () => {
    withDb(SEED(), ["trails"], "message-only");
    const r = await call("GET", "/v1/discovery/trails", USER);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("with `trails` absent a WRITE is 503 too, and writes nothing", async () => {
    const db = withDb(SEED(), ["trails", "content_trails", "trail_follows", "trail_reports"]);
    const r = await call("PUT", `/v1/discovery/trails/${T_DARK}/follow`, USER);
    assert.equal(r.status, 503);
    assert.equal(db._writes.length, 0);
  });
});

// ── DC-04: §7's lifecycle has to be REACHABLE, not just declared ───────────

describe("DC-04 — §5 'community growth' is what moves a Trail out of `proposed`", () => {
  // Without a reachable promotion every Trail is stuck at `proposed` for ever:
  // the column exists, the CHECK admits five values and four of them are
  // unreachable. §5 lists "community growth" as an origin and §7 makes
  // proposed → active legal, so the first piece of content is the promotion.
  // It needs no admin, which is why it is the one this lane can honestly build.
  it("attaching the first content promotes a proposed Trail to active", async () => {
    const seed = SEED();
    seed.trails = [trail(T_ROOF, { slug: "bangkok-rooftops", lifecycle_status: "proposed" })];
    seed.content_trails = [];
    const db = withDb(seed);
    const r = await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "supporting" }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(db._tables.trails[0].lifecycle_status, "active");
  });

  it("a Trail that is already active is NOT re-written — a no-op is not a state change", async () => {
    const db = withDb();
    await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "supporting" }],
    });
    assert.equal(db._writes.filter((w) => w.table === "trails").length, 0,
      "active → active is refused by the transition relation, so nothing is written");
  });

  it("an ARCHIVED Trail is never revived by someone attaching content to it", async () => {
    const seed = SEED();
    seed.trails = [trail(T_ROOF, { slug: "bangkok-rooftops", lifecycle_status: "archived" })];
    seed.content_trails = [];
    const db = withDb(seed);
    await call("POST", `/v1/discovery/trails/${T_ROOF}/content`, USER, {
      labels: [{ sourceType: "place", sourceId: PLACE_B, relationship: "supporting" }],
    });
    assert.equal(db._tables.trails[0].lifecycle_status, "archived",
      "§7: archived is terminal — a merge revives a Trail, an attachment does not");
  });
});

describe("DC-04 — the §7 transition relation is what refuses, on its own", () => {
  // Exercised DIRECTLY, because the promotion above ALSO guards on
  // `lifecycle_status === "proposed"` and the two guards otherwise mask each
  // other: a mutation could delete the relation check and every route test
  // would stay green. The relation is the one that has to hold, because it is
  // the only guard a future caller inherits.
  const at = (lifecycle: string) => {
    const seed = SEED();
    seed.trails = [trail(T_ROOF, { slug: "bangkok-rooftops", lifecycle_status: lifecycle })];
    return withDb(seed);
  };

  it("proposed → active is allowed and written", async () => {
    const db = at("proposed");
    const r = await moveTrailLifecycle(db as any, T_ROOF, "active");
    assert.equal(r.refusal, null);
    assert.equal(r.moved, true);
    assert.equal(db._tables.trails[0].lifecycle_status, "active");
  });

  it("active → active is refused and writes NOTHING — a no-op is not a state change", async () => {
    const db = at("active");
    const r = await moveTrailLifecycle(db as any, T_ROOF, "active");
    assert.equal(r.refusal, "invalid_request");
    assert.equal(r.moved, false);
    assert.equal(db._writes.filter((w) => w.table === "trails").length, 0);
  });

  it("archived → anything is refused — §7 makes archived terminal", async () => {
    for (const to of ["active", "proposed", "needs_update", "stale"]) {
      const db = at("archived");
      const r = await moveTrailLifecycle(db as any, T_ROOF, to);
      assert.equal(r.refusal, "invalid_request", `archived → ${to}`);
      assert.equal(db._tables.trails[0].lifecycle_status, "archived");
    }
  });

  it("a target outside §7's five is refused before any read", async () => {
    const db = at("proposed");
    const r = await moveTrailLifecycle(db as any, T_ROOF, "featured");
    assert.equal(r.refusal, "invalid_request");
    assert.equal(db._tables.trails[0].lifecycle_status, "proposed");
  });
});

// ── DC-05: the health snapshot is durable, versioned and bounded ───────────

describe("DC-05 — §11 health is persisted with its model version, at most hourly", () => {
  const health = () => computeTrailHealth({
    members: [
      { source_id: PLACE_A, contributor_id: USER, confidence: 0.9, content_state: "featured", created_at: iso(3_600_000) },
      { source_id: PLACE_B, contributor_id: OTHER, confidence: 0.6, content_state: "growing", created_at: iso(7_200_000) },
    ],
    reportCount: 0,
    nowMs: Date.now(),
  });

  it("writes the nine metrics AND the model version that produced them (`10` §5)", async () => {
    const db = withDb();
    assert.equal(await recordTrailHealthSnapshot(db as any, T_DARK, health()), "written");
    const row = db._tables.trail_health_snapshots[0];
    assert.equal(row.model_version, TRAIL_HEALTH_MODEL_VERSION);
    assert.equal(row.member_count, 2);
    // A metrics blob without its version cannot be compared across a definition
    // change, which is the only thing a snapshot is for.
    assert.deepEqual(Object.keys(row.metrics).sort(), [...TRAIL_HEALTH_METRICS].sort());
  });

  it("a second call inside the hour is SKIPPED — a read path cannot grow a row per request", async () => {
    const db = withDb();
    assert.equal(await recordTrailHealthSnapshot(db as any, T_DARK, health()), "written");
    assert.equal(await recordTrailHealthSnapshot(db as any, T_DARK, health()), "skipped_recent");
    assert.equal(db._tables.trail_health_snapshots.length, 1);
  });

  it("an EMPTY Trail writes nothing — a snapshot of nothing is not a measurement", async () => {
    const db = withDb();
    const empty = computeTrailHealth({ members: [], reportCount: 0, nowMs: Date.now() });
    assert.equal(await recordTrailHealthSnapshot(db as any, T_DARK, empty), "skipped_recent");
    assert.equal(db._tables.trail_health_snapshots.length, 0);
  });

  it("with the table absent it reports `unavailable` and never throws on the read path", async () => {
    const db = withDb(SEED(), ["trail_health_snapshots"]);
    assert.equal(await recordTrailHealthSnapshot(db as any, T_DARK, health()), "unavailable");
  });
});

// ── The collision, pinned ───────────────────────────────────────────────────

describe("The IG trail in the same router is untouched", () => {
  it("GET /v1/trails/:id/live-intel still refuses an invalid uuid at ITS own path", async () => {
    withDb();
    const r = await call("GET", "/v1/trails/not-a-uuid/live-intel", USER);
    assert.equal(r.status, 400, "the IG route still owns /v1/trails/:id/live-intel");
  });

  it("the discovery Trail routes never read route_plans or route_stops", async () => {
    const db = withDb();
    await call("GET", `/v1/discovery/trails/${T_DARK}/modules`, USER);
    assert.equal(db._tables.route_plans, undefined, "route_plans was never touched");
    assert.equal(db._tables.route_stops, undefined, "route_stops was never touched");
  });
});

// ── THE COMPLETE FLOW (2026-09-14) ──────────────────────────────────────────
//
// `02` §11's "influence ranking" half, DV-18's producer and DV-25's momentum
// were all UNWIRED: the viewer modifier load had no caller, the health
// multiplier multiplied nothing, and the affinity contribution was called only
// by tests. The block below drives ONE story end to end over real loopback
// HTTP — propose a Trail, follow it, attach a place to it, serve it — and then
// takes the SAME database the HTTP writes landed in through
// `loadDiscoveryModifiers` and the SHIPPING ranker, so the claim "the Trail
// term reaches served rank" is a transcript rather than an assertion.
//
// Every step also asserts its ACCESS CONTROL, because a feature that works and
// leaks is not finished:
//   · unauthenticated is refused at every one of the four steps;
//   · a non-owner cannot detach another contributor's membership row;
//   · one viewer's Trail follows never enter another viewer's ranking — the
//     service client bypasses RLS, so the `user_id` filter in application code
//     is the only thing standing where `trail_follows_own_select` cannot;
//   · nothing the serializer withholds (health, metrics, momentum, confidence)
//     appears in any body served along the way.

const PLACE_E2E = "33333333-3333-4333-8333-3333333333e1";

describe("END TO END — propose → follow → attach → serve → ranked, with its access controls", () => {
  it("drives the whole flow over loopback HTTP and lands a bounded term in the shipping ranker", async () => {
    const db = withDb({ trails: [], content_trails: [], trail_follows: [], feature_flags: [] });
    invalidateDiscoveryModifiersFlagCache();
    const transcript: string[] = [];
    const step = async (label: string, ...args: Parameters<typeof call>) => {
      const r = await call(...args);
      transcript.push(`${args[0]} ${args[1]} as ${args[2] ?? "-"} → ${r.status}`);
      void label;
      return r;
    };

    // 1 — PROPOSE. Unauthenticated first: the refusal is part of the flow.
    assert.equal((await step("propose/anon", "POST", "/v1/discovery/trails", null,
      { title: "Bangkok Night Markets" })).status, 401);
    const created = await step("propose", "POST", "/v1/discovery/trails", USER,
      { title: "Bangkok Night Markets", destination: "Bangkok" });
    assert.equal(created.status, 201);
    const trailId: string = created.body.trail.id;

    // 2 — FOLLOW.
    assert.equal((await step("follow/anon", "PUT", `/v1/discovery/trails/${trailId}/follow`, null)).status, 401);
    assert.equal((await step("follow", "PUT", `/v1/discovery/trails/${trailId}/follow`, USER)).status, 200);

    // 3 — ATTACH a place.
    const label = { labels: [{ sourceType: "place", sourceId: PLACE_E2E, relationship: "primary" }] };
    assert.equal((await step("attach/anon", "POST", `/v1/discovery/trails/${trailId}/content`, null, label)).status, 401);
    const attached = await step("attach", "POST", `/v1/discovery/trails/${trailId}/content`, USER, label);
    assert.equal(attached.status, 201);
    assert.equal(attached.body.attached, 1);

    // 4 — SERVE. §12's word, and not one number.
    assert.equal((await step("serve/anon", "GET", `/v1/discovery/trails/${trailId}`, null)).status, 401);
    const served = await step("serve", "GET", `/v1/discovery/trails/${trailId}`, USER);
    assert.equal(served.status, 200);
    assert.equal(served.body.trail.lifecycle, "active", "§5 community growth promoted it on first content");
    for (const withheld of ["healthScale", "metrics", "momentum", "confidence", "contributor_id"]) {
      assert.ok(!JSON.stringify(served.body).includes(withheld),
        `the serializer withholds ${withheld}; it must not appear in a served body`);
    }

    // 5 — THE RANKER. Same client, same rows, one flag on.
    db._tables.feature_flags.push({ flag: DISCOVERY_MODIFIERS_FLAG, enabled: true });
    invalidateDiscoveryModifiersFlagCache();
    const mods = await loadDiscoveryModifiers(db, {
      viewerId: USER, city: "bangkok", placeIds: [PLACE_E2E, PLACE_A], cacheKey: "e2e", nowMs: Date.now(),
    });
    assert.equal(mods.enabled, true);
    assert.ok((mods.trailAffinity[PLACE_E2E] ?? 0) > 0,
      "the place attached over HTTP must carry Trail affinity into the request's modifiers");

    const ctx = { userId: USER, city: "bangkok", trailAffinity: mods.trailAffinity };
    const cand = (id: string) => ({ id, kind: "place" as const, city: "bangkok" });
    const gained = scoreCandidate(cand(PLACE_E2E), ctx).score - scoreCandidate(cand("untrailed"), ctx).score;
    assert.ok(gained > 0, "the term must MOVE the place, or it is not wired");
    assert.ok(gained <= TRAIL_AFFINITY_MAX_CONTRIBUTION + 1e-9,
      `the owner's cap bounds the whole movement: gained ${gained}`);

    // 6 — PRIVACY. Another signed-in viewer must inherit none of it.
    invalidateDiscoveryModifiersFlagCache();
    const otherMods = await loadDiscoveryModifiers(db, {
      viewerId: OTHER, city: "bangkok", placeIds: [PLACE_E2E, PLACE_A], cacheKey: "e2e", nowMs: Date.now(),
    });
    assert.deepEqual(otherMods.trailAffinity, {},
      "trail_follows is own-select under RLS; the service client bypasses RLS, so the user_id filter is the control");

    // 7 — OWNERSHIP. A stranger cannot detach the owner's membership row.
    const rowId = db._tables.content_trails.find((r: Row) => r.source_id === PLACE_E2E)!.id;
    const stolen = await step("detach/stranger", "DELETE",
      `/v1/discovery/trails/${trailId}/content/${rowId}`, OTHER);
    assert.equal(stolen.status, 404, "unknown and not-yours must be the same answer");
    assert.ok(db._tables.content_trails.some((r: Row) => r.id === rowId), "and nothing may be deleted");

    assert.deepEqual(transcript, [
      "POST /v1/discovery/trails as - → 401",
      "POST /v1/discovery/trails as " + USER + " → 201",
      `PUT /v1/discovery/trails/${trailId}/follow as - → 401`,
      `PUT /v1/discovery/trails/${trailId}/follow as ${USER} → 200`,
      `POST /v1/discovery/trails/${trailId}/content as - → 401`,
      `POST /v1/discovery/trails/${trailId}/content as ${USER} → 201`,
      `GET /v1/discovery/trails/${trailId} as - → 401`,
      `GET /v1/discovery/trails/${trailId} as ${USER} → 200`,
      `DELETE /v1/discovery/trails/${trailId}/content/${rowId} as ${OTHER} → 404`,
    ]);
  });

  it("with the modifiers flag OFF the Trail tables are not read at all", async () => {
    const db = withDb();
    invalidateDiscoveryModifiersFlagCache();
    const mods = await loadDiscoveryModifiers(db, {
      viewerId: USER, city: "bangkok", placeIds: [PLACE_A], cacheKey: "off", nowMs: Date.now(),
    });
    assert.equal(mods.enabled, false);
    assert.deepEqual(mods.trailAffinity, {},
      "an OFF flag must leave the ranker byte-identical to the pre-Trail pipeline");
  });

  it("an absent `trail_follows` table degrades to no modifier, never to a thrown request", async () => {
    const db = withDb(SEED(), ["trail_follows"]);
    db._tables.feature_flags.push({ flag: DISCOVERY_MODIFIERS_FLAG, enabled: true });
    invalidateDiscoveryModifiersFlagCache();
    const mods = await loadDiscoveryModifiers(db, {
      viewerId: USER, city: "bangkok", placeIds: [PLACE_A], cacheKey: "gone", nowMs: Date.now(),
    });
    assert.equal(mods.enabled, true);
    assert.deepEqual(mods.trailAffinity, {},
      "migration 2910 is applied to no deployment; that is the NORMAL path and it must not 500");
  });
});

describe("DV-25 + §11 — momentum and health reach the affinity the ranker receives", () => {
  const NOWMS = Date.parse("2026-09-14T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOWMS - ms).toISOString();

  /** One followed Trail, one member place, plus whatever else the case needs. */
  const followedSeed = (extra: Record<string, Row[]> = {}) => ({
    trails: [trail(T_DARK)],
    trail_follows: [{ trail_id: T_DARK, user_id: USER }],
    content_trails: [member(M1, { created_at: ago(3_600_000) })],
    ...extra,
  });

  it("DV-25 — rank_events on the Trail's members SCALE the affinity the ranker receives", async () => {
    // A surge: twelve impressions inside the 48 h window against a 30 d
    // baseline. The kernel is lib/discoveryLocalMomentum's, unchanged.
    const surge = Array.from({ length: 12 }, (_, i) => ({
      surface: "discovery", item_id: PLACE_A, outcome: "impression",
      served_at: ago(i * 3_600_000), outcome_at: null,
    }));
    const hot = await loadViewerTrailModifier(
      withDb(followedSeed({ rank_events: surge })), USER, [PLACE_A], { nowMs: NOWMS });
    const cold = await loadViewerTrailModifier(
      withDb(followedSeed({ rank_events: [] })), USER, [PLACE_A], { nowMs: NOWMS });

    assert.ok(hot.trailAffinity[PLACE_A] > cold.trailAffinity[PLACE_A],
      "DV-25: behaviour must influence Trail momentum, and momentum must reach the modifier");
    assert.ok(cold.trailAffinity[PLACE_A] > 0,
      "a quiet Trail is damped, never zeroed — a followed Trail is still the viewer's taste");
  });

  it("a FAILED momentum read is unscaled, not treated as a cold Trail", async () => {
    const read = await loadViewerTrailModifier(
      withDb(followedSeed(), ["rank_events"]), USER, [PLACE_A], { nowMs: NOWMS });
    const measuredFlat = await loadViewerTrailModifier(
      withDb(followedSeed({ rank_events: [] })), USER, [PLACE_A], { nowMs: NOWMS });
    assert.ok(read.trailAffinity[PLACE_A] > measuredFlat.trailAffinity[PLACE_A],
      "no momentum INFORMATION is a different fact from measured-and-flat, and they must not collapse");
  });

  it("§11 — an unhealthy Trail contributes LESS, and a reported one still contributes", async () => {
    // Health is a property of the WHOLE Trail, so the unhealthy fixture loads
    // one contributor posting the same place repeatedly, with open reports.
    const sick = followedSeed({
      content_trails: [
        member(M1, { created_at: ago(120 * 86_400_000) }),
        member("m-s2", { id: "m-s2", created_at: ago(120 * 86_400_000), confidence: 0.1 }),
        member("m-s3", { id: "m-s3", created_at: ago(120 * 86_400_000), confidence: 0.1 }),
      ],
      trail_reports: [
        { id: "r1", trail_id: T_DARK, resolution: null },
        { id: "r2", trail_id: T_DARK, resolution: null },
        { id: "r3", trail_id: T_DARK, resolution: null },
      ],
    });
    const ill = await loadViewerTrailModifier(withDb(sick), USER, [PLACE_A], { nowMs: NOWMS });
    const well = await loadViewerTrailModifier(withDb(followedSeed()), USER, [PLACE_A], { nowMs: NOWMS });

    assert.ok(ill.trailAffinity[PLACE_A] < well.trailAffinity[PLACE_A],
      "§11: Trail health should INFLUENCE ranking");
    assert.ok(ill.trailAffinity[PLACE_A] > 0,
      "§11: and must not SILENTLY ERASE legitimate content");
  });

  it("the read is scoped to the VIEWER — another signed-in user inherits none of it", async () => {
    const mine = await loadViewerTrailModifier(withDb(followedSeed()), USER, [PLACE_A], { nowMs: NOWMS });
    const theirs = await loadViewerTrailModifier(withDb(followedSeed()), OTHER, [PLACE_A], { nowMs: NOWMS });
    assert.ok(mine.trailAffinity[PLACE_A] > 0);
    assert.deepEqual(theirs.trailAffinity, {},
      "the service client bypasses RLS; without the user_id filter this read would hand one viewer another's follows");
    assert.deepEqual(theirs.followedTrailIds, []);
  });

  it("every refusal path yields an EMPTY affinity map — the invariant discoveryModifiers relies on", async () => {
    // lib/discoveryModifiers.ts consumes `trailAffinity` without re-checking
    // `refusal`, because there is no refusal branch here that can return rows.
    // That is the invariant, and it is asserted over EVERY refusal this service
    // can produce rather than over the one that happens to be common.
    const cases: Array<[string, Promise<{ refusal: unknown; trailAffinity: Record<string, number> }>]> = [
      ["no_service_client", loadViewerTrailModifier(null, USER, [PLACE_A], { nowMs: NOWMS })],
      ["trails_unavailable (follows)", loadViewerTrailModifier(
        withDb(followedSeed(), ["trail_follows"]), USER, [PLACE_A], { nowMs: NOWMS })],
      ["trails_unavailable (members)", loadViewerTrailModifier(
        withDb(followedSeed(), ["content_trails"]), USER, [PLACE_A], { nowMs: NOWMS })],
    ];
    for (const [label, p] of cases) {
      const r = await p;
      assert.deepEqual(r.trailAffinity, {},
        `${label} must yield no affinity; a refusal that also returned rows would reach the ranker unchecked`);
    }
  });

  it("a place in NO followed Trail is absent from the map, never present at zero", async () => {
    const r = await loadViewerTrailModifier(withDb(followedSeed()), USER, [PLACE_B], { nowMs: NOWMS });
    assert.deepEqual(r.trailAffinity, {});
  });
});

// ── DV-22 · §9 fair exposure: the denominator must be READ, and the slot must
//    change what is served ──────────────────────────────────────────────────
//
// `lib/discoveryTrailHealth.fairExposureSlots` was already correct and already
// covered by test/discoveryTrailModifier.test.ts. What it was CALLED with was
// not: `getTrailModules` passed `impressions: 0, positives: 0` for every
// candidate, so §9's "Use exposure denominators" was satisfied by a constant,
// and it was called over the page that had ALREADY been built — so the reserved
// slots could only ever name items that were being served anyway, and the route
// dropped the field before it reached a client. A reservation that reserves
// nothing and reaches nobody is not a fair-opportunity mechanism.

const P_HOT = "33333333-3333-4333-8333-333333333303";
const P_COLD = "33333333-3333-4333-8333-333333333304";
const P_THIRD = "33333333-3333-4333-8333-333333333305";
const CONTRIB_B = "11111111-1111-4111-8111-111111111113";
const CONTRIB_C = "11111111-1111-4111-8111-111111111114";

/** `n` served-item rows on `item_id`, in the window the exposure read uses. */
const served = (itemId: string, n: number, outcome = "impression"): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `re-${itemId}-${outcome}-${i}`,
    surface: "discovery",
    item_id: itemId,
    outcome,
    served_at: iso(3_600_000 + i * 1_000),
    outcome_at: outcome === "impression" ? null : iso(3_500_000 + i * 1_000),
  }));

describe("DV-22 — §9's exploration slot is judged on a real denominator and changes the page", () => {
  it("an item whose MEASURED exposure is past the ceiling takes no reserved slot; an unexposed one does", async () => {
    const db = withDb({
      ...SEED(),
      content_trails: [
        // Newest first, so without a denominator the hot item wins the slot.
        member("m-hot", { id: "m-hot", source_id: P_HOT, created_at: iso(60_000) }),
        member("m-cold", {
          id: "m-cold", source_id: P_COLD, contributor_id: CONTRIB_B, created_at: iso(120_000),
        }),
      ],
      rank_events: served(P_HOT, 600),
    });

    const r = await getTrailModules(db as any, T_DARK, { pageSize: 8 });
    const justArrived = r.modules.find((m) => m.key === "just_arrived")!;
    assert.deepEqual(justArrived.explorationSlots, ["m-cold"],
      "§9 step 1 'candidate qualifies': an item with 600 measured impressions has already had its bounded opportunity");
  });

  it("the reserved slot puts an item INTO the page that the page bound would have dropped", async () => {
    const db = withDb({
      ...SEED(),
      content_trails: [
        // Newest, and already exposed past the ceiling: recency puts it first
        // and §9 says it has had its turn.
        member("m-a", { id: "m-a", source_id: P_HOT, created_at: iso(60_000) }),
        // Oldest and unexposed, so recency alone never reaches it.
        member("m-c", {
          id: "m-c", source_id: P_THIRD, contributor_id: CONTRIB_C,
          content_state: "rediscovered", created_at: iso(9 * 86_400_000),
        }),
      ],
      rank_events: served(P_HOT, 501),
    });

    const r = await getTrailModules(db as any, T_DARK, { pageSize: 1 });
    const justArrived = r.modules.find((m) => m.key === "just_arrived")!;
    assert.deepEqual(justArrived.explorationSlots, ["m-c"]);
    assert.deepEqual(justArrived.items.map((i) => i.id), ["m-c"],
      "§9: 'every eligible new item should receive a bounded exploration opportunity' — a slot that does not reach the page is not an opportunity");
    assert.equal(justArrived.items.length, 1,
      "§9's opportunity is BOUNDED — it takes a slot, it does not widen the page");
  });

  it("the reserved slot does NOT override §10's contributor cap (DV-13 survives DV-22)", async () => {
    // FIVE unexposed items from ONE creator, on a page wide enough that §9's
    // 20 % budget reserves FOUR of them. The reservation therefore names more
    // of this creator's items than §10 will admit, which is the only fixture in
    // which the two rules actually collide: a reserved id must still be able to
    // LOSE to the cap, or an exploration slot becomes a way to buy a page.
    const mine5 = ["m-1", "m-2", "m-3", "m-4", "m-5"];
    const db = withDb({
      ...SEED(),
      content_trails: mine5.map((id, i) => member(id, {
        id,
        source_id: `33333333-3333-4333-8333-33333333330${i}`,
        created_at: iso(60_000 + i * 60_000),
      })),
      rank_events: [],
    });

    const r = await getTrailModules(db as any, T_DARK, { pageSize: 20 });
    const justArrived = r.modules.find((m) => m.key === "just_arrived")!;
    assert.deepEqual(justArrived.explorationSlots, ["m-1", "m-2", "m-3", "m-4"],
      "§9's budget is 20 % of the page, computed over the module's CANDIDATES rather than over the page it already built");
    const fromOneCreator = justArrived.items.filter((i) => mine5.includes(i.id));
    assert.equal(fromOneCreator.length, MAX_PER_CONTRIBUTOR_PER_PAGE,
      "DV-13: one creator may not exceed the per-page cap, and an exploration slot is not a way around it");
  });

  // A denominator read that came back FULL is a denominator read that was cut
  // off, and a cut-off count is wrong in the one direction that matters: an
  // item whose impressions did not fit looks new again and re-qualifies for an
  // opportunity it has already had. PostgREST caps a response at db-max-rows
  // and reports nothing about it, so this is the ordinary case for a busy
  // Trail, not a hypothetical.
  it("a TRUNCATED exposure window is unmeasured — a partial count is not a smaller count", async () => {
    const db = withDb({
      ...SEED(),
      content_trails: [
        member("m-hot", { id: "m-hot", source_id: P_HOT, created_at: iso(60_000) }),
        member("m-cold", {
          id: "m-cold", source_id: P_COLD, contributor_id: CONTRIB_B, created_at: iso(120_000),
        }),
      ],
      rank_events: served(P_HOT, MAX_TRAIL_EXPOSURE_EVENTS),
    });

    const r = await getTrailModules(db as any, T_DARK, { pageSize: 8 });
    const justArrived = r.modules.find((m) => m.key === "just_arrived")!;
    assert.equal(justArrived.explorationSlots, null,
      "a full page means the window was truncated; reserving on truncated counts would hand a slot to an item that already had one");
  });

  it("an exposure read that FAILS reports null slots — never an empty list, which would claim nothing qualified", async () => {
    const db = withDb({
      ...SEED(),
      content_trails: [member("m-cold", { id: "m-cold", source_id: P_COLD })],
    }, [], "postgres", ["rank_events"]);

    const r = await getTrailModules(db as any, T_DARK, { pageSize: 8 });
    const justArrived = r.modules.find((m) => m.key === "just_arrived")!;
    assert.equal(justArrived.explorationSlots, null,
      "a denominator that could not be read is unknown; reporting [] would say `evaluated, nothing qualified`");
    assert.ok(justArrived.items.length > 0,
      "the module still serves — §9 failing to be evaluable is not a reason to serve nothing");
  });

  it("the slots reach a CLIENT — DV-22 is assertable at GET /v1/discovery/trails/:id/modules", async () => {
    withDb({
      ...SEED(),
      content_trails: [member("m-cold", { id: "m-cold", source_id: P_COLD })],
      rank_events: [],
    });
    const r = await call("GET", `/v1/discovery/trails/${T_DARK}/modules`, USER);
    assert.equal(r.status, 200);
    const justArrived = r.body.modules.find((m: any) => m.key === "just_arrived");
    assert.deepEqual(justArrived.explorationSlots, ["m-cold"]);
    // §9: "Do not promise a fixed number of impressions publicly." Ids, not counts.
    assert.ok(!JSON.stringify(r.body).includes("denominator"));
    assert.ok(!JSON.stringify(r.body).includes("impressions"));
  });
});

// ── §11 report_rate over a FAILED read, at the service boundary ─────────────

describe("§11 — a failed trail_reports read is unmeasured health, not a clean Trail", () => {
  it("getTrail reports report_rate null and names it, rather than claiming zero open reports", async () => {
    const db = withDb(SEED(), [], "postgres", ["trail_reports"]);
    const r = await getTrail(db as any, T_DARK);
    assert.equal(r.refusal, null, "a diagnostic read failing must not fail the Trail read");
    assert.equal(r.health!.metrics.report_rate, null,
      "supabase-js RESOLVES on a database error: a discarded error made the outage look like `no reports`");
    assert.ok(r.health!.unmeasured.includes("report_rate"));
  });

  it("a SUCCESSFUL read with no open reports still measures 0 — the two are distinguishable", async () => {
    const db = withDb();
    const r = await getTrail(db as any, T_DARK);
    assert.equal(r.health!.metrics.report_rate, 0);
    assert.ok(!r.health!.unmeasured.includes("report_rate"));
  });

  it("the unreadable case scales DIFFERENTLY from the clean case, so the outage is visible in rank", async () => {
    const seed = (): Record<string, Row[]> => ({
      ...SEED(),
      content_trails: [
        member(M1, { confidence: 0.1 }),
        member(M2, { source_id: PLACE_B, contributor_id: OTHER, confidence: 0.9, created_at: iso(10 * 86_400_000) }),
      ],
    });
    const broken = await getTrail(withDb(seed(), [], "postgres", ["trail_reports"]) as any, T_DARK);
    const clean = await getTrail(withDb(seed()) as any, T_DARK);
    assert.ok(broken.healthScale < clean.healthScale,
      "a clean report_rate is evidence; a failed read has none and must not be scored as if it did");
  });
});
