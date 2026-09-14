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
import { recordTrailHealthSnapshot } from "../services/trails/TrailService.js";
import {
  computeTrailHealth, TRAIL_HEALTH_METRICS, TRAIL_HEALTH_MODEL_VERSION,
} from "../lib/discoveryTrailHealth.js";

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
) {
  const tables: Record<string, Row[]> = {
    profiles: [USER, OTHER].map((id) => ({ id, account_status: "active", role: "user" })),
    trails: [], content_trails: [], trail_edges: [], trail_follows: [],
    trail_reports: [], trail_health_snapshots: [], rank_events: [],
    feature_flags: [],
    ...seed,
  };
  const missing = new Set(missingTables);
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
    const err = () => ({ data: null, error: missingError() });

    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const run = () => (missing.has(table) ? err() : { data: rows(), error: null });
    const one = () => {
      if (missing.has(table)) return Promise.resolve(err());
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
        if (missing.has(table)) {
          const r: any = { data: null, error: missingError() };
          r.select = () => r; r.maybeSingle = () => Promise.resolve(r);
          r.then = (res: any) => Promise.resolve(r).then(res);
          return r;
        }
        writes.push({ table, op: "insert", rows: inserted });
        const stored = inserted.map((x, i) => ({ id: `gen-${table}-${store().length + i}`, ...x }));
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
            if (missing.has(table)) return Promise.resolve(err()).then(res);
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
            if (missing.has(table)) return Promise.resolve(err()).then(res);
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

const SEED = () => ({
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
  seed = SEED(), missing: string[] = [],
  style: "postgres" | "schema-cache" | "message-only" = "postgres",
) => {
  _resetLocalMomentumCacheForTest();
  const db = makeDb(seed, missing, style);
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
