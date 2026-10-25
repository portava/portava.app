/**
 * discoveryTrendCanonicalContext.db.test.ts — census-discovery §133 (DV-28,
 * DV-29, DV-33, DC-06, DC-21): migration 3920 on real PostgreSQL.
 *
 * Every place Discovery serves is a `public.places` row (`db/<places.id>`); the
 * v2 trend context read `discovery_places` only. 3920 adds the canonical
 * producer behind `discovery_trend_canonical_place_context_enabled`, and
 * lib/discoveryTrendCanonicalContext adds the same rows to the in-process
 * context. This suite runs the REAL `loadTrendContext` over a psql adapter and
 * the REAL 3920 functions over the same tables:
 *
 *   C1  context parity: discovery_trend_place_context_canonical() equals
 *       loadTrendContext (flag ON) for every key — a discovery_places row shadows
 *       a canonical row with its uuid, closed and merged places are absent, a cell
 *       label is chosen across both tables, a pending Trail is no membership
 *   C2  every stored canonical v2 place row equals computeTrendStates over the
 *       loader's rows and that context: state, lifecycle, driver, rates, peer
 *       factor, cell, city, versions — and the served places now HAVE a cell
 *   C3  Local Pulse: a cell made only of canonical places is stored and equals
 *       computeAreaTrendStates
 *   C4  the original producer at the same instant still gives the canonical
 *       places no cell (the defect is real here) and is untouched by 3920
 *   C5  the three copies ARE the installed 3988-reviewed originals with exactly
 *       four substitutions (re-proved after 3988, whatever order replayed them)
 *   C6  an active protected zone over a canonical place removes it from the
 *       context and its rows from the canonical windows (3988's filter, kept)
 *   C7  the flag OFF, absent or FALSE: the canonical dispatcher writes exactly what
 *       rebuild_place_momentum writes; ON without the v2 flag: the v1 run
 *   C8  posture: no client role executes any of the five; service_role does
 *   C9  3920 re-applied is a no-op and keeps the flag's value; the rollback
 *       refuses while the flag is TRUE, and with it FALSE removes only 3920's objects
 *
 * Controlled data on the harness only: no production claim. Rows are timed in
 * May 2033 so no other suite's rows can enter a window.
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, scalar, psql, seedUser, deleteUser } from "./localDb.js";
import { pgError } from "./discoverySearchPsqlClient.js";
import { computeTrendStates, explainTrendReading, TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2, TREND_PRIOR_MS } from "../../lib/discoveryTrendState.js";
import { loadTrendContext, type MomentumRow } from "../../lib/discoveryLocalMomentum.js";
import { computeAreaTrendStates, type PlaceTrendContext, type TrendContext } from "../../lib/discoveryTrendNormalised.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG_3920 = resolve(__dir, "../../migrations/3920_discovery_trend_canonical_place_context.sql");
const RB_3920 = resolve(__dir, "../../../../../db/rollback/2026-10-23-3920-discovery-trend-canonical-place-context-rollback.sql");

const P_NOW = "2033-05-15T00:00:00.000Z";
const NOW_MS = Date.parse(P_NOW);
const HOUR = 3_600_000;
const TAG = `c133${randomUUID().slice(0, 6)}`;
const CITY = `${TAG}city`;
const FLAG = "discovery_trend_canonical_place_context_enabled";
const ts = (msAgo: number) => `'${new Date(NOW_MS - msAgo).toISOString()}'::timestamptz`;
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const close = (a: unknown, b: number | null) =>
  b === null ? a === null : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * A PostgREST-shaped read adapter over psql, as service_role: the calls
 * loadTrendContext and isFlagEnabled make (select, eq, neq, in, is, maybeSingle,
 * an awaited builder). Anything else throws, so a new call shape cannot pass unproven.
 */
function psqlClient(): any {
  const lit = (v: unknown) => (v === null ? "NULL" : typeof v === "number" || typeof v === "boolean" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`refusing identifier ${s}`); return s; };
  return {
    from(table: string) {
      ident(table);
      let cols = "*";
      const where: string[] = [];
      const run = async (single: boolean) => {
        const sql = `SELECT ${cols} FROM public.${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
        const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\nSELECT COALESCE(json_agg(t.*), '[]'::json)::text FROM (${sql}) t;`, { single: true });
        if (r.status !== 0) return { data: null, error: pgError(r.stderr) };
        const out = JSON.parse(r.stdout.trim() || "[]") as unknown[];
        return single ? { data: out[0] ?? null, error: null } : { data: out, error: null };
      };
      const b: any = {
        select(c: string) { cols = c.split(",").map((x) => ident(x.trim())).join(", "); return b; },
        eq(c: string, v: unknown) { where.push(`${ident(c)} = ${lit(v)}`); return b; },
        neq(c: string, v: unknown) { where.push(`${ident(c)} <> ${lit(v)}`); return b; },
        in(c: string, vs: unknown[]) { where.push(vs.length ? `${ident(c)} IN (${vs.map(lit).join(", ")})` : "false"); return b; },
        is(c: string, v: null) { if (v !== null) throw new Error("is: only null is modelled"); where.push(`${ident(c)} IS NULL`); return b; },
        maybeSingle() { return run(true); },
        then(f: any, r: any) { return run(false).then(f, r); },
      };
      return b;
    },
    rpc() { throw new Error("rpc is not modelled"); },
  };
}

const users: string[] = [];
const P: Record<string, string> = {};                 // label → uuid
const trailOk = randomUUID(), trailPending = randomUUID();
const item = (label: string) => `db/${P[label]}`;
const SERVED = ["A1", "A2", "A3", "A4", "T", "S", "D1", "B1", "B2", "B3", "B4"];   // labels whose rows are served
const ITEMS = () => SERVED.map(item);

type Ev = { u: number; p: string; o: string; sH: number; oH?: number | null };
const EV: Ev[] = [];
const imps = (p: string, n: number, fromH: number, stepH = 0.5, u0 = 0) => {
  for (let i = 0; i < n; i++) EV.push({ u: (u0 + i) % 40, p, o: "impression", sH: fromH + i * stepH });
};
const acts = (p: string, o: string, us: number[], atH: number, gapH = 0.25) => {
  us.forEach((u, k) => { const at = atH + k * gapH; EV.push({ u, p, o, sH: at + 0.1, oH: at }); });
};
const U = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

const setFlag = (flag: string, on: boolean) => exec(`UPDATE public.feature_flags SET enabled = ${on} WHERE flag = '${flag}';`);
const loaderRows = () => rows<MomentumRow>(
  `SELECT item_id, outcome, served_at, outcome_at, user_id FROM public.rank_events
    WHERE surface = 'discovery' AND outcome <> 'analytics' AND user_id IN (${inList(users)})
      AND served_at >= '${new Date(NOW_MS - TREND_PRIOR_MS).toISOString()}'::timestamptz`);
const stored = (at: string) => rows<Record<string, any>>(
  `SELECT * FROM public.place_momentum WHERE computed_at = '${at}'::timestamptz AND place_id IN (${inList(ITEMS())}) ORDER BY place_id`);
const defOf = (sig: string) => rows<{ d: string }>(`SELECT pg_get_functiondef('${sig}'::regprocedure) AS d`)[0]!.d;
const md5Of = (sig: string) => scalar(`SELECT md5(pg_get_functiondef('${sig}'::regprocedure))`);
const NEW_FNS = [
  "public.discovery_trend_place_context_canonical()", "public.discovery_trend_windows_v2_canonical(timestamptz,text)",
  "public.discovery_trend_post_groups_v2_canonical(timestamptz)", "public.rebuild_place_momentum_v2_canonical(timestamptz)",
  "public.rebuild_place_momentum_canonical(timestamptz)",
];
const ORIGINALS = [
  "public.discovery_trend_place_context()", "public.discovery_trend_windows_v2(timestamptz,text)",
  "public.discovery_trend_post_groups_v2(timestamptz)", "public.rebuild_place_momentum(timestamptz)", "public.rebuild_place_momentum_v2(timestamptz)",
];
/** A snapshot of one instant's stored rows, taken inside a transaction that is rolled back. */
function snapshotOf(call: string, at: string, setup = ""): Array<Record<string, unknown>> {
  const snap = `SELECT 'SNAP' || COALESCE(json_agg(to_jsonb(p) - 'id' - 'created_at' ORDER BY p.place_id), '[]'::json)::text FROM public.place_momentum p
                 WHERE computed_at = '${at}'::timestamptz AND place_id IN (${inList(ITEMS())});`;
  const out = exec(`BEGIN;\n${setup}\nSELECT ${call}('${at}'::timestamptz);\n${snap}\nROLLBACK;`).filter((l) => l.startsWith("SNAP"));
  assert.equal(out.length, 1);
  return JSON.parse(out[0]!.slice(4)) as Array<Record<string, unknown>>;
}

describe("census-discovery §133 — 3920: the v2 trend producer keys the places Discovery serves", { skip: !HAVE_DB }, () => {
  let ctx: TrendContext = {};

  before(async () => {
    for (let i = 0; i < 40; i++) users.push(seedUser(`${TAG}u${i}`));
    for (const l of ["A1", "A2", "A3", "A4", "T", "S", "D1", "X", "M", "B1", "B2", "B3", "B4"]) P[l] = randomUUID();
    const C = users[39]!;
    // Canonical places (public.places): A1–A4 one named neighbourhood (spellings vary), T a temple
    // on coordinates, X closed, M merged into A1, B1–B4 a grid cell, S shadowed by a discovery_places row.
    const canon: Array<[string, string | null, number | null, number | null, string, string, string | null]> = [
      ["A1", "Riverside", null, null, "cafe", "active", null], ["A2", "riverside", null, null, "cafe", "active", null],
      ["A3", "Riverside ", null, null, "cafe", "active", null], ["A4", "Riverside", null, null, "cafe", "active", null],
      ["T", null, -70.111, 160.111, "temple", "active", null],
      ["X", "Riverside", null, null, "cafe", "closed", null], ["M", "Riverside", null, null, "cafe", "active", "A1"],
      ["B1", null, -70.5011, 160.5011, "bar", "active", null], ["B2", null, -70.5031, 160.5031, "bar", "active", null],
      ["B3", null, -70.5051, 160.5051, "bar", "active", null], ["B4", null, -70.5071, 160.5071, "bar", "active", null],
      ["S", null, -70.9, 160.9, "temple", "active", null],
    ];
    exec(`INSERT INTO public.places (id, name, normalized_name, primary_category, city, neighborhood, latitude, longitude, status, created_at) VALUES
      ${canon.map(([l, hood, lat, lng, cat, status]) => `('${P[l]}', '${TAG} ${l}', '${TAG.toLowerCase()} ${l.toLowerCase()}', '${cat}', '${CITY}',
        ${hood === null ? "NULL" : `'${hood}'`}, ${lat ?? "NULL"}, ${lng ?? "NULL"}, '${status}', ${ts(2000 * HOUR)})`).join(",\n")};
      UPDATE public.places SET merged_into_place_id = '${P["A1"]}' WHERE id = '${P["M"]}';`);
    // discovery_places: S (the same uuid as a canonical row: it wins, creator and all) and D1, in A's neighbourhood.
    exec(`INSERT INTO public.discovery_places (id, city, name, place_type, category, neighborhood, submitted_by, lat, lng, created_at) VALUES
      ('${P["S"]}', '${CITY}', '${TAG} S', 'venue', 'bar', NULL, '${C}', -70.9, 160.9, ${ts(2000 * HOUR)}),
      ('${P["D1"]}', '${CITY}', '${TAG} D1', 'venue', 'cafe', 'riverside', NULL, NULL, NULL, ${ts(2000 * HOUR)});`);
    // Trails: an approved one over A1 and A2, a pending one over T (D-66: no membership while under review).
    exec(`INSERT INTO public.trails (id, slug, title, review_state) VALUES ('${trailOk}', '${TAG}-ok', '${TAG} ok', 'approved'), ('${trailPending}', '${TAG}-pending', '${TAG} pending', 'pending');
          INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, confidence, content_state) VALUES
          ('${trailOk}', 'place', '${P["A1"]}', 'primary', 0.9, 'just_arrived'), ('${trailOk}', 'place', '${P["A2"]}', 'primary', 0.9, 'just_arrived'),
          ('${trailPending}', 'place', '${P["T"]}', 'primary', 0.9, 'just_arrived');`);

    // A1–A4 rising together (the neighbourhood's surge is their peer baseline); A1 more.
    for (const a of ["A1", "A2", "A3", "A4", "D1"]) {
      imps(a, 40, 1); acts(a, "save", U(0, a === "A1" ? 10 : 5), 2, 0.3);
      imps(a, 40, 50, 2); acts(a, "tap", U(20, 23), 55, 2);
    }
    // T an enduring place, sustained over all three windows → evergreen.
    imps("T", 40, 1); acts("T", "tap", U(0, 4), 4); imps("T", 100, 50, 1.1); acts("T", "tap", U(4, 14), 60, 3);
    imps("T", 60, 200, 3); acts("T", "tap", U(14, 20), 250, 5);
    // S emerging: recent only.
    imps("S", 40, 1); acts("S", "tap", U(0, 4), 3);
    // B1–B4 one grid cell, all rising.
    for (const b of ["B1", "B2", "B3", "B4"]) {
      imps(b, 40, 1); acts(b, "save", U(0, 5), 2, 0.3);
      imps(b, 40, 50, 2); acts(b, "tap", U(20, 23), 55, 2);
    }
    const values = EV.map((e) =>
      `('${users[e.u]}', '${item(e.p)}', 'discovery', '${e.o}', ${ts(e.sH * HOUR)}, ${e.oH == null ? "NULL" : ts(e.oH * HOUR)})`);
    for (let i = 0; i < values.length; i += 500) {
      exec(`INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, outcome_at) VALUES ${values.slice(i, i + 500).join(",\n")};`);
    }
    setFlag("discovery_trend_normalised_enabled", true);
    setFlag(FLAG, true);
    const c = await loadTrendContext(psqlClient(), Object.keys(P).map(item));   // every label a candidate, closed and merged ones too
    assert.ok(c, "the context read succeeded");
    ctx = c!;
    exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_place_momentum_canonical('${P_NOW}'::timestamptz);`, { single: true });
  });

  after(() => {
    setFlag(FLAG, false);
    setFlag("discovery_trend_normalised_enabled", false);
    exec(`DELETE FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz;
          DELETE FROM public.area_momentum WHERE computed_at = '${P_NOW}'::timestamptz;
          DELETE FROM public.content_trails WHERE trail_id IN ('${trailOk}', '${trailPending}');
          DELETE FROM public.trails WHERE id IN ('${trailOk}', '${trailPending}');
          DELETE FROM public.discovery_places WHERE city = '${CITY}';
          DELETE FROM public.places WHERE city = '${CITY}';`);
    for (const u of users) deleteUser(u);   // cascades their rank_events
  });

  it("C1. context parity: the SQL canonical context equals loadTrendContext, key for key", () => {
    const keys = Object.values(P);
    const sql = rows<Record<string, any>>(`SELECT * FROM public.discovery_trend_place_context_canonical() WHERE place_key IN (${inList(keys)}) ORDER BY place_key`);
    assert.deepEqual(sql.map((s) => s.place_key).sort(), Object.keys(ctx).filter((k) => keys.includes(k)).sort(), "the same places, no more, no fewer");
    for (const s of sql) {
      const t = ctx[s.place_key] as PlaceTrendContext;
      assert.deepEqual(
        { creator: s.creator_id, cell: s.cell_key, label: s.cell_label, city: s.city, created: Date.parse(s.created_at), cls: s.content_class, trails: s.trail_ids },
        { creator: t.creatorId, cell: t.cellKey, label: t.cellLabel, city: t.city, created: t.createdAtMs, cls: t.contentClass, trails: [...t.trailIds] },
        s.place_key);
    }
    const k = (l: string) => ctx[P[l]!.toLowerCase()];
    assert.equal(k("X"), undefined, "a closed place has no context");
    assert.equal(k("M"), undefined, "a merged place has no context");
    assert.equal(k("A2")!.cellKey, `n:${CITY}:riverside`, "a canonical neighbourhood is a cell");
    assert.equal(k("D1")!.cellKey, `n:${CITY}:riverside`, "and the same cell as a discovery_places row in it");
    assert.equal(k("A3")!.cellLabel, "Riverside", "the label is the byte-least spelling across both tables");
    assert.equal(k("D1")!.cellLabel, "Riverside");
    assert.equal(k("A1")!.creatorId, null, "a canonical place has no submitter: no creator, never a guess");
    assert.equal(k("S")!.creatorId, users[39]!.toLowerCase(), "a discovery_places row shadows the canonical row with its uuid");
    assert.equal(k("S")!.contentClass, "standard", "…its category (bar), not the canonical row's (temple)");
    assert.equal(k("T")!.contentClass, "enduring");
    assert.ok(k("T")!.cellKey?.startsWith("g:"), "a canonical place on coordinates is a grid cell");
    assert.deepEqual([...k("A1")!.trailIds], [trailOk.toLowerCase()]);
    assert.deepEqual([...k("T")!.trailIds], [], "D-66: a Trail under review is no membership");
  });

  it("C2. every stored canonical v2 row equals computeTrendStates over the loader's rows and that context", () => {
    const t = computeTrendStates(loaderRows(), NOW_MS, { model: "v2", context: ctx });
    const sql = stored(P_NOW);
    assert.deepEqual(sql.map((r) => r.place_id).sort(), Object.keys(t).sort(), "the same places, no more, no fewer");
    for (const r of sql) {
      const x = t[r.place_id]!;
      const e = x.evidence as unknown as Record<string, number | null>;
      const where = `${r.place_id}`;
      assert.equal(r.trend_state, x.state, `${where} state`);
      assert.equal(r.lifecycle_state, x.lifecycle, `${where} lifecycle`);
      assert.equal(r.driver, x.driver, `${where} driver`);
      for (const [col, key] of [["recent_rate", "recentRate"], ["mid_rate", "midRate"], ["prior_rate", "priorRate"], ["total_weight", "totalWeight"],
        ["time_of_day_factor", "timeOfDayFactor"], ["peer_factor", "peerFactor"], ["velocity", "velocity"]] as const) {
        assert.ok(close(r[col], e[key] ?? null), `${where} ${col}: SQL ${r[col]} vs TS ${e[key]}`);
      }
      for (const [col, key] of [["recent_exposures", "recentExposures"], ["mid_exposures", "midExposures"], ["prior_exposures", "priorExposures"],
        ["recent_groups", "recentGroups"], ["mid_groups", "midGroups"], ["prior_groups", "priorGroups"]] as const) {
        assert.equal(r[col], e[key], `${where} ${col}`);
      }
      const c = ctx[r.place_id.replace(/^db\//, "").toLowerCase()];
      assert.equal(r.cell_key, c?.cellKey ?? null, `${where} cell`);
      assert.equal(r.city, c?.city ?? null, `${where} city`);
      assert.equal(r.reason, explainTrendReading(x.state, x.driver ?? null), `${where} sentence`);
      assert.equal(r.model_version, TREND_STATE_MODEL_VERSION_V2);
      assert.equal(r.feature_version, TREND_FEATURE_VERSION_V2, "the per-row contribution is unchanged: no new feature version");
      assert.equal(r.feature_version, x.provenance.featureVersion);
    }
    const s = Object.fromEntries(sql.map((r) => [r.place_id, r]));
    for (const l of ["A1", "A2", "A3", "A4", "T", "B1"]) assert.ok(s[item(l)].cell_key !== null && s[item(l)].city === CITY, `${l}: a served place has a cell and a city`);
    assert.equal(s[item("T")].lifecycle_state, "evergreen", "03 §4: an enduring canonical place sustained over all three windows");
    assert.ok(Number(s[item("A2")].peer_factor) > 1.5, "the neighbourhood's shared surge is A2's peer baseline");
    assert.equal(s[item("A2")].trend_state, "established", "A2 rose exactly as its neighbourhood did: divided out");
    assert.equal(s[item("A1")].trend_state, "trending", "A1 rose more than its neighbourhood");
  });

  it("C3. Local Pulse: a cell made only of canonical places is stored and equals computeAreaTrendStates", () => {
    const t = computeAreaTrendStates(loaderRows(), NOW_MS, ctx);
    const cells = [...new Set(SERVED.map((l) => ctx[P[l]!.toLowerCase()]?.cellKey).filter((c): c is string => typeof c === "string"))];
    const sql = rows<Record<string, any>>(`SELECT * FROM public.area_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND cell_key IN (${inList(cells)})`);
    assert.deepEqual(sql.map((r) => r.cell_key).sort(), Object.keys(t).filter((k) => cells.includes(k)).sort());
    for (const r of sql) {
      const x = t[r.cell_key]!;
      assert.equal(r.trend_state, x.state, `${r.cell_key} state`);
      assert.equal(r.driver, x.driver, `${r.cell_key} driver`);
      assert.ok(close(r.velocity, x.evidence.velocity), `${r.cell_key} velocity ${r.velocity} vs ${x.evidence.velocity}`);
      assert.equal(r.recent_groups, x.evidence.recentGroups);
    }
    const grid = ctx[P["B1"]!.toLowerCase()]!.cellKey!;
    const b = sql.find((r) => r.cell_key === grid);
    assert.ok(b, "the canonical-only grid cell has a Local Pulse row");
    assert.equal(b.trend_state, "trending", "B1–B4 all rising: the cell is rising");
    assert.equal(sql.find((r) => r.cell_key === `n:${CITY}:riverside`)?.cell_label, "Riverside");
  });

  it("C4. the original producer at the same instant gives the served places no cell — 3920 left it as it was", () => {
    const at = new Date(NOW_MS + 1_000).toISOString();
    const orig = snapshotOf("public.rebuild_place_momentum", at);
    assert.ok(orig.length >= SERVED.length, "not vacuous: the corpus is stored");
    const by = Object.fromEntries(orig.map((r) => [String(r["place_id"]), r]));
    for (const l of ["A1", "A2", "T", "B1"]) {
      assert.equal(by[item(l)]!["cell_key"], null, `${l}: discovery_places-only context`);
      assert.equal(by[item(l)]!["peer_factor"], 1, `${l}: no peer baseline without context`);
    }
    assert.equal(by[item("D1")]!["cell_key"], `n:${CITY}:riverside`, "a discovery_places row still has its cell");
  });

  it("C5. each copy is its installed, 3988-reviewed original with exactly four substitutions", () => {
    const subst = (s: string) => s
      .replaceAll("public.discovery_trend_place_context()", "public.discovery_trend_place_context_canonical()")
      .replaceAll("public.discovery_trend_windows_v2(", "public.discovery_trend_windows_v2_canonical(")
      .replaceAll("public.discovery_trend_post_groups_v2(", "public.discovery_trend_post_groups_v2_canonical(")
      .replaceAll("public.rebuild_place_momentum_v2(", "public.rebuild_place_momentum_v2_canonical(");
    const REVIEWED: Record<string, string> = {   // 3988's "after" hashes
      "public.discovery_trend_windows_v2(timestamptz,text)": "8967523ccd3435c626d25ca95a3ea406b16c5be898ab5ea8bfca66f9b469b9f5",
      "public.discovery_trend_post_groups_v2(timestamptz)": "93859dcf6650f82b15de316602fe13d8af34e764e8decffbb460d153047277a6",
      "public.rebuild_place_momentum_v2(timestamptz)": "9bc554e497cbc8c37aedd3fa227a3e41261ee80bc78848970798e22ac51cc7cf",
    };
    for (const [orig, hash] of Object.entries(REVIEWED)) {
      assert.equal(scalar(`SELECT encode(sha256(convert_to(pg_get_functiondef('${orig}'::regprocedure), 'UTF8')), 'hex')`), hash, `${orig} is at 3988's reviewed definition`);
      const copy = orig.replace(/\(/, "_canonical(");
      assert.equal(defOf(copy), subst(defOf(orig)), `${copy} drifted from ${orig}`);
    }
  });

  it("C6. an active protected zone over a canonical place: no context, and its rows do not count", () => {
    const zone = randomUUID();
    const setup = `INSERT INTO public.protected_zones (id, category, shape, center_lat, center_lng, radius_meters, policy_ref)
                   VALUES ('${zone}', 'shelter', 'circle', -70.111, 160.111, 200, 'c133-test');`;
    const n = (l: string) => `count(*) FILTER (WHERE place_key = '${P[l]!.toLowerCase()}')`;
    const out = exec(`BEGIN;\n${setup}\nSELECT 'CTX' || ${n("T")} || ':' || ${n("A1")} || ':' || ${n("B1")} FROM public.discovery_trend_place_context_canonical();\nROLLBACK;`)
      .filter((l) => l.startsWith("CTX"));
    assert.deepEqual(out, ["CTX0:0:1"], "T (inside the zone) is gone; A1 (a neighbourhood, no position) cannot be proven clear, so it fails closed; B1, 44 km away, stays");
    const at = new Date(NOW_MS + 2_000).toISOString();
    const snap = snapshotOf("public.rebuild_place_momentum_canonical", at, setup);
    const ids = snap.map((r) => String(r["place_id"]));
    assert.ok(!ids.includes(item("T")), "the canonical windows drop the protected place's rows");
    assert.ok(ids.includes(item("B1")), "a place proven clear of the zone still counts");
  });

  it("C7. the flag OFF: the canonical dispatcher writes exactly rebuild_place_momentum's run; ON without v2: the v1 run", () => {
    const at = new Date(NOW_MS + 3_000).toISOString();
    for (const setup of [`UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`, `DELETE FROM public.feature_flags WHERE flag = '${FLAG}';`]) {
      const canonical = snapshotOf("public.rebuild_place_momentum_canonical", at, setup);
      const original = snapshotOf("public.rebuild_place_momentum", at, setup);
      assert.ok(canonical.length >= SERVED.length);
      assert.deepEqual(canonical, original, `${setup}: the dispatcher moved a value`);
    }
    const v1 = snapshotOf("public.rebuild_place_momentum_canonical", at, `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_trend_normalised_enabled';`);
    assert.ok(v1.length > 0 && v1.every((r) => r["model_version"] === "discovery-trend-state-v1" && r["cell_key"] === null), "v1 reads no place context");
  });

  it("C8. posture: no client role executes any of the five; service_role does", () => {
    for (const f of NEW_FNS) {
      assert.equal(scalar(`SELECT has_function_privilege('anon', '${f}', 'EXECUTE')`), "f", `anon ${f}`);
      assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${f}', 'EXECUTE')`), "f", `authenticated ${f}`);
      assert.equal(scalar(`SELECT has_function_privilege('service_role', '${f}', 'EXECUTE')`), "t", `service_role ${f}`);
    }
  });

  it("C9. re-applied, 3920 is a no-op that keeps the flag's value; the rollback refuses while it is TRUE and touches only 3920", () => {
    const before = NEW_FNS.map(md5Of);
    const originals = ORIGINALS.map(md5Of);
    const r = psql(readFileSync(MIG_3920, "utf8"));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(NEW_FNS.map(md5Of), before, "the same five definitions");
    assert.equal(scalar(`SELECT enabled FROM public.feature_flags WHERE flag = '${FLAG}'`), "t", "ON CONFLICT DO NOTHING: an operator's TRUE survives a re-apply");
    const rb = readFileSync(RB_3920, "utf8");
    const refused = psql(rb);
    assert.notEqual(refused.status, 0, "the rollback must refuse while the flag is TRUE");
    assert.match(refused.stderr, /ROLLBACK REFUSED \(3920\)/);
    assert.deepEqual(NEW_FNS.map(md5Of), before, "a refused rollback changed nothing");
    // With it FALSE, inside a transaction that is rolled back: only 3920's objects go.
    const body = rb.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
    const out = exec(`BEGIN;\nUPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';\n${body}\n` +
      `SELECT 'LEFT' || count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%\\_canonical' AND (proname LIKE 'discovery_trend_%' OR proname LIKE 'rebuild_place_momentum%');\n` +
      `SELECT 'ORIG' || string_agg(md5(pg_get_functiondef(f::regprocedure)), ',' ORDER BY f) FROM unnest(ARRAY[${inList(ORIGINALS)}]) f;\nROLLBACK;`);
    assert.ok(out.includes("LEFT0"), out.join("|"));
    const orig = out.find((l) => l.startsWith("ORIG"))!.slice(4).split(",");
    assert.deepEqual(orig.sort(), [...originals].sort(), "the rollback must not touch the originals");
    assert.deepEqual(NEW_FNS.map(md5Of), before, "rolled back: all five still installed");
  });
});
